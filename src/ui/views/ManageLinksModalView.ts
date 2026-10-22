import { Modal, Notice, type App } from 'obsidian';
import ManageLinksComponent from '../components/ManageLinks.svelte';
import type { ApiClient } from '../../api/client';
import type { Contact } from '../../types';
import type { EnableLiveE2EResult } from '../../live/enable';
import { encryptKeyForRecipient } from '../../crypto/keyExchange';
import { DirectoryKeyChangedError } from '../../crypto/identityTrust';
import { isRetiredLink, newestActiveAnonymousLink } from '../../share/shareNote';
import { rememberEncrypted } from '../../session/sessions';
import { noteColabFrontmatter, type NoteColabFrontmatter } from '../../share/frontmatter';
import { shareIdFromLink } from '../../share/shareLink';
import type { ShareLinkInfo } from '../../api/client';
import { copyToClipboard } from '../clipboard';

type AccessMode = 'public_edit' | 'invited_edit' | 'read_only';
/** Resolves the component's pending request so it can keep or clear its form. */
type Done = { done?: (ok: boolean) => void };

/** The owner's switch to encrypted live editing (docs/LIVE-E2E-ENCRYPTION.md §6.2). */
export interface LiveEncryptionOptions {
  uid: string;
  enable(): Promise<EnableLiveE2EResult>;
}

const LIVE_ENABLE_FAILURES: Record<Extract<EnableLiveE2EResult, { status: 'failed' }>['reason'], string> = {
  offline: 'Couldn’t encrypt live editing: the note isn’t synced yet. Check your connection and try again.',
  uncertain: 'Couldn’t confirm whether live editing was encrypted. Check your connection, then reopen Manage shared links.',
  damaged: 'Couldn’t encrypt live editing: the note’s saved collaboration history can’t be decrypted.',
  'room-busy': 'Couldn’t encrypt live editing: the note is being edited live. Open it in Obsidian so NoteColab can sync it, then try again.',
  'room-token': 'Couldn’t encrypt live editing: open the note in Obsidian once so NoteColab can set up its live room, then try again.',
  quota: 'Couldn’t encrypt live editing: the note is too large or your storage is full.',
  forbidden: 'Only this note’s owner can encrypt live editing.',
  conflict: 'Couldn’t encrypt live editing because the note kept changing. Try again.',
};

export class ManageLinksModalView extends Modal {
  private component: InstanceType<typeof ManageLinksComponent> | null = null;
  private api: ApiClient;
  private noteShareId: string;
  private encryptionKey: string;
  private serverUrl: string;
  private contacts: Contact[];
  private secretKey: string;
  private onOriginalReplaced: (shareId: string, url: string) => Promise<void>;
  private live: LiveEncryptionOptions | undefined;

  private async trustedPublicKey(uid: string): Promise<string | null | undefined> {
    try {
      return (await this.api.getPublicKey(uid))?.publicKey || null;
    } catch (error) {
      if (error instanceof DirectoryKeyChangedError) {
        console.error(error.message);
        new Notice(`${error.message}. Verify it with the recipient, then reset its pin in Note Colab settings.`, 15_000);
        return undefined;
      }
      throw error;
    }
  }

  constructor(
    app: App,
    api: ApiClient,
    noteShareId: string,
    encryptionKey: string,
    serverUrl: string,
    contacts: Contact[],
    secretKey: string,
    onOriginalReplaced: (shareId: string, url: string) => Promise<void>,
    live?: LiveEncryptionOptions,
  ) {
    super(app);
    this.onOriginalReplaced = onOriginalReplaced;
    this.live = live;
    this.api = api;
    this.noteShareId = noteShareId;
    this.encryptionKey = encryptionKey;
    this.serverUrl = serverUrl;
    this.contacts = contacts;
    this.secretKey = secretKey;
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    contentEl.addClass('notecolab-manage-links-modal');

    modalEl.setCssStyles({ width: '550px', maxWidth: '90vw' });

    const component = new ManageLinksComponent({
      target: contentEl,
      props: {
        links: [],
        collaborators: [],
        contacts: this.contacts,
        serverUrl: this.serverUrl,
        encryptionKey: this.encryptionKey,
        loading: true,
        loaded: false,
        loadError: '',
      },
    });
    this.component = component;

    const on = <T>(name: string, handler: (detail: T) => Promise<boolean>) => {
      component.$on(name, (e: CustomEvent<T & Done>) => {
        void handler(e.detail)
          .catch((error: unknown) => {
            console.error(`NoteColab: ${name} failed`, error);
            new Notice('Something went wrong. Check your connection and try again.');
            return false;
          })
          .then((ok) => e.detail.done?.(ok));
      });
    };

    component.$on('retry', () => { void this.loadData(); });

    on<{ url: string }>('copy-link', ({ url }) => copyToClipboard(this.app, url, 'Link copied to clipboard'));

    on<{ accessMode: string; expiresIn?: number; label: string }>('create-link', async ({ accessMode, expiresIn, label }) => {
      const result = await this.api.createLink(this.noteShareId, { accessMode, expiresIn, label });
      if (!result) {
        new Notice('Couldn’t create the link. Check your connection and try again.');
        return false;
      }
      new Notice('Link created');
      await this.loadData();
      return true;
    });

    on<Record<string, never>>('replace-original', () => this.replaceOriginal());

    on<{ linkShareId: string; accessMode?: string; expiresIn?: number | null; label: string }>('update-link', async ({ linkShareId, accessMode, expiresIn, label }) => {
      if (!await this.api.updateLink(linkShareId, { accessMode, expiresIn, label })) {
        new Notice('Couldn’t update the link. Check your connection and try again.');
        return false;
      }
      new Notice('Link updated');
      await this.loadData();
      return true;
    });

    on<{ linkShareId: string; replaceOriginal?: boolean }>('delete-link', async ({ linkShareId, replaceOriginal }) => {
      if (!await this.api.deleteLink(linkShareId)) {
        new Notice('Couldn’t delete the link. A note needs at least one link; otherwise check your connection and try again.');
        return false;
      }
      new Notice('Link deleted');
      const loaded = await this.loadData();
      if (loaded) await this.replaceStoredLink(linkShareId, loaded.links);
      if (replaceOriginal) await this.replaceOriginal();
      return true;
    });

    on<{ uid: string; linkShareId: string; accessMode: AccessMode }>('send-to-obsidian', async ({ uid, linkShareId, accessMode }) => {
      const encrypted = await this.encryptKeyFor(uid);
      if (!encrypted) return false;

      if (accessMode === 'invited_edit') {
        const granted = await this.api.addCollaborator(this.noteShareId, uid, true);
        if (!granted) {
          new Notice('Couldn’t grant invited access. Check your connection and try again.');
          return false;
        }
      }
      const delivered = await this.api.createPendingShares(linkShareId, [{ recipientUid: uid, ...encrypted }]);
      new Notice(delivered
        ? 'Delivered to the recipient’s Note Colab plugin'
        : 'Couldn’t deliver to their Obsidian. Check your connection and try again.');
      if (delivered && accessMode === 'invited_edit') await this.loadData();
      return delivered;
    });

    on<{ uid: string }>('add-collaborator', async ({ uid }) => {
      const encrypted = await this.encryptKeyFor(uid);
      if (!encrypted) return false;

      if (!await this.api.addCollaborator(this.noteShareId, uid, true)) {
        new Notice('Couldn’t add the collaborator. Check your connection and try again.');
        return false;
      }
      // Send the encrypted note key via a pending share.
      const delivered = await this.api.createPendingShares(this.noteShareId, [{ recipientUid: uid, ...encrypted }]);
      new Notice(delivered
        ? 'Collaborator added'
        : 'Access granted, but delivery to their Obsidian failed. Use Resend to try again.');
      await this.loadData();
      return true;
    });

    on<{ uid: string; replaceOriginal?: boolean }>('remove-collaborator', async ({ uid, replaceOriginal }) => {
      if (!await this.api.removeCollaborator(this.noteShareId, uid)) {
        new Notice('Couldn’t remove the collaborator. Check your connection and try again.');
        return false;
      }
      new Notice('Collaborator removed');
      if (replaceOriginal) await this.replaceOriginal();
      else await this.loadData();
      return true;
    });

    on<{ uid: string }>('resend-collaborator', async ({ uid }) => {
      const encrypted = await this.encryptKeyFor(uid);
      if (!encrypted) return false;
      const sent = await this.api.createPendingShares(this.noteShareId, [{ recipientUid: uid, ...encrypted }]);
      new Notice(sent ? 'Invitation sent again' : 'Couldn’t resend the invitation. Check your connection and try again.');
      return sent;
    });

    on<{ linkShareId?: string }>('create-invite-link', async ({ linkShareId }) => {
      const result = await this.api.createInviteLink(linkShareId || this.noteShareId);
      if (!result?.token) {
        new Notice('Couldn’t create an invite link. Check your connection and try again.');
        return false;
      }
      const inviteUrl = `${this.serverUrl}/invite/${result.token}#${this.encryptionKey}`;
      await copyToClipboard(this.app, inviteUrl, 'Invite link copied to clipboard. Share it with anyone you want to invite.');
      return true;
    });

    on<Record<string, never>>('enable-live-e2e', async () => {
      if (!this.live) return false;
      const result = await this.live.enable();
      new Notice(result.status === 'enabled'
        ? 'Live editing of this note is now encrypted.'
        : result.status === 'already-e2e'
          ? 'Live editing of this note was already encrypted.'
          : LIVE_ENABLE_FAILURES[result.reason], result.status === 'failed' ? 10_000 : undefined);
      await this.loadLiveEncryption();
      return result.status !== 'failed';
    });

    await Promise.all([this.loadData(), this.loadLiveEncryption()]);
  }

  /** Offered only to the owner, on servers that support it. */
  private async loadLiveEncryption(): Promise<void> {
    if (!this.live) return;
    const [info, note] = await Promise.all([this.api.getServerInfo(), this.api.getNoteContent(this.noteShareId)]);
    if (!note || note.ownerUid !== this.live.uid) return;
    // The owner's notes live on the configured server.
    await rememberEncrypted('', this.encryptionKey, this.noteShareId, note);
    if (!info?.liveE2E) return;
    this.component?.$set({
      liveEncryption: { enabled: note.liveMode === 'e2e' },
    });
  }

  /**
   * Retire the Original link for anonymous use and copy its replacement. Only
   * reached after the owner explicitly opted in.
   */
  private async replaceOriginal(): Promise<boolean> {
    const result = await this.api.replaceOriginalLink(this.noteShareId);
    const refreshed = await this.loadData();
    if (!result) {
      // Describe the server's actual state: the request may have succeeded
      // even though its response was lost.
      const original = refreshed?.links.find((link) => link.shareId === refreshed.noteShareId);
      new Notice(!original
        ? 'Couldn’t confirm whether the original link was replaced. Check your connection, then reopen Manage shared links.'
        : isRetiredLink(original)
          ? 'The original link was replaced. Copy the new link from the list and share it with everyone who should keep access.'
          : 'Couldn’t replace the original link, so it still works. Check your connection and try again.', 10_000);
      return false;
    }
    const url = `${this.serverUrl}/s/${result.shareId}#${this.encryptionKey}`;
    await this.onOriginalReplaced(result.shareId, url);
    await copyToClipboard(
      this.app,
      url,
      'Original link replaced. The new link was copied; share it with everyone who should keep access.',
    );
    return true;
  }

  /** Encrypt the note key for a recipient, explaining any failure. */
  private async encryptKeyFor(uid: string): Promise<{ encryptedKey: string; nonce: string } | null> {
    const publicKey = await this.trustedPublicKey(uid);
    if (publicKey === undefined) return null;
    if (!publicKey) {
      new Notice(`Skipped ${uid}: no public key - ask them to enable Note Colab first`);
      return null;
    }
    try {
      return encryptKeyForRecipient(this.encryptionKey, publicKey, this.secretKey);
    } catch (err) {
      console.warn(`Failed to encrypt key for recipient ${uid}:`, err);
      new Notice(`Skipped ${uid}: no public key - ask them to enable Note Colab first`);
      return null;
    }
  }

  onClose(): void {
    this.component?.$destroy();
    this.component = null;
  }

  // A deleted link stops working, so Copy must hand out a surviving one instead.
  private async replaceStoredLink(deletedShareId: string, links: ShareLinkInfo[]): Promise<void> {
    const survivor = newestActiveAnonymousLink(links);
    const file = this.app.vault.getMarkdownFiles().find((f) =>
      noteColabFrontmatter(this.app.metadataCache.getFileCache(f)?.frontmatter)?.colab_share_id === this.noteShareId);
    if (!survivor || !file) return;
    await this.app.fileManager.processFrontMatter(file, (fm: NoteColabFrontmatter) => {
      if (fm.colab_link && shareIdFromLink(fm.colab_link) === deletedShareId) {
        fm.colab_link = fm.colab_link.replace(`/s/${deletedShareId}`, `/s/${survivor.shareId}`);
        if (fm.colab_link_id) fm.colab_link_id = survivor.shareId;
        fm.colab_access = survivor.accessMode as 'public_edit' | 'read_only';
        if (survivor.expiresAt) fm.colab_expires = survivor.expiresAt;
        else delete fm.colab_expires;
      }
    });
  }

  /** Refreshes the modal and returns the loaded links, or null when loading failed. */
  private async loadData() {
    const [result, collaborators] = await Promise.all([
      this.api.listLinks(this.noteShareId),
      this.api.listCollaborators(this.noteShareId),
    ]);

    // Keep what is already shown: a failed request is not an empty list.
    if (!result || result === 'forbidden' || !collaborators) {
      this.component?.$set({
        loading: false,
        loadError: result === 'forbidden'
          ? 'Only this note’s owner can manage its links.'
          : 'Couldn’t load this note’s links. Check your connection and try again.',
      });
      return null;
    }
    this.component?.$set({
      loading: false,
      loaded: true,
      loadError: '',
      links: result.links.map((link) => ({
        ...link,
        original: link.shareId === result.noteShareId,
        retired: isRetiredLink(link),
      })),
      collaborators,
    });
    return result;
  }
}

import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import Dashboard from '../components/Dashboard.svelte';
import type ColabPlugin from '../../main';
import { decrypt, encrypt } from '../../crypto/crypto';
import { decryptKeyFromSender } from '../../crypto/keyExchange';
import { DirectoryKeyChangedError } from '../../crypto/identityTrust';
import { stopShareSync } from '../../session/sessions';
import { noteColabFrontmatter } from '../../share/frontmatter';
import { isRecipientImport, recipientNoteTitle } from '../../share/readOnlyMirror';
import { DeleteSharedNoteModal } from '../DeleteSharedNoteModal';

/** Resolves the component's pending request so it can keep or clear its state. */
type Done = { done?: (ok: boolean) => void };

export const DASHBOARD_VIEW_TYPE = 'notecolab-dashboard';

export class DashboardView extends ItemView {
  plugin: ColabPlugin;
  private component: InstanceType<typeof Dashboard> | null = null;
  private isLoading = false;

  constructor(leaf: WorkspaceLeaf, plugin: ColabPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  private collectNoteKeys(): Map<string, string> {
    const keys = new Map<string, string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
      const shareId = typeof fm?.colab_share_id === 'string' ? fm.colab_share_id : '';
      const key = typeof fm?.colab_encryption_key === 'string'
        ? fm.colab_encryption_key
        : (typeof fm?.colab_link === 'string' ? fm.colab_link.split('#')[1] || '' : '');
      if (shareId && key) keys.set(shareId, key);
    }
    return keys;
  }

  private collectLocalSharedNotes(serverShareIds: Set<string>) {
    return this.app.vault.getMarkdownFiles().flatMap((file) => {
      const fm = noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
      if (!fm || !isRecipientImport(fm)) return [];
      const shareId = fm.colab_share_id;
      const accessMode = fm.colab_access;
      if (!shareId || !accessMode || serverShareIds.has(shareId)) return [];

      return [{
        noteId: 0,
        title: recipientNoteTitle(file.basename),
        encryptedTitle: null,
        ownerUid: '',
        shareId,
        accessMode,
        // Recipient copies record the server's effective access, not the link mode.
        canEdit: accessMode !== 'read_only',
        createdAt: new Date(file.stat.ctime).toISOString(),
        updatedAt: new Date(file.stat.mtime).toISOString(),
        localOnly: true,
      }];
    });
  }

  private async decryptTitle(encryptedTitle: string | null | undefined, key: string | undefined): Promise<string | null> {
    if (!encryptedTitle || !key) return null;
    try {
      return await decrypt(encryptedTitle, key);
    } catch {
      return null;
    }
  }

  private async backfillTitle(noteShareId: string, title: string | null | undefined, encryptedTitle: string | null | undefined, key: string | undefined) {
    if (!title || encryptedTitle || !key) return;
    try {
      const titleCiphertext = await encrypt(title, key);
      void this.plugin.api.updateNote(noteShareId, { encryptedTitle: titleCiphertext });
    } catch (e) {
      console.warn('NoteColab: failed to backfill encrypted title:', e);
    }
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Note Colab';
  }

  getIcon(): string {
    return 'share-2';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    if (!container) return;
    container.empty();

    try {
      this.component = new Dashboard({
        target: container,
        props: {
          loading: true,
          notes: [],
          sharedNotes: [],
          pendingShares: [],
          storage: null,
        },
      });

      const component = this.component;
      const on = <T>(name: string, handler: (detail: T) => void | Promise<unknown>) => {
        component.$on(name, (e: CustomEvent<T & Done>) => {
          void this.safeHandle(() => handler(e.detail)).then((ok) => e.detail.done?.(ok));
        });
      };
      component.$on('refresh', () => { void this.loadData(); });
      component.$on('share-current', () => { void this.plugin.shareCurrentNote(); });
      on<{ noteShareId: string }>('open-note', (detail) => this.handleOpenNote(detail));
      on<{ noteShareId: string }>('copy-link', (detail) => this.handleCopyLink(detail));
      on<{ noteShareId: string }>('manage-links', (detail) => this.handleManageLinks(detail));
      on<{ noteShareId: string; title: string }>('revoke', (detail) => {
        new DeleteSharedNoteModal(this.app, detail.title, () => {
          void this.safeHandle(() => this.handleRevoke(detail));
        }).open();
      });
      on<{ shareId: string; encryptedKey: string; nonce: string; senderUid: string; id: number }>('import-share', (detail) => this.handleImportShare(detail));
      on<{ id: number }>('dismiss-share', (detail) => this.handleDismissShare(detail));
      on<{ noteShareId: string }>('delete-note', (detail) => this.handleDeleteNote(detail));
      on<{ shareId: string }>('leave-share', (detail) => this.handleLeaveShare(detail));

      await this.loadData();
    } catch (e) {
      console.error('NoteColab: Dashboard failed to initialize:', e);
      container.empty();
      container.createDiv({
        text: 'The dashboard couldn’t open. Close it and open it again; if that fails, reload Obsidian.',
        cls: 'notecolab-error',
      });
    }
  }

  async onClose(): Promise<void> {
    this.component?.$destroy();
    this.component = null;
  }

  async loadData(): Promise<void> {
    if (this.isLoading || !this.component) return;
    this.isLoading = true;
    this.component.$set({ loading: true, error: '' });

    try {
      const [notesResult, sharedResult, pendingShares, storage] = await Promise.all([
        this.plugin.api.listMyNotes(),
        this.plugin.api.getSharedWithMe(),
        this.plugin.api.getPendingShares(),
        this.plugin.api.getMyStorage(),
      ]);

      if (!this.component) return; // view closed during fetch

      const localSharedNotes = this.collectLocalSharedNotes(
        new Set((sharedResult?.notes || []).map((note) => note.shareId)),
      );
      if (!notesResult && !storage && localSharedNotes.length === 0) {
        this.component.$set({
          loading: false,
          error: 'Couldn’t load your shared notes. Check your connection and the server URL in Note Colab settings.',
        });
        return;
      }

      const noteKeys = this.collectNoteKeys();
      const ownedNotes = await Promise.all((notesResult?.notes || []).map(async (note) => {
        const key = noteKeys.get(note.noteShareId);
        const decryptedTitle = await this.decryptTitle(note.encryptedTitle, key);
        await this.backfillTitle(note.noteShareId, note.title, note.encryptedTitle, key);
        return {
          ...note,
          title: decryptedTitle || note.title || 'Encrypted note',
        };
      }));
      const storageNotes = await Promise.all((storage?.notes || []).map(async (note) => {
        const key = noteKeys.get(note.noteShareId);
        const decryptedTitle = await this.decryptTitle(note.encryptedTitle, key);
        return {
          ...note,
          title: decryptedTitle || note.title || 'Encrypted note',
        };
      }));
      const sharedNotes = await Promise.all((sharedResult?.notes || []).map(async (note) => {
        const key = noteKeys.get(note.shareId);
        const decryptedTitle = await this.decryptTitle(note.encryptedTitle, key);
        return {
          ...note,
          title: decryptedTitle || note.title || 'Encrypted note',
        };
      }));
      const pending = await Promise.all(pendingShares.map(async (share) => {
        let title: string | null = share.title;
        if (share.encryptedTitle && this.plugin.settings.secretKey) {
          const senderInfo = await this.plugin.api.getPublicKey(share.senderUid).catch((error: unknown) => {
            if (error instanceof DirectoryKeyChangedError) {
              console.error(error.message);
              return null;
            }
            throw error;
          });
          if (senderInfo?.publicKey) {
            const noteKey = decryptKeyFromSender(
              share.encryptedKey,
              share.nonce,
              senderInfo.publicKey,
              this.plugin.settings.secretKey,
            );
            title = await this.decryptTitle(share.encryptedTitle, noteKey || undefined) || title;
          }
        }
        return { ...share, title: title || 'Encrypted note' };
      }));

      this.component.$set({
        loading: false,
        notes: ownedNotes,
        sharedNotes: [...sharedNotes, ...localSharedNotes],
        pendingShares: pending,
        storage: storage ? { ...storage, notes: storageNotes } : storage,
      });
    } catch (e) {
      console.error('NoteColab: Failed to load dashboard data:', e);
      if (this.component) {
        this.component.$set({
          loading: false,
          error: 'Couldn’t load your shared notes. Check your connection and try again.',
        });
      }
    } finally {
      this.isLoading = false;
    }
  }

  /** Run a handler; resolves false when it failed or returned false. */
  private async safeHandle(fn: () => unknown): Promise<boolean> {
    try {
      return await fn() !== false;
    } catch (e) {
      console.error('NoteColab dashboard handler error:', e);
      new Notice('NoteColab: something went wrong. Check your connection and try again.');
      return false;
    }
  }

  private findNoteFile(shareId: string) {
    return this.app.vault.getMarkdownFiles().find((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      return noteColabFrontmatter(cache?.frontmatter)?.colab_share_id === shareId;
    });
  }

  private handleOpenNote(detail: { noteShareId: string }) {
    // Find file in vault by colab_share_id frontmatter
    const file = this.app.vault.getMarkdownFiles().find((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      return noteColabFrontmatter(cache?.frontmatter)?.colab_share_id === detail.noteShareId;
    });

    if (file) {
      void this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice('Note not found in vault. It may need to be imported first.');
    }
  }

  private async handleCopyLink(detail: { noteShareId: string }) {
    const file = this.findNoteFile(detail.noteShareId);
    if (!file) {
      new Notice('Note not found in vault');
      return;
    }
    await this.plugin.copyNoteShareLink(file);
  }

  private handleManageLinks(detail: { noteShareId: string }) {
    const file = this.findNoteFile(detail.noteShareId);
    if (!file) {
      new Notice('Note not found in vault');
      return;
    }
    this.plugin.openManageLinks(file);
  }

  private async handleRevoke(detail: { noteShareId: string; title: string }) {
    const file = this.findNoteFile(detail.noteShareId);

    if (file) {
      const { revokeShare } = await import('../../share/shareNote');
      await revokeShare(this.app, this.plugin.api, file);
      await this.loadData();
    } else {
      // Note not in vault, delete directly from server
      const ok = await this.plugin.api.deleteNote(detail.noteShareId);
      if (ok) {
        new Notice(`"${detail.title}" was deleted from the server.`);
        await this.loadData();
      } else {
        new Notice('Couldn’t delete the shared note from the server. Check your connection and try again.');
      }
    }
  }

  private async handleImportShare(detail: { shareId: string; encryptedKey: string; nonce: string; senderUid: string; id: number }): Promise<boolean> {
    try {
      const senderInfo = await this.plugin.api.getPublicKey(detail.senderUid);
      if (!senderInfo?.publicKey) {
        new Notice('Couldn’t open this invitation: the sender’s identity key wasn’t found. Check your connection or ask them to send it again.');
        return false;
      }

      const { decryptKeyFromSender } = await import('../../crypto/keyExchange');
      const noteKey = decryptKeyFromSender(
        detail.encryptedKey,
        detail.nonce,
        senderInfo.publicKey,
        this.plugin.settings.secretKey
      );

      if (!noteKey) {
        new Notice('Couldn’t open this invitation. It may have been sent to an earlier installation; ask the sender to send it again.');
        return false;
      }

      const { importNote } = await import('../../share/importNote');
      const shareUrl = `${this.plugin.settings.serverUrl}/s/${detail.shareId}#${noteKey}`;
      const imported = await importNote(this.app, this.plugin.api, shareUrl, {
        settings: this.plugin.settings,
        saveSettings: () => this.plugin.saveSettings(),
      });
      if (!imported) {
        new Notice('Import failed; the invitation remains pending');
        return false;
      }
      await this.plugin.api.ackPendingShare(detail.id);
      await this.loadData();
      return true;
    } catch (e) {
      console.error('Failed to import share:', e);
      new Notice(e instanceof DirectoryKeyChangedError
        ? `${e.message}. Verify it with the sender, then reset its pin in Note Colab settings.`
        : 'Couldn’t import this note. The invitation remains pending; check your connection and try again.', 15_000);
      return false;
    }
  }

  private async handleDismissShare(detail: { id: number }): Promise<boolean> {
    const ok = await this.plugin.api.dismissPendingShare(detail.id);
    if (ok) {
      new Notice('Invitation declined');
      await this.loadData();
    } else {
      new Notice('Couldn’t decline the invitation. Check your connection and try again.');
    }
    return ok;
  }

  private async handleLeaveShare(detail: { shareId: string }): Promise<boolean> {
    const left = await this.plugin.api.leaveSharedNote(detail.shareId);
    if (!left) {
      new Notice('Couldn’t leave the shared note. Check your connection and try again.');
      return false;
    }

    const file = this.app.vault.getMarkdownFiles().find((candidate) => {
      const fm = noteColabFrontmatter(this.app.metadataCache.getFileCache(candidate)?.frontmatter);
      return fm?.colab_share_id === detail.shareId;
    });
    if (file) {
      stopShareSync(this.app, file.path);
      await this.app.fileManager.processFrontMatter(file, (fm: import('../../share/frontmatter').NoteColabFrontmatter) => {
        delete fm.colab_share_id;
        delete fm.colab_link_id;
        delete fm.colab_link;
        delete fm.colab_access;
        delete fm.colab_encryption_key;
        delete fm.colab_owner;
        delete fm.colab_expires;
        delete fm.colab_session;
      });
    }

    new Notice('You left the shared note. Any local file was kept as a private copy.');
    await this.loadData();
    return true;
  }

  private async handleDeleteNote(detail: { noteShareId: string }): Promise<boolean> {
    const ok = await this.plugin.api.deleteNote(detail.noteShareId);
    if (ok) {
      // Clean frontmatter from vault file
      const file = this.app.vault.getMarkdownFiles().find((f) => {
        const cache = this.app.metadataCache.getFileCache(f);
        return noteColabFrontmatter(cache?.frontmatter)?.colab_share_id === detail.noteShareId;
      });
      if (file) {
        await this.app.fileManager.processFrontMatter(file, (fm: import('../../share/frontmatter').NoteColabFrontmatter) => {
          delete fm.colab_share_id;
          delete fm.colab_link_id;
          delete fm.colab_link;
          delete fm.colab_access;
          delete fm.colab_expires;
          delete fm.colab_encryption_key;
          delete fm.colab_session;
        });
      }
      new Notice('Note deleted from server');
      await this.loadData();
    } else {
      new Notice('Couldn’t delete the note from the server. Check your connection and try again.');
    }
    return ok;
  }
}

import { Modal, Notice, type App } from 'obsidian';
import ManageLinksComponent from '../components/ManageLinks.svelte';
import type { ApiClient } from '../../api/client';
import type { Contact } from '../../types';
import { encryptKeyForRecipient } from '../../crypto/keyExchange';

export class ManageLinksModalView extends Modal {
  private component: InstanceType<typeof ManageLinksComponent> | null = null;
  private api: ApiClient;
  private noteShareId: string;
  private encryptionKey: string;
  private serverUrl: string;
  private contacts: Contact[];
  private secretKey: string;

  constructor(
    app: App,
    api: ApiClient,
    noteShareId: string,
    encryptionKey: string,
    serverUrl: string,
    contacts: Contact[],
    secretKey: string
  ) {
    super(app);
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

    modalEl.style.width = '550px';
    modalEl.style.maxWidth = '90vw';

    this.component = new ManageLinksComponent({
      target: contentEl,
      props: {
        links: [],
        collaborators: [],
        contacts: this.contacts,
        serverUrl: this.serverUrl,
        encryptionKey: this.encryptionKey,
        loading: true,
      },
    });

    this.component.$on('copy-link', (e: CustomEvent) => {
      navigator.clipboard.writeText(e.detail.url);
      new Notice('Link copied to clipboard');
    });

    this.component.$on('create-link', async (e: CustomEvent) => {
      const result = await this.api.createLink(this.noteShareId, {
        accessMode: e.detail.accessMode,
        expiresIn: e.detail.expiresIn,
        label: e.detail.label,
      });
      if (result) {
        new Notice('Link created');
        await this.loadData();
      } else {
        new Notice('Failed to create link');
      }
    });

    this.component.$on('update-link', async (e: CustomEvent) => {
      const ok = await this.api.updateLink(e.detail.linkShareId, {
        accessMode: e.detail.accessMode,
        expiresIn: e.detail.expiresIn,
        label: e.detail.label,
      });
      if (ok) {
        new Notice('Link updated');
        await this.loadData();
      } else {
        new Notice('Failed to update link');
      }
    });

    this.component.$on('delete-link', async (e: CustomEvent) => {
      const ok = await this.api.deleteLink(e.detail.linkShareId);
      if (ok) {
        new Notice('Link deleted');
        await this.loadData();
      } else {
        new Notice('Failed to delete link');
      }
    });

    this.component.$on('send-to-obsidian', async (e: CustomEvent) => {
      const {
        uid,
        linkShareId,
        accessMode,
      } = e.detail as {
        uid: string;
        linkShareId: string;
        accessMode: 'public_edit' | 'invited_edit' | 'read_only';
      };
      const pubKeyInfo = await this.api.getPublicKey(uid);
      if (!pubKeyInfo?.publicKey) {
        new Notice(`Skipped ${uid}: no public key - ask them to enable Note Colab first`);
        return;
      }

      let encrypted: { encryptedKey: string; nonce: string };
      try {
        encrypted = encryptKeyForRecipient(
          this.encryptionKey,
          pubKeyInfo.publicKey,
          this.secretKey,
        );
      } catch (err) {
        console.warn(`Failed to encrypt key for recipient ${uid}:`, err);
        new Notice(`Skipped ${uid}: no public key - ask them to enable Note Colab first`);
        return;
      }

      if (accessMode === 'invited_edit') {
        const granted = await this.api.addCollaborator(this.noteShareId, uid, true);
        if (!granted) {
          new Notice('Failed to grant invited access');
          return;
        }
      }
      const delivered = await this.api.createPendingShares(linkShareId, [{
        recipientUid: uid,
        encryptedKey: encrypted.encryptedKey,
        nonce: encrypted.nonce,
      }]);
      new Notice(
        delivered
          ? 'Delivered to the recipient’s Note Colab plugin'
          : 'Failed to deliver to Obsidian',
      );
      if (delivered && accessMode === 'invited_edit') await this.loadData();
    });

    this.component.$on('add-collaborator', async (e: CustomEvent) => {
      const uid = e.detail.uid;

      // Encrypt the note key for the collaborator
      const pubKeyInfo = await this.api.getPublicKey(uid);
      if (!pubKeyInfo?.publicKey) {
        new Notice(`Skipped ${uid}: no public key - ask them to enable Note Colab first`);
        return;
      }

      let encrypted: { encryptedKey: string; nonce: string };
      try {
        encrypted = encryptKeyForRecipient(
          this.encryptionKey,
          pubKeyInfo.publicKey,
          this.secretKey
        );
      } catch (err) {
        console.warn(`Failed to encrypt key for collaborator ${uid}:`, err);
        new Notice(`Skipped ${uid}: no public key - ask them to enable Note Colab first`);
        return;
      }

      const ok = await this.api.addCollaborator(this.noteShareId, uid, true);
      if (ok) {
        // Send encrypted key via pending share
        await this.api.createPendingShares(this.noteShareId, [{
          recipientUid: uid,
          encryptedKey: encrypted.encryptedKey,
          nonce: encrypted.nonce,
        }]);
        new Notice('Collaborator added');
        await this.loadData();
      } else {
        new Notice('Failed to add collaborator');
      }
    });

    this.component.$on('remove-collaborator', async (e: CustomEvent) => {
      const ok = await this.api.removeCollaborator(this.noteShareId, e.detail.uid);
      if (ok) {
        new Notice('Collaborator removed');
        await this.loadData();
      } else {
        new Notice('Failed to remove collaborator');
      }
    });

    this.component.$on('resend-collaborator', async (e: CustomEvent) => {
      const uid = e.detail.uid;
      const pubKeyInfo = await this.api.getPublicKey(uid);
      if (!pubKeyInfo?.publicKey) {
        new Notice(`Cannot resend to ${uid}: no public key found`);
        return;
      }

      try {
        const encrypted = encryptKeyForRecipient(
          this.encryptionKey,
          pubKeyInfo.publicKey,
          this.secretKey
        );
        const sent = await this.api.createPendingShares(this.noteShareId, [{
          recipientUid: uid,
          encryptedKey: encrypted.encryptedKey,
          nonce: encrypted.nonce,
        }]);
        new Notice(sent ? 'Invitation sent again' : 'Failed to resend invitation');
      } catch (err) {
        console.warn(`Failed to resend invitation to ${uid}:`, err);
        new Notice('Failed to resend invitation');
      }
    });

    this.component.$on('create-invite-link', async (e: CustomEvent) => {
      const linkShareId = e.detail?.linkShareId || this.noteShareId;
      const result = await this.api.createInviteLink(linkShareId);
      if (result?.token) {
        const inviteUrl = `${this.serverUrl}/invite/${result.token}#${this.encryptionKey}`;
        await navigator.clipboard.writeText(inviteUrl);
        new Notice('Invite link copied to clipboard!\nShare it with anyone you want to invite.');
      } else {
        new Notice('Failed to create invite link');
      }
    });

    await this.loadData();
  }

  onClose(): void {
    this.component?.$destroy();
    this.component = null;
  }

  private async loadData(): Promise<void> {
    const [result, collaborators] = await Promise.all([
      this.api.listLinks(this.noteShareId),
      this.api.listCollaborators(this.noteShareId),
    ]);

    this.component?.$set({
      loading: false,
      links: result?.links || [],
      collaborators,
    });
  }
}

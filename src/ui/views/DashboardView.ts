import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import Dashboard from '../components/Dashboard.svelte';
import type ColabPlugin from '../../main';
import { decrypt, encrypt } from '../../crypto/crypto';
import { decryptKeyFromSender } from '../../crypto/keyExchange';
import { DirectoryKeyChangedError } from '../../crypto/identityTrust';
import { stopShareSync } from '../../session/sessions';
import { noteColabFrontmatter } from '../../share/frontmatter';

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

      this.component.$on('refresh', () => { void this.loadData(); });
      this.component.$on('share-current', () => { void this.plugin.shareCurrentNote(); });
      this.component.$on('open-note', (e: CustomEvent<{ noteShareId: string }>) => { void this.safeHandle(() => this.handleOpenNote(e.detail)); });
      this.component.$on('copy-link', (e: CustomEvent<{ noteShareId: string }>) => { void this.safeHandle(() => this.handleCopyLink(e.detail)); });
      this.component.$on('manage-links', (e: CustomEvent<{ noteShareId: string }>) => { void this.safeHandle(() => this.handleManageLinks(e.detail)); });
      this.component.$on('revoke', (e: CustomEvent<{ noteShareId: string }>) => { void this.safeHandle(() => this.handleRevoke(e.detail)); });
      this.component.$on('import-share', (e: CustomEvent<{ shareId: string; encryptedKey: string; nonce: string; senderUid: string; id: number }>) => { void this.safeHandle(() => this.handleImportShare(e.detail)); });
      this.component.$on('dismiss-share', (e: CustomEvent<{ id: number }>) => { void this.safeHandle(() => this.handleDismissShare(e.detail)); });
      this.component.$on('delete-note', (e: CustomEvent<{ noteShareId: string }>) => { void this.safeHandle(() => this.handleDeleteNote(e.detail)); });
      this.component.$on('leave-share', (e: CustomEvent<{ shareId: string }>) => { void this.safeHandle(() => this.handleLeaveShare(e.detail)); });

      await this.loadData();
    } catch (e) {
      console.error('NoteColab: Dashboard failed to initialize:', e);
      container.empty();
      container.createDiv({
        text: `Dashboard failed to load: ${e instanceof Error ? e.message : String(e)}`,
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

      if (!notesResult && !storage) {
        this.component.$set({
          loading: false,
          error: 'Failed to load data from server. Check your server URL and connection.',
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
        sharedNotes,
        pendingShares: pending,
        storage: storage ? { ...storage, notes: storageNotes } : storage,
      });
    } catch (e) {
      console.error('NoteColab: Failed to load dashboard data:', e);
      new Notice('NoteColab: Failed to load dashboard data');
      if (this.component) {
        this.component.$set({
          loading: false,
          error: `Failed to load data: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } finally {
      this.isLoading = false;
    }
  }

  private async safeHandle(fn: () => void | Promise<void>) {
    try {
      await fn();
    } catch (e) {
      console.error('NoteColab dashboard handler error:', e);
      new Notice(`NoteColab: ${e instanceof Error ? e.message : 'An error occurred'}`);
    }
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

  private handleCopyLink(detail: { noteShareId: string }) {
    const file = this.app.vault.getMarkdownFiles().find((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      return noteColabFrontmatter(cache?.frontmatter)?.colab_share_id === detail.noteShareId;
    });

    if (file) {
      const cache = this.app.metadataCache.getFileCache(file);
      const link = noteColabFrontmatter(cache?.frontmatter)?.colab_link;
      if (link) {
        void navigator.clipboard.writeText(link);
        new Notice('Share link copied to clipboard');
      } else {
        new Notice('No share link found for this note');
      }
    } else {
      new Notice('Note not found in vault');
    }
  }

  private handleManageLinks(detail: { noteShareId: string }) {
    const file = this.app.vault.getMarkdownFiles().find((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      return noteColabFrontmatter(cache?.frontmatter)?.colab_share_id === detail.noteShareId;
    });

    if (!file) {
      new Notice('Note not found in vault');
      return;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const fm = noteColabFrontmatter(cache?.frontmatter);
    const encKey = fm?.colab_encryption_key ||
      (fm?.colab_link ? fm.colab_link.split('#')[1] : '');

    if (!encKey) {
      new Notice('Encryption key not found. Re-share the note to fix this.');
      return;
    }

    // Import dynamically to avoid circular dependencies
    void import('./ManageLinksModalView').then(({ ManageLinksModalView }) => {
      new ManageLinksModalView(
        this.app,
        this.plugin.api,
        detail.noteShareId,
        encKey,
        this.plugin.settings.serverUrl,
        this.plugin.settings.contacts,
        this.plugin.settings.secretKey
      ).open();
    });
  }

  private async handleRevoke(detail: { noteShareId: string }) {
    const file = this.app.vault.getMarkdownFiles().find((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      return noteColabFrontmatter(cache?.frontmatter)?.colab_share_id === detail.noteShareId;
    });

    if (file) {
      const { revokeShare } = await import('../../share/shareNote');
      await revokeShare(this.app, this.plugin.api, file);
      await this.loadData();
    } else {
      // Note not in vault, delete directly from server
      const ok = await this.plugin.api.deleteNote(detail.noteShareId);
      if (ok) {
        new Notice('Share revoked');
        await this.loadData();
      } else {
        new Notice('Failed to revoke share');
      }
    }
  }

  private async handleImportShare(detail: { shareId: string; encryptedKey: string; nonce: string; senderUid: string; id: number }) {
    try {
      const senderInfo = await this.plugin.api.getPublicKey(detail.senderUid);
      if (!senderInfo?.publicKey) {
        new Notice('Cannot decrypt share: sender public key not found');
        return;
      }

      const { decryptKeyFromSender } = await import('../../crypto/keyExchange');
      const noteKey = decryptKeyFromSender(
        detail.encryptedKey,
        detail.nonce,
        senderInfo.publicKey,
        this.plugin.settings.secretKey
      );

      if (!noteKey) {
        new Notice('Failed to decrypt share key');
        return;
      }

      const { importNote } = await import('../../share/importNote');
      const shareUrl = `${this.plugin.settings.serverUrl}/s/${detail.shareId}#${noteKey}`;
      const imported = await importNote(this.app, this.plugin.api, shareUrl, {
        settings: this.plugin.settings,
        saveSettings: () => this.plugin.saveSettings(),
      });
      if (!imported) {
        new Notice('Import failed; the invitation remains pending');
        return;
      }
      await this.plugin.api.ackPendingShare(detail.id);
      await this.loadData();
    } catch (e) {
      console.error('Failed to import share:', e);
      new Notice(e instanceof DirectoryKeyChangedError
        ? `${e.message}. Verify it with the sender, then reset its pin in Note Colab settings.`
        : 'Failed to import shared note', 15_000);
    }
  }

  private async handleDismissShare(detail: { id: number }) {
    const ok = await this.plugin.api.dismissPendingShare(detail.id);
    if (ok) {
      await this.loadData();
    } else {
      new Notice('Failed to dismiss share');
    }
  }

  private async handleLeaveShare(detail: { shareId: string }) {
    const left = await this.plugin.api.leaveSharedNote(detail.shareId);
    if (!left) {
      new Notice('Failed to remove shared note');
      return;
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

    new Notice('Removed shared note. Any local file was kept as a private copy.');
    await this.loadData();
  }

  private async handleDeleteNote(detail: { noteShareId: string }) {
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
      new Notice('Failed to delete note');
    }
  }
}

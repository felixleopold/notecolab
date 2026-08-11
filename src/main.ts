import {
  Notice,
  Plugin,
  editorInfoField,
  MarkdownView,
  normalizePath,
  type MarkdownFileInfo,
  type TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { EditorView, showPanel, type Panel } from '@codemirror/view';
import { DEFAULT_SETTINGS, initialUsernamePromptState, migrateOfficialServerUrl, type ColabSettings } from './types';
import { ApiClient } from './api/client';
import { shareNote, revokeShare, copyShareLink } from './share/shareNote';
import { importNote, foreignOrigin } from './share/importNote';
import { startShareSync, getShareSync, getShareSyncShareId, getShareSyncPathByShareId, getShareSyncStatus, stopShareSync, destroyAllShareSyncs, publishSnapshot, cancelSnapshot, renameShareSync, parseFrontmatter } from './session/sessions';
import { generateKeyPair, decryptKeyFromSender } from './crypto/keyExchange';
import { DirectoryKeyChangedError } from './crypto/identityTrust';
import { decrypt, encrypt } from './crypto/crypto';
import { ShareModalView } from './ui/views/ShareModalView';
import { ImportModal } from './ui/ImportModal';
import { ManageLinksModalView } from './ui/views/ManageLinksModalView';
import { DeleteConfirmModal } from './ui/DeleteConfirmModal';
import { IncomingShareModal, type ShareDecision } from './ui/IncomingShareModal';
import { ColabSettingsTab } from './ui/SettingsTab';
import { DashboardView, DASHBOARD_VIEW_TYPE } from './ui/views/DashboardView';
import { shareIdFromLink } from './share/shareLink';
import { downloadMissingAssets } from './share/assets';
import { findImageEmbeds } from './share/imageEmbeds';
import {
  editableCopyBasename,
  isReadOnlyRecipient,
  stripColabMetadata,
} from './share/readOnlyMirror';
import { ReadOnlyMirrorModal } from './ui/ReadOnlyMirrorModal';
import { DeleteReadOnlyMirrorModal } from './ui/DeleteReadOnlyMirrorModal';
import { UsernamePromptModal } from './ui/UsernamePromptModal';
import {
  sanitizeFilename,
  sharedNoteBasename,
  withFilenameCounter,
} from './share/sharedNoteFilename';
import {
  mayPublishAsOwner,
  shareOwnership,
  type ShareOwnership,
} from './share/shareOwnership';

/** A decrypted incoming share awaiting the user's accept/deny decision. */
interface IncomingShare {
  id: number;
  shareId: string;
  noteKey: string;
  senderName: string;
  senderUid: string;
  title: string;
  accessMode: 'public_edit' | 'invited_edit' | 'read_only';
}

type StorageLevel = 'ok' | 'warn' | 'full';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default class ColabPlugin extends Plugin {
  settings: ColabSettings = DEFAULT_SETTINGS;
  api!: ApiClient;
  private statusBarItem: HTMLElement | null = null;
  private statusBarInterval: ReturnType<typeof setInterval> | null = null;
  private pendingSharesInterval: ReturnType<typeof setInterval> | null = null;
  // Cache shared note info so we can prompt on delete (frontmatter gone after deletion)
  private sharedNoteCache = new Map<string, {
    shareId: string;
    title: string;
    ownership: ShareOwnership;
    link?: string;
  }>();
  // Deferred "delete from server?" prompts, keyed by shareId. A move can surface
  // as a delete+create pair; deferring lets the re-created copy cancel the prompt.
  private pendingDeletions = new Map<string, ReturnType<typeof setTimeout>>();
  // Track which [[wikilinks]] we've already prompted about
  private promptedLinks = new Set<string>();
  private refCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private refCheckFile: TFile | null = null;
  // Incoming-share accept/deny queue (one popup shown at a time)
  private incomingShareQueue: IncomingShare[] = [];
  private promptedPendingShares = new Set<number>();
  private warnedChangedIdentityKeys = new Set<string>();
  private showingIncomingModal = false;
  private duplicateSyncWarnings = new Set<string>();
  private readOnlyRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private refreshingReadOnlyMirrors = new Set<string>();
  private readOnlyPromptedAt = new Map<string, number>();
  private suppressedDeletionPrompts = new Set<string>();
  private allowedReadOnlyRenames = new Set<string>();
  // Storage warnings — throttle checks and only re-warn when usage worsens
  private lastStorageCheck = 0;
  private lastStorageLevel: StorageLevel = 'ok';
  private usernamePromptOpen = false;

  async onload() {
    await this.loadSettings();
    this.api = new ApiClient(this.settings, () => this.saveSettings());

    // Ensure we have a keypair (for users who registered before this feature)
    if (this.settings.apiKey && !this.settings.publicKey) {
      try {
        const kp = generateKeyPair();
        this.settings.publicKey = kp.publicKey;
        this.settings.secretKey = kp.secretKey;
        await this.saveSettings();
        await this.api.uploadPublicKey(kp.publicKey);
      } catch (e) {
        console.warn('Failed to generate/upload keypair:', e);
      }
    }

    // Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();

    // Register dashboard view
    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf) => new DashboardView(leaf, this)
    );

    // Ribbon icon to open dashboard
    this.addRibbonIcon('share-2', 'Note Colab dashboard', () => {
      this.activateDashboardView();
    });

    // Settings tab
    this.addSettingTab(new ColabSettingsTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.usernamePromptState === 'upgrade') {
        void this.maybePromptForUsername('upgrade');
      }
    });
    this.registerReadOnlyMirrorUi();

    // --- Commands ---

    this.addCommand({
      id: 'share-note',
      name: 'Share note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;

        this.shareCurrentNote();
      },
    });

    this.addCommand({
      id: 'import-shared-note',
      name: 'Import shared note',
      callback: () => {
        new ImportModal(this.app, async (url) => {
          await importNote(this.app, this.api, url, {
            settings: this.settings,
            saveSettings: () => this.saveSettings(),
          });
        }).open();
      },
    });

    this.addCommand({
      id: 'create-editable-copy',
      name: 'Create editable copy of read-only note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isReadOnlyMirror(file)) return false;
        if (!checking) void this.createEditableCopy(file);
        return true;
      },
    });

    this.addCommand({
      id: 'delete-read-only-mirror',
      name: 'Delete read-only note and stop updates',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isReadOnlyMirror(file)) return false;
        if (!checking) this.confirmDeleteReadOnlyMirror(file);
        return true;
      },
    });

    this.addCommand({
      id: 'stop-sync',
      name: 'Stop share sync',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!getShareSync(file.path)) return false;
        if (checking) return true;

        stopShareSync(this.app, file.path);
        this.updateStatusBar();
        new Notice('Share sync stopped');
      },
    });

    this.addCommand({
      id: 'revoke-share',
      name: 'Revoke note share',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;

        revokeShare(this.app, this.api, file);
      },
    });

    this.addCommand({
      id: 'copy-share-link',
      name: 'Copy share link',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;

        copyShareLink(this.app, file);
      },
    });

    this.addCommand({
      id: 'manage-links',
      name: 'Manage shared links',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!this.app.metadataCache.getFileCache(file)?.frontmatter?.colab_share_id) return false;
        if (checking) return true;

        this.openManageLinks(file);
      },
    });

    this.addCommand({
      id: 'open-dashboard',
      name: 'Open dashboard',
      callback: () => {
        this.activateDashboardView();
      },
    });



    // --- Detect local deletion of shared notes ---
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file.path.endsWith('.md')) {
          this.handleFileDelete(file as TFile);
        }
      })
    );

    // --- Follow shared notes when they're moved/renamed ---
    // A move must never look like a deletion: keep the live sync session and the
    // delete-detection cache pointed at the new path, and cancel any pending
    // "deleted from server?" prompt if this move arrived as a delete+create pair
    // (e.g. via Obsidian Sync or an OS-level move). (issue #3)
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const allowedReadOnlyRename = this.allowedReadOnlyRenames.delete(file.path);
        if (!allowedReadOnlyRename && file.path.endsWith('.md')) {
          const markdownFile = file as TFile;
          const oldName = oldPath.split('/').pop() || '';
          if (this.isReadOnlyMirror(markdownFile) && markdownFile.name !== oldName) {
            void this.restoreReadOnlyMirrorName(markdownFile, oldPath);
            return;
          }
        }
        renameShareSync(oldPath, file.path);
        const cached = this.sharedNoteCache.get(oldPath);
        if (cached) {
          this.sharedNoteCache.delete(oldPath);
          this.sharedNoteCache.set(file.path, {
            ...cached,
            title: (file as TFile).basename ?? cached.title,
          });
          this.cancelPendingDeletion(cached.shareId);
        }
        if (file.path.endsWith('.md')) {
          void this.publishRenamedTitle(file as TFile);
        }
      })
    );

    // --- Publish edits of read-only shares to the web ---
    // Read-only shares have no live Yjs sync, so the stored snapshot is the only
    // thing the web ever sees. Re-encrypt and PATCH it whenever the file changes.
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file.path.endsWith('.md')) {
          this.maybePublishReadOnly(file as TFile);
        }
      })
    );

    // --- URI handler for deep links ---
    this.registerObsidianProtocolHandler('colab-import', async (params) => {
      const url = params.url;
      const invite = params.invite;

      if (invite && url) {
        // Invite link: accept invite first (adds us as collaborator), then import
        try {
          const result = await this.api.acceptInvite(decodeURIComponent(invite));
          if (!result?.ok) {
            new Notice('Failed to accept invite — it may have expired or already been used.');
            return;
          }
          await importNote(this.app, this.api, decodeURIComponent(url), {
            settings: this.settings,
            saveSettings: () => this.saveSettings(),
          });
          new Notice('Invite accepted — note imported!');
        } catch (e) {
          console.error('NoteColab: invite accept failed:', e);
          new Notice('Failed to accept invite');
        }
      } else if (url) {
        await importNote(this.app, this.api, decodeURIComponent(url), {
          settings: this.settings,
          saveSettings: () => this.saveSettings(),
        });
      }
    });

    // Update status bar and auto-connect share sync when active leaf changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.updateStatusBar();
        this.autoConnectShareSync();
        const file = this.app.workspace.getActiveFile();
        if (file) {
          this.maybePublishReadOnly(file);
          void this.refreshReadOnlyMirror(file);
          void this.openReadOnlyMirrorInReadingView();
        }
      })
    );

    // Auto-connect share sync for any already-open shared note
    this.app.workspace.onLayoutReady(() => {
      this.autoConnectShareSync();
      const file = this.app.workspace.getActiveFile();
      if (file) {
        this.maybePublishReadOnly(file);
        void this.refreshReadOnlyMirror(file);
        void this.openReadOnlyMirrorInReadingView();
      }
    });

    // Periodically refresh status bar to reflect WS state changes
    this.statusBarInterval = setInterval(() => this.updateStatusBar(), 3000);
    this.readOnlyRefreshInterval = setInterval(() => {
      const file = this.app.workspace.getActiveFile();
      if (file) void this.refreshReadOnlyMirror(file);
    }, 30_000);

    // Poll for pending shares and storage usage (storage check self-throttles)
    this.pendingSharesInterval = setInterval(() => {
      this.checkPendingShares();
      this.maybeWarnStorage();
    }, 60_000);
    // Check once on startup (with a short delay to let the vault load)
    this.app.workspace.onLayoutReady(() => {
      setTimeout(() => {
        this.checkPendingShares();
        this.maybeWarnStorage();
      }, 5000);
    });

    // Build initial shared note cache for delete detection
    this.app.workspace.onLayoutReady(() => {
      this.rebuildSharedNoteCache();
    });

    // Keep cache up-to-date when frontmatter changes
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (fm?.colab_share_id) {
          this.sharedNoteCache.set(file.path, {
            shareId: fm.colab_share_id,
            title: file.basename,
            ownership: shareOwnership(fm),
            link: fm.colab_link,
          });
          // A copy of this share is present → cancel any pending delete prompt
          // left over from the delete half of a move. (issue #3)
          this.cancelPendingDeletion(fm.colab_share_id);
          // Debounce referenced-note checks to avoid API flooding
          if (this.refCheckTimer) clearTimeout(this.refCheckTimer);
          this.refCheckFile = file;
          this.refCheckTimer = setTimeout(() => {
            if (this.refCheckFile) this.checkReferencedNotes(this.refCheckFile);
            this.refCheckFile = null;
          }, 2000);
        } else {
          this.sharedNoteCache.delete(file.path);
        }

        const activeShareId = getShareSyncShareId(file.path);
        const encryptionKey = fm?.colab_encryption_key
          || (fm?.colab_link ? fm.colab_link.split('#')[1] : '');
        const hasEditableIdentity = fm?.colab_share_id === activeShareId
          && !!fm?.colab_link
          && !!encryptionKey
          && (fm?.colab_access === 'public_edit' || fm?.colab_access === 'invited_edit');
        if (activeShareId && !hasEditableIdentity) {
          stopShareSync(this.app, file.path);
          this.updateStatusBar();
        }
        if (!fm?.colab_share_id || !fm?.colab_link) {
          cancelSnapshot(file.path);
        }
        if (!fm?.colab_share_id) {
          this.duplicateSyncWarnings.delete(file.path);
        }
        this.app.workspace.updateOptions();
        if (this.isReadOnlyMirror(file)
            && this.app.workspace.getActiveFile()?.path === file.path) {
          void this.openReadOnlyMirrorInReadingView();
          void this.refreshReadOnlyMirror(file);
        }
      })
    );
  }

  private registerReadOnlyMirrorUi(): void {
    const editorFile = (view: EditorView): TFile | null => {
      const info: MarkdownFileInfo = view.state.field(editorInfoField);
      return info.file;
    };

    this.registerEditorExtension([
      EditorView.editable.compute([editorInfoField], (state) => {
        const file = state.field(editorInfoField).file;
        return !file || !this.isReadOnlyMirror(file);
      }),
      showPanel.compute([editorInfoField], (state) => {
        const file = state.field(editorInfoField).file;
        if (!file || !this.isReadOnlyMirror(file)) return null;
        return () => this.createReadOnlyPanel(file);
      }),
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          const file = editorFile(view);
          if (!file || !this.isReadOnlyMirror(file)) return false;
          const editingShortcut = (event.metaKey || event.ctrlKey)
            && ['v', 'x', 'z', 'y'].includes(event.key.toLowerCase());
          const editingKey = event.key.length === 1
            || ['Backspace', 'Delete', 'Enter', 'Tab'].includes(event.key);
          if (!editingShortcut && !editingKey) return false;
          this.promptReadOnlyEdit(file);
          return true;
        },
        paste: (_event, view) => {
          const file = editorFile(view);
          if (!file || !this.isReadOnlyMirror(file)) return false;
          this.promptReadOnlyEdit(file);
          return true;
        },
        drop: (_event, view) => {
          const file = editorFile(view);
          if (!file || !this.isReadOnlyMirror(file)) return false;
          this.promptReadOnlyEdit(file);
          return true;
        },
      }),
    ]);

    this.registerMarkdownPostProcessor((el, context) => {
      const file = this.app.vault.getFileByPath(context.sourcePath);
      if (!file || !this.isReadOnlyMirror(file)) return;
      const root = el.closest('.markdown-preview-view') || el;
      if (root.querySelector(':scope > .notecolab-read-only-banner')) return;
      root.prepend(this.createReadOnlyBanner(file));
    });
  }

  private async openReadOnlyMirrorInReadingView(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || !this.isReadOnlyMirror(view.file) || view.getMode() === 'preview') return;
    await view.setState({ ...view.getState(), mode: 'preview' }, { history: false });
  }

  private createReadOnlyPanel(file: TFile): Panel {
    return {
      top: true,
      dom: this.createReadOnlyBanner(file),
    };
  }

  private createReadOnlyBanner(file: TFile): HTMLElement {
    const banner = document.createElement('div');
    banner.className = 'notecolab-read-only-banner';
    banner.setCssStyles({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: '12px',
      padding: '8px 12px',
      borderBottom: '1px solid var(--background-modifier-border)',
      background: 'var(--background-secondary)',
    });

    const message = banner.createDiv();
    message.createEl('strong', { text: 'Read-only shared note' });
    const description = message.createDiv({
      text: 'Updates from the owner are applied automatically. Create a local copy to make changes.',
    });
    description.setCssStyles({ color: 'var(--text-muted)' });

    const actions = banner.createDiv();
    actions.setCssStyles({
      display: 'flex',
      flexWrap: 'wrap',
      gap: '6px',
      flexShrink: '0',
    });

    const remove = actions.createEl('button', { text: 'Delete & stop updates' });
    remove.addEventListener('click', () => this.confirmDeleteReadOnlyMirror(file));

    const copy = actions.createEl('button', {
      text: 'Create editable copy',
      cls: 'mod-cta',
    });
    copy.addEventListener('click', () => void this.createEditableCopy(file));
    return banner;
  }

  private isReadOnlyMirror(file: TFile): boolean {
    return isReadOnlyRecipient(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  private promptReadOnlyEdit(file: TFile): void {
    const now = Date.now();
    if (now - (this.readOnlyPromptedAt.get(file.path) || 0) < 3000) return;
    this.readOnlyPromptedAt.set(file.path, now);
    new ReadOnlyMirrorModal(
      this.app,
      file,
      () => void this.createEditableCopy(file),
      () => this.confirmDeleteReadOnlyMirror(file),
    ).open();
  }

  private async restoreReadOnlyMirrorName(file: TFile, oldPath: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(oldPath)) {
      this.promptReadOnlyEdit(file);
      return;
    }
    this.allowedReadOnlyRenames.add(oldPath);
    await this.app.fileManager.renameFile(file, oldPath);
    const restored = this.app.vault.getFileByPath(oldPath);
    if (restored) this.promptReadOnlyEdit(restored);
  }

  private async createEditableCopy(file: TFile): Promise<void> {
    if (!this.isReadOnlyMirror(file)) return;
    await this.refreshReadOnlyMirror(file);
    const content = stripColabMetadata(await this.app.vault.read(file));
    const folder = file.parent?.path || '';
    const basename = editableCopyBasename(file.basename);
    let path = normalizePath(folder ? `${folder}/${basename}.md` : `${basename}.md`);
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(
        folder
          ? `${folder}/${basename} (${counter}).md`
          : `${basename} (${counter}).md`,
      );
      counter++;
    }

    const copy = await this.app.vault.create(path, content);
    await this.app.workspace.getLeaf(false).openFile(copy);
    new Notice(`Created editable local copy: ${copy.basename}`);
  }

  private confirmDeleteReadOnlyMirror(file: TFile): void {
    if (!this.isReadOnlyMirror(file)) return;
    new DeleteReadOnlyMirrorModal(
      this.app,
      file,
      () => void this.deleteReadOnlyMirror(file),
    ).open();
  }

  private async deleteReadOnlyMirror(file: TFile): Promise<void> {
    if (!this.isReadOnlyMirror(file)) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;

    stopShareSync(this.app, file.path);
    cancelSnapshot(file.path);
    if (fm?.colab_share_id) {
      await this.apiFor(fm.colab_link).leaveSharedNote(fm.colab_share_id);
    }

    this.suppressedDeletionPrompts.add(file.path);
    await this.app.fileManager.trashFile(file);
    new Notice('Read-only mirror removed. The owner’s note was not affected.');
  }

  private async refreshReadOnlyMirror(file: TFile): Promise<void> {
    if (!this.isReadOnlyMirror(file) || this.refreshingReadOnlyMirrors.has(file.path)) return;
    const startingPath = file.path;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const roomId = fm?.colab_share_id;
    const linkShareId = fm?.colab_link_id || shareIdFromLink(fm?.colab_link) || roomId;
    const encryptionKey = fm?.colab_encryption_key
      || (fm?.colab_link ? fm.colab_link.split('#')[1] : '');
    if (!roomId || !linkShareId || !encryptionKey) return;

    this.refreshingReadOnlyMirrors.add(file.path);
    try {
      const api = this.apiFor(fm?.colab_link);
      const note = await api.getNoteContent(linkShareId);
      if (!note) return;

      if (note.accessMode !== 'read_only') {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          frontmatter.colab_access = note.accessMode;
          if (note.expiresAt) frontmatter.colab_expires = note.expiresAt;
          else delete frontmatter.colab_expires;
        });
        this.app.workspace.updateOptions();
        if (note.canEdit) void this.autoConnectShareSync();
        return;
      }

      const remoteBody = await decrypt(note.encryptedContent, encryptionKey);
      const current = await this.app.vault.read(file);
      const { frontmatter, body } = parseFrontmatter(current);
      const liveFm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!isReadOnlyRecipient(liveFm) || liveFm?.colab_share_id !== roomId) return;
      if (body !== remoteBody) {
        await this.app.vault.modify(file, frontmatter + remoteBody);
      }

      const imageNames = findImageEmbeds(remoteBody);
      const folder = file.parent?.path || '';
      await downloadMissingAssets(
        this.app,
        api,
        linkShareId,
        encryptionKey,
        imageNames,
        folder,
        file.path,
        () => this.isReadOnlyMirror(file),
      );

      let remoteTitle = note.title;
      if (note.encryptedTitle) {
        try {
          remoteTitle = await decrypt(note.encryptedTitle, encryptionKey);
        } catch {
          remoteTitle = null;
        }
      }
      const cleanTitle = remoteTitle ? sanitizeFilename(remoteTitle) : '';
      if (cleanTitle) {
        const ownerLabel = note.ownerUid
          ? this.settings.contacts.find((contact) => contact.uid === note.ownerUid)?.name
            || note.ownerUid
          : undefined;
        const basename = sharedNoteBasename(cleanTitle, ownerLabel);
        const folderPath = file.parent?.path || '';
        let targetPath = normalizePath(
          folderPath ? `${folderPath}/${basename}.md` : `${basename}.md`,
        );
        let counter = 1;
        while (targetPath !== file.path && this.app.vault.getAbstractFileByPath(targetPath)) {
          const counted = withFilenameCounter(basename, counter);
          targetPath = normalizePath(
            folderPath ? `${folderPath}/${counted}.md` : `${counted}.md`,
          );
          counter++;
        }
        if (targetPath !== file.path) {
          this.refreshingReadOnlyMirrors.add(targetPath);
          this.allowedReadOnlyRenames.add(targetPath);
          await this.app.fileManager.renameFile(file, targetPath);
        }
      }
    } catch (error) {
      console.warn(`NoteColab: failed to refresh read-only mirror ${file.path}:`, error);
    } finally {
      this.refreshingReadOnlyMirrors.delete(startingPath);
      this.refreshingReadOnlyMirrors.delete(file.path);
    }
  }

  shareCurrentNote(): void {
    if (!this.settings.apiKey) {
      new Notice('Connect to a Note Colab server in Settings → Note Colab before sharing');
      return;
    }

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('Open a note before sharing');
      return;
    }

    if (this.app.metadataCache.getFileCache(file)?.frontmatter?.colab_share_id) {
      new Notice('This note is already shared. Opening its sharing controls so you can resend it without creating a duplicate.');
      this.openManageLinks(file);
      return;
    }

    new ShareModalView(this.app, {
      accessMode: this.settings.defaultAccessMode,
      expiresIn: this.settings.defaultTtlSeconds,
      showHelp: false,
      theme: 'auto',
      showHeader: false,
      showControls: false,
      showChrome: false,
      collaborators: [],
    }, this.settings.contacts, async (opts) => {
      const result = await shareNote(this.app, this.api, this.settings, file, {
        accessMode: opts.accessMode,
        expiresIn: opts.accessMode === 'invited_edit' ? undefined : (opts.expiresIn || undefined),
        showHelp: opts.showHelp,
        theme: opts.theme,
        showHeader: opts.showHeader,
        showControls: opts.showControls,
        showChrome: opts.showChrome,
        collaborators: opts.collaborators,
      });
      // Auto-start sync for editable shares
      if (result && opts.accessMode !== 'read_only') {
        const key = result.shareUrl.split('#')[1] || '';
        await startShareSync(this.app, this.settings, file, result.shareId, this.api, key);
      }
      // Upload vault key for web dashboard access
      if (result && this.settings.vaultKey) {
        try {
          const { encryptWithVaultKey } = await import('./crypto/crypto');
          const noteKey = result.shareUrl.split('#')[1] || '';
          if (noteKey) {
            const encrypted = await encryptWithVaultKey(noteKey, this.settings.vaultKey);
            await this.api.uploadVaultKeys([{ noteShareId: result.shareId, encryptedKey: encrypted }]);
          }
        } catch (e) {
          console.warn('Failed to upload vault key for new share:', e);
        }
      }
      // After uploading content + images, check whether storage is full.
      if (result) {
        this.settings.sharedNoteCount += 1;
        await this.saveSettings();
        void this.maybeWarnStorage(true);
        if (this.settings.usernamePromptState === 'after_shares' && this.settings.sharedNoteCount >= 3) {
          void this.maybePromptForUsername('after_shares');
        }
      }
      // For invite-only: generate an invite link and copy it
      if (result && opts.accessMode === 'invited_edit') {
        const inviteResult = await this.api.createInviteLink(result.shareId);
        if (inviteResult?.token) {
          const encKey = result.shareUrl.split('#')[1] || '';
          const inviteUrl = `${this.settings.serverUrl}/invite/${inviteResult.token}#${encKey}`;
          await navigator.clipboard.writeText(inviteUrl);
          new Notice('Invite link copied to clipboard!\nShare it with anyone you want to invite.');
        }
      }
    }).open();
  }

  private openManageLinks(file: TFile): void {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.colab_share_id) return;

    const encKey = fm.colab_encryption_key ||
      (fm.colab_link ? fm.colab_link.split('#')[1] : '');
    if (!encKey) {
      new Notice('Encryption key not found. Re-share the note to fix this.');
      return;
    }

    let serverUrl = this.settings.serverUrl;
    if (fm.colab_link) {
      try {
        serverUrl = new URL(fm.colab_link).origin;
      } catch {
        // Keep the configured server for malformed legacy frontmatter.
      }
    }

    new ManageLinksModalView(
      this.app,
      this.apiFor(fm.colab_link),
      fm.colab_share_id,
      encKey,
      serverUrl,
      this.settings.contacts,
      this.settings.secretKey
    ).open();
  }

  private async publishRenamedTitle(file: TFile): Promise<void> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.colab_share_id || !mayPublishAsOwner(fm)) return;

    const encKey = fm.colab_encryption_key ||
      (fm.colab_link ? fm.colab_link.split('#')[1] : '');
    if (!encKey) return;

    try {
      const encryptedTitle = await encrypt(file.basename, encKey);
      const linkShareId = fm.colab_link_id || shareIdFromLink(fm.colab_link) || fm.colab_share_id;
      const updated = await this.apiFor(fm.colab_link).updateNote(
        linkShareId,
        { encryptedTitle }
      );
      if (updated) this.refreshDashboard();
    } catch (e) {
      console.warn(`Colab: failed to publish renamed title for ${file.path}:`, e);
    }
  }

  onunload() {
    if (this.statusBarInterval) clearInterval(this.statusBarInterval);
    if (this.pendingSharesInterval) clearInterval(this.pendingSharesInterval);
    if (this.readOnlyRefreshInterval) clearInterval(this.readOnlyRefreshInterval);
    if (this.refCheckTimer) clearTimeout(this.refCheckTimer);
    for (const timer of this.pendingDeletions.values()) clearTimeout(timer);
    this.pendingDeletions.clear();
    destroyAllShareSyncs(this.app);
  }

  async loadSettings() {
    const saved = await this.loadData() as Partial<ColabSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.pinnedPublicKeys = { ...(saved?.pinnedPublicKeys || {}) };
    this.settings.usernamePromptState = initialUsernamePromptState(saved);
    if (saved?.serverUrl && migrateOfficialServerUrl(saved.serverUrl) !== saved.serverUrl) {
      this.settings.serverUrl = migrateOfficialServerUrl(saved.serverUrl);
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async maybePromptForUsername(reason: 'upgrade' | 'after_shares'): Promise<void> {
    if (this.usernamePromptOpen || !this.settings.apiKey || this.settings.usernamePromptState === 'done') return;
    if (reason === 'after_shares' && this.settings.sharedNoteCount < 3) return;

    const profile = await this.api.getMyProfile();
    if (profile?.displayName) {
      this.settings.username = profile.displayName;
      this.settings.usernamePromptState = 'done';
      await this.saveSettings();
      return;
    }

    this.usernamePromptOpen = true;
    new UsernamePromptModal(
      this.app,
      reason,
      async (username) => {
        const result = await this.api.setUsername(username);
        if (!result?.ok) return false;
        this.settings.username = result.username || '';
        return true;
      },
      async () => {
        this.usernamePromptOpen = false;
        this.settings.usernamePromptState = 'done';
        await this.saveSettings();
      },
    ).open();
  }

  async activateDashboardView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  refreshDashboard() {
    const leaves = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof DashboardView) {
        view.loadData();
      }
    }
  }

  /**
   * The API client a shared note should use. When the note's `colab_link` was
   * minted on a different server than the configured one, return a client
   * scoped to that origin; otherwise the default client. The note is already in
   * the vault (import was confirmed), so reconnecting to its origin needs no
   * re-prompt. (issue #8)
   */
  private apiFor(link?: string): ApiClient {
    const origin = foreignOrigin(link, this.settings.serverUrl);
    return origin ? this.api.withBaseUrl(origin) : this.api;
  }

  private async autoConnectShareSync() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    // Check frontmatter for share info
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    const activeShareId = getShareSyncShareId(file.path);
    if (activeShareId) {
      const encryptionKey = fm?.colab_encryption_key
        || (fm?.colab_link ? fm.colab_link.split('#')[1] : '');
      const stillValid = fm?.colab_share_id === activeShareId
        && !!fm?.colab_link
        && !!encryptionKey
        && (fm?.colab_access === 'public_edit' || fm?.colab_access === 'invited_edit');
      if (stillValid) return;
      stopShareSync(this.app, file.path);
      this.updateStatusBar();
    }
    if (!fm?.colab_share_id || !fm?.colab_link) return;
    // Only auto-sync editable shares
    if (fm.colab_access !== 'public_edit' && fm.colab_access !== 'invited_edit') return;
    // Skip if link is locally known to be expired (invited_edit never expires)
    if (fm.colab_access !== 'invited_edit' && fm.colab_expires) {
      if (new Date(fm.colab_expires) < new Date()) return;
    }
    const encKey = fm.colab_encryption_key ||
      (fm.colab_link ? fm.colab_link.split('#')[1] : '');
    if (!encKey) return;
    const origin = foreignOrigin(fm.colab_link, this.settings.serverUrl);
    const linkShareId = fm.colab_link_id || shareIdFromLink(fm.colab_link) || fm.colab_share_id;
    const existingPath = getShareSyncPathByShareId(fm.colab_share_id);
    if (existingPath && existingPath !== file.path) {
      if (!this.duplicateSyncWarnings.has(file.path)) {
        this.duplicateSyncWarnings.add(file.path);
        new Notice(`Colab: this is a duplicate of the syncing note at "${existingPath}". It was not connected.`);
      }
      return;
    }
    this.duplicateSyncWarnings.delete(file.path);
    await startShareSync(
      this.app, this.settings, file, fm.colab_share_id,
      this.apiFor(fm.colab_link), encKey, origin || undefined, linkShareId
    );
  }

  /**
   * Publish a read-only share's latest content to the server.
   *
   * Read-only shares have no live Yjs sync (edit shares persist via their own
   * sync handler), so this is the only way Obsidian edits reach the web. Safe to
   * call on open and on every modify — publishSnapshot debounces and skips when
   * the body is unchanged.
   */
  private maybePublishReadOnly(file: TFile) {
    // Edit shares persist through their active sync; don't double-publish.
    if (getShareSync(file.path)) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.colab_share_id || fm.colab_access !== 'read_only' || !mayPublishAsOwner(fm)) return;
    // Skip if the link is locally known to be expired.
    if (fm.colab_expires && new Date(fm.colab_expires) < new Date()) return;
    const encKey = fm.colab_encryption_key ||
      (fm.colab_link ? fm.colab_link.split('#')[1] : '');
    if (!encKey) return;
    const linkShareId = fm.colab_link_id || shareIdFromLink(fm.colab_link) || fm.colab_share_id;
    publishSnapshot(
      this.app,
      this.apiFor(fm.colab_link),
      file,
      fm.colab_share_id,
      encKey,
      800,
      linkShareId,
    );
  }

  private updateStatusBar() {
    if (!this.statusBarItem) return;

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.statusBarItem.setText('');
      return;
    }

    const status = getShareSyncStatus(file.path);
    if (this.isReadOnlyMirror(file)) {
      this.statusBarItem.setText(
        this.refreshingReadOnlyMirrors.has(file.path)
          ? 'Colab: read-only · updating…'
          : 'Colab: read-only · synced',
      );
      this.statusBarItem.setCssStyles({ color: '' });
    } else if (status === 'connected') {
      this.statusBarItem.setText('Colab: syncing');
      this.statusBarItem.setCssStyles({ color: '' });
    } else if (status === 'connecting') {
      this.statusBarItem.setText('Colab: connecting…');
      this.statusBarItem.setCssStyles({ color: '' });
    } else if (status === 'disconnected') {
      this.statusBarItem.setText('Colab: disconnected');
      this.statusBarItem.setCssStyles({ color: '' });
    } else {
      this.statusBarItem.setText('');
    }
  }

  private rebuildSharedNoteCache() {
    this.sharedNoteCache.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (fm?.colab_share_id) {
        this.sharedNoteCache.set(file.path, {
          shareId: fm.colab_share_id,
          title: file.basename,
          ownership: shareOwnership(fm),
          link: fm.colab_link,
        });
      }
    }
  }

  private async checkPendingShares() {
    if (!this.settings.apiKey || !this.settings.secretKey) return;

    try {
      const pending = await this.api.getPendingShares();
      if (pending.length === 0) return;

      for (const ps of pending) {
        // Check if we already have this note imported
        const existingFile = this.app.vault.getMarkdownFiles().find((f) => {
          const cache = this.app.metadataCache.getFileCache(f);
          return cache?.frontmatter?.colab_share_id === ps.shareId;
        });

        if (existingFile) {
          // Already imported, just acknowledge
          await this.api.ackPendingShare(ps.id);
          continue;
        }

        // Decrypt the AES key using our secret key + sender's public key
        let senderInfo;
        try {
          senderInfo = await this.api.getPublicKey(ps.senderUid);
        } catch (error) {
          if (error instanceof DirectoryKeyChangedError) {
            console.error(error.message);
            if (!this.warnedChangedIdentityKeys.has(ps.senderUid)) {
              this.warnedChangedIdentityKeys.add(ps.senderUid);
              new Notice(`${error.message}. Verify it with the sender, then reset its pin in Note Colab settings.`, 15_000);
            }
            continue;
          }
          throw error;
        }
        if (!senderInfo?.publicKey) {
          console.warn(`Cannot decrypt pending share from ${ps.senderUid}: no public key`);
          continue;
        }

        const noteKey = decryptKeyFromSender(
          ps.encryptedKey,
          ps.nonce,
          senderInfo.publicKey,
          this.settings.secretKey
        );

        if (!noteKey) {
          console.warn(`Failed to decrypt pending share key from ${ps.senderUid}`);
          continue;
        }

        const senderName = this.settings.contacts.find((c) => c.uid === ps.senderUid)?.name
          || ps.senderName
          || ps.senderUid.substring(0, 12) + '...';
        let noteTitle = ps.title || 'Encrypted note';
        if (ps.encryptedTitle) {
          try {
            noteTitle = await decrypt(ps.encryptedTitle, noteKey);
          } catch {
            noteTitle = ps.title || 'Encrypted note';
          }
        }

        if (this.settings.autoImport) {
          // User opted into auto-accept — import without prompting.
          const shareUrl = `${this.settings.serverUrl}/s/${ps.shareId}#${noteKey}`;
          const imported = await importNote(this.app, this.api, shareUrl, {
            settings: this.settings,
            saveSettings: () => this.saveSettings(),
          });
          if (imported) {
            await this.api.ackPendingShare(ps.id);
            const behavior = ps.accessMode === 'read_only'
              ? 'auto-imported as a read-only mirror'
              : 'auto-imported with editing enabled';
            new Notice(`Colab: "${noteTitle}" shared by ${senderName} — ${behavior}.`);
          }
        } else if (!this.promptedPendingShares.has(ps.id)) {
          // Queue an accept/deny popup so the user explicitly decides.
          this.promptedPendingShares.add(ps.id);
          this.incomingShareQueue.push({
            id: ps.id,
            shareId: ps.shareId,
            noteKey,
            senderName,
            senderUid: ps.senderUid,
            title: noteTitle,
            accessMode: ps.accessMode,
          });
        }
      }

      // Surface any queued shares (one popup at a time).
      this.processIncomingShareQueue();
    } catch (e) {
      // Silently fail — will retry next poll
      console.warn('Failed to check pending shares:', e);
    }

    // Refresh dashboard view if open
    this.refreshDashboard();
  }

  /** Show the next queued incoming-share popup, if no popup is already open. */
  private processIncomingShareQueue() {
    if (this.showingIncomingModal) return;
    const next = this.incomingShareQueue.shift();
    if (!next) return;

    this.showingIncomingModal = true;
    new IncomingShareModal(
      this.app,
      {
        senderName: next.senderName,
        senderUid: next.senderUid,
        title: next.title,
        accessMode: next.accessMode,
      },
      (decision) => {
        this.showingIncomingModal = false;
        void this.resolveIncomingShare(next, decision);
      }
    ).open();
  }

  /** Apply the user's accept/deny decision, then drain the rest of the queue. */
  private async resolveIncomingShare(share: IncomingShare, decision: ShareDecision) {
    try {
      if (decision === 'accept') {
        const shareUrl = `${this.settings.serverUrl}/s/${share.shareId}#${share.noteKey}`;
        const imported = await importNote(this.app, this.api, shareUrl, {
          settings: this.settings,
          saveSettings: () => this.saveSettings(),
        });
        if (imported) {
          await this.api.ackPendingShare(share.id);
        } else {
          new Notice(`Colab: couldn't import "${share.title}". The invitation remains pending.`);
        }
      } else if (decision === 'deny') {
        await this.api.dismissPendingShare(share.id);
        new Notice(`Colab: declined "${share.title}".`);
      }
      // 'later' — leave it pending; it stays in the dashboard for next time.
    } catch (e) {
      console.warn('Colab: failed to resolve incoming share:', e);
      new Notice(`Colab: couldn't process "${share.title}". It will remain pending.`);
    } finally {
      this.refreshDashboard();
      this.processIncomingShareQueue();
    }
  }

  /**
   * Warn the user when their server storage is nearly or completely full.
   *
   * Throttled to one check every 5 minutes (pass force=true to check now, e.g.
   * right after sharing). Only shows a notice when usage crosses into a worse
   * level, so it won't nag on every check.
   */
  private async maybeWarnStorage(force = false): Promise<void> {
    if (!this.settings.apiKey) return;
    const now = Date.now();
    if (!force && now - this.lastStorageCheck < 5 * 60_000) return;
    this.lastStorageCheck = now;

    let storage;
    try {
      storage = await this.api.getMyStorage();
    } catch {
      return;
    }
    if (!storage) return;
    // Unlimited (self-hosted) servers have no quota to warn about.
    if (storage.unlimited) return;

    const pct = storage.usagePercent;
    const level: StorageLevel = pct >= 95 ? 'full' : pct >= 80 ? 'warn' : 'ok';
    const used = `${formatBytes(storage.totalBytes)} / ${formatBytes(storage.storageLimit)}`;
    const relief = 'Free up space by deleting shared notes. Open Note Colab settings to see whether this server offers upgrades.';

    // Only notify when usage gets worse than last time we warned.
    const rank = { ok: 0, warn: 1, full: 2 };
    if (rank[level] > rank[this.lastStorageLevel]) {
      if (level === 'full') {
        new Notice(
          `Colab: storage almost full (${pct}% — ${used}). New shares and images may fail. ${relief}`,
          0
        );
      } else if (level === 'warn') {
        new Notice(`Colab: storage ${pct}% full (${used}). ${relief}`, 10_000);
      }
    }
    this.lastStorageLevel = level;
  }

  /** Scan a synced note for [[wikilinks]] to unshared notes and prompt to share them */
  private async checkReferencedNotes(file: TFile) {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm?.colab_share_id || fm.colab_access === 'read_only') return;

    // Get collaborators for this note
    const collabs = await this.api.listCollaborators(fm.colab_share_id);
    if (collabs.length === 0) return;

    // Find all [[wikilinks]] in the note
    const links = cache?.links || [];
    for (const link of links) {
      const linkedFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
      if (!linkedFile || !(linkedFile as TFile).extension) continue;
      if ((linkedFile as TFile).extension !== 'md') continue;

      // Check if linked note is already shared
      const linkedCache = this.app.metadataCache.getFileCache(linkedFile as TFile);
      if (linkedCache?.frontmatter?.colab_share_id) continue;

      // Don't prompt for the same link twice in this session
      const promptKey = `${file.path}::${linkedFile.path}`;
      if (this.promptedLinks.has(promptKey)) continue;
      this.promptedLinks.add(promptKey);

      // Prompt
      const collabNames = collabs.map((c) => {
        const contact = this.settings.contacts.find((ct) => ct.uid === c.uid);
        return contact?.name || c.uid.substring(0, 8) + '...';
      }).join(', ');

      new Notice(
        `Colab: "${file.basename}" links to "${linkedFile.name.replace('.md', '')}". ` +
        `Share it with ${collabNames}?\n` +
        `Use "Colab: Share note" on that note to share.`,
        15000
      );
    }
  }

  private handleFileDelete(file: TFile) {
    const cached = this.sharedNoteCache.get(file.path);
    if (!cached) return;

    // Remove from cache immediately
    this.sharedNoteCache.delete(file.path);

    // Stop any active sync and cancel pending snapshot publishes
    stopShareSync(this.app, file.path);
    cancelSnapshot(file.path);
    if (this.suppressedDeletionPrompts.delete(file.path)) return;
    if (cached.ownership === 'recipient') {
      void this.apiFor(cached.link).leaveSharedNote(cached.shareId);
      new Notice('Shared note removed from this vault. The owner’s note was not affected.');
      return;
    }
    if (cached.ownership === 'unknown') {
      // Notes shared before 1.24.2 carry no owner marker. Leaving is rejected for
      // an owner (400), so the server decides which path this note belongs to.
      void this.leaveOrPromptDeletion(cached);
      return;
    }

    this.deferDeletionPrompt(cached);
  }

  /** Leave an unmarked shared note; fall back to the owner prompt if we own it. */
  private async leaveOrPromptDeletion(
    cached: { shareId: string; title: string; link?: string },
  ): Promise<void> {
    const left = await this.apiFor(cached.link).leaveSharedNote(cached.shareId);
    if (left) {
      new Notice('Shared note removed from this vault. The owner’s note was not affected.');
      return;
    }
    this.deferDeletionPrompt(cached);
  }

  private deferDeletionPrompt(cached: { shareId: string; title: string }) {
    // A move can surface as a delete (old path) followed by a create (new path)
    // — e.g. via Obsidian Sync or an OS-level move. Defer the prompt so a
    // re-created copy of the same share can cancel it; only a note that stays
    // gone is a real deletion. (issue #3)
    const prev = this.pendingDeletions.get(cached.shareId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.pendingDeletions.delete(cached.shareId);
      // The share reappeared elsewhere in the vault → it was moved, not deleted.
      if (this.isShareIdInVault(cached.shareId)) return;
      this.promptDeleteFromServer(cached.shareId, cached.title);
    }, 1500);
    this.pendingDeletions.set(cached.shareId, timer);
  }

  /** Cancel a deferred "delete from server?" prompt (the note came back — a move). */
  private cancelPendingDeletion(shareId: string) {
    const timer = this.pendingDeletions.get(shareId);
    if (timer) {
      clearTimeout(timer);
      this.pendingDeletions.delete(shareId);
    }
  }

  /** True if any note in the vault still carries this share id (i.e. not deleted). */
  private isShareIdInVault(shareId: string): boolean {
    for (const cached of this.sharedNoteCache.values()) {
      if (cached.shareId === shareId) return true;
    }
    // The cache may not have caught up with a just-created copy yet — scan
    // frontmatter directly as the authoritative check.
    for (const f of this.app.vault.getMarkdownFiles()) {
      const sid = this.app.metadataCache.getFileCache(f)?.frontmatter?.colab_share_id;
      if (sid === shareId) return true;
    }
    return false;
  }

  private promptDeleteFromServer(shareId: string, title: string) {
    new DeleteConfirmModal(this.app, title, async (deleteFromServer) => {
      if (deleteFromServer) {
        const ok = await this.api.deleteNote(shareId);
        if (ok) {
          new Notice(`"${title}" deleted from server`);
        } else {
          new Notice('Failed to delete from server. You can try again from the Note Colab dashboard.');
        }
      }
    }).open();
  }
}

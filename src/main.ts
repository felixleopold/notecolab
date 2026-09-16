import {
  Menu,
  Notice,
  Plugin,
  MarkdownView,
  editorInfoField,
  normalizePath,
  setIcon,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { EditorView, showPanel, type Panel } from '@codemirror/view';
import { liveCursors } from './collaboration/liveCursors';
import { DEFAULT_SETTINGS, OFFICIAL_SERVER_URL, initialOnboardingState, initialUsernamePromptState, isOfficialServerAlias, migrateOfficialServerUrl, type ColabSettings, type FolderSubscription } from './types';
import { ApiClient } from './api/client';
import { shareNote, revokeShare, copyShareLink } from './share/shareNote';
import { importNote, foreignOrigin } from './share/importNote';
import { onShareSyncChange, startShareSync, getShareSync, getShareSyncShareId, getShareSyncPathByShareId, getShareSyncStatus, getShareSaveState, stopShareSync, destroyAllShareSyncs, publishSnapshot, cancelSnapshot, renameShareSync, parseFrontmatter, recoverPreviousSnapshot } from './session/sessions';
import { generateKeyPair, decryptKeyFromSender } from './crypto/keyExchange';
import { DirectoryKeyChangedError } from './crypto/identityTrust';
import { decrypt, encrypt, deriveRoomToken } from './crypto/crypto';
import { websocketCredentials } from './api/credentials';
import { NotePresence, isForeground } from './session/presence';
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
import { noteColabFrontmatter } from './share/frontmatter';
import { OnboardingModal } from './ui/OnboardingModal';
import { requestErrorMessage } from './api/errors';
import { publishFolder, type FolderShareState } from './share/folderShare';
import { FolderShareSync } from './share/folderSync';
import { importFolderShare, loadFolderShare, type LoadedFolderShare } from './share/folderImport';
import { FolderPublishPreviewModal, FolderShareModal, type FolderShareChoice } from './ui/FolderShareModal';
import {
  FolderImportLinkModal,
  FolderImportPreviewModal,
  FolderSubscriptionPromptModal,
  FolderSubscriptionsModal,
  FolderUpdatePreviewModal,
} from './ui/FolderImportModal';
import { FolderProgressModal } from './ui/FolderProgressModal';
import { RecoveryConfirmModal } from './ui/RecoveryConfirmModal';

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
  private statusBarInterval: number | null = null;
  private presence: NotePresence | null = null;
  private presenceIdentity = '';
  private presenceProvider: NonNullable<ReturnType<typeof getShareSync>>['provider'] | undefined;
  private presenceWindows = new WeakSet<Window>();
  private pendingSharesInterval: number | null = null;
  // Cache shared note info so we can prompt on delete (frontmatter gone after deletion)
  private sharedNoteCache = new Map<string, {
    shareId: string;
    title: string;
    ownership: ShareOwnership;
    link?: string;
  }>();
  // Deferred "delete from server?" prompts, keyed by shareId. A move can surface
  // as a delete+create pair; deferring lets the re-created copy cancel the prompt.
  private pendingDeletions = new Map<string, number>();
  // Track which [[wikilinks]] we've already prompted about
  private promptedLinks = new Set<string>();
  private refCheckTimer: number | null = null;
  private refCheckFile: TFile | null = null;
  // Incoming-share accept/deny queue (one popup shown at a time)
  private incomingShareQueue: IncomingShare[] = [];
  private promptedPendingShares = new Set<number>();
  private warnedChangedIdentityKeys = new Set<string>();
  private showingIncomingModal = false;
  private duplicateSyncWarnings = new Set<string>();
  private readOnlyRefreshInterval: number | null = null;
  private refreshingReadOnlyMirrors = new Set<string>();
  private suppressedDeletionPrompts = new Set<string>();
  private allowedReadOnlyRenames = new Set<string>();
  // Storage warnings — throttle checks and only re-warn when usage worsens
  private lastStorageCheck = 0;
  private lastStorageLevel: StorageLevel = 'ok';
  private usernamePromptOpen = false;
  private automaticConnection: Promise<boolean> | null = null;
  private automaticConnectionError: string | null = null;
  private onboardingOpen = false;
  private folderShareSync: FolderShareSync | null = null;
  private folderSubscriptionInterval: number | null = null;
  private checkingFolderSubscriptions = false;
  private pendingFolderSubscriptionPrompts = new Set<string>();

  async onload() {
    await this.loadSettings();
    this.api = new ApiClient(this.settings, () => this.saveSettings());
    this.registerEditorExtension(liveCursors(() => this.settings.username));
    this.folderShareSync = new FolderShareSync(this.app, () => new ApiClient({ ...this.settings }), {
      getServerUrl: () => this.settings.serverUrl,
      getOwnerUid: () => this.settings.uid,
      getStates: () => this.settings.folderShares.filter((state) => this.folderShareUsesCurrentServer(state)),
      saveState: (state) => this.saveFolderShareState(state),
      canPublishEditable: (path) => getShareSyncStatus(path) === 'connected',
      onResult: (result) => {
        if (result.failed.length) console.warn('NoteColab: automatic folder publish needs attention', result.failed);
      },
    });
    this.folderShareSync.start();

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
    const showParticipants = (event?: MouseEvent) => {
      const roster = this.presence?.roster;
      if (!roster) return;
      const menu = new Menu();
      for (const person of roster.participants) {
        menu.addItem(item => item.setTitle(
          `${person.id === roster.selfId ? 'You' : person.name} · ${person.client === 'web' ? 'Web' : 'Obsidian'}`,
        ).setDisabled(true));
      }
      if (!roster.participants.length) menu.addItem(item => item.setTitle('No one here').setDisabled(true));
      if (event) menu.showAtMouseEvent(event);
      else if (this.statusBarItem) {
        const rect = this.statusBarItem.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.top });
      }
    };
    this.registerDomEvent(this.statusBarItem, 'click', event => showParticipants(event));
    this.registerDomEvent(this.statusBarItem, 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showParticipants();
      }
    });
    this.register(onShareSyncChange(() => this.updateStatusBar()));
    this.watchPresenceWindow(window);
    this.registerEvent(this.app.workspace.on('window-open', (_workspaceWindow, openedWindow) => {
      this.watchPresenceWindow(openedWindow);
    }));
    this.updateStatusBar();

    // Register dashboard view
    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf) => new DashboardView(leaf, this)
    );

    // Ribbon icon to open dashboard
    this.addRibbonIcon('share-2', 'Note Colab dashboard', () => {
      void this.activateDashboardView();
    });

    // Settings tab
    this.addSettingTab(new ColabSettingsTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.usernamePromptState === 'upgrade') {
        void this.maybePromptForUsername('upgrade');
      }
      void this.maybeStartOnboarding();
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

        void this.shareCurrentNote();
      },
    });

    this.addCommand({
      id: 'import-shared-note',
      name: 'Import shared note',
      callback: () => {
        new ImportModal(this.app, (url) => {
          void importNote(this.app, this.api, url, {
            settings: this.settings,
            saveSettings: () => this.saveSettings(),
          });
        }).open();
      },
    });

    this.addCommand({
      id: 'share-folder',
      name: 'Share folder',
      callback: () => new FolderShareModal(this.app, (choice) => {
        void this.reviewAndPublishFolder(choice);
      }).open(),
    });

    this.addCommand({
      id: 'import-shared-folder',
      name: 'Import shared folder',
      callback: () => new FolderImportLinkModal(this.app, (url) => {
        void this.previewAndImportFolder(url);
      }).open(),
    });

    this.addCommand({
      id: 'manage-shared-folder-subscriptions',
      name: 'Manage watched shared folders',
      callback: () => new FolderSubscriptionsModal(
        this.app,
        this.settings.folderSubscriptions,
        this.settings.folderShares.filter((state) => this.folderShareUsesCurrentServer(state)),
        (manifestUrl) => { void this.unsubscribeFolder(manifestUrl); },
        (state, watching) => { void this.setFolderShareWatching(state, watching); },
      ).open(),
    });

    this.addCommand({
      id: 'recover-previous-shared-note-version',
      name: 'Recover previous shared note version to new file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const fm = file && noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
        if (!file || !fm?.colab_share_id || !fm.colab_encryption_key || fm.colab_access === 'read_only') return false;
        if (!checking) {
          new RecoveryConfirmModal(this.app, () => { void this.recoverSharedNoteVersion(file); }).open();
        }
        return true;
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

        void revokeShare(this.app, this.api, file);
      },
    });

    this.addCommand({
      id: 'copy-share-link',
      name: 'Copy share link',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;

        void copyShareLink(this.app, file);
      },
    });

    this.addCommand({
      id: 'manage-links',
      name: 'Manage shared links',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter)?.colab_share_id) return false;
        if (checking) return true;

        void this.openManageLinks(file);
      },
    });

    this.addCommand({
      id: 'open-dashboard',
      name: 'Open dashboard',
      callback: () => {
        void this.activateDashboardView();
      },
    });



    // --- Detect local deletion of shared notes ---
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) {
          void this.handleFileDelete(file);
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
        if (!allowedReadOnlyRename && file instanceof TFile) {
          const markdownFile = file;
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
            title: file instanceof TFile ? file.basename : cached.title,
          });
          this.cancelPendingDeletion(cached.shareId);
        }
        if (file instanceof TFile) {
          void this.publishRenamedTitle(file);
        }
      })
    );

    // --- Publish edits of read-only shares to the web ---
    // Read-only shares have no live Yjs sync, so the stored snapshot is the only
    // thing the web ever sees. Re-encrypt and PATCH it whenever the file changes.
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          void this.maybePublishReadOnly(file);
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
        void this.updateStatusBar();
        void this.autoConnectShareSync();
        const file = this.app.workspace.getActiveFile();
        if (file) {
          this.maybePublishReadOnly(file);
          void this.refreshReadOnlyMirror(file);
        }
      })
    );

    // Auto-connect share sync for any already-open shared note
    this.app.workspace.onLayoutReady(() => {
      void this.autoConnectShareSync();
      const file = this.app.workspace.getActiveFile();
      if (file) {
        this.maybePublishReadOnly(file);
        void this.refreshReadOnlyMirror(file);
      }
    });

    // Periodically refresh status bar to reflect WS state changes
    this.statusBarInterval = window.setInterval(() => this.updateStatusBar(), 3000);
    this.readOnlyRefreshInterval = window.setInterval(() => {
      const file = this.app.workspace.getActiveFile();
      if (file) void this.refreshReadOnlyMirror(file);
    }, 30_000);

    // Poll for pending shares and storage usage (storage check self-throttles)
    this.pendingSharesInterval = window.setInterval(() => {
      void this.checkPendingShares();
      void this.maybeWarnStorage();
    }, 60_000);
    // Check once on startup (with a short delay to let the vault load)
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => {
        void this.checkPendingShares();
        void this.maybeWarnStorage();
        void this.checkFolderSubscriptions();
      }, 5000);
    });
    this.folderSubscriptionInterval = window.setInterval(
      () => { void this.checkFolderSubscriptions(); },
      5 * 60_000,
    );

    // Build initial shared note cache for delete detection
    this.app.workspace.onLayoutReady(() => {
      this.rebuildSharedNoteCache();
    });

    // Keep cache up-to-date when frontmatter changes
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = noteColabFrontmatter(cache?.frontmatter);
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
          if (this.refCheckTimer) window.clearTimeout(this.refCheckTimer);
          this.refCheckFile = file;
          this.refCheckTimer = window.setTimeout(() => {
            if (this.refCheckFile) void this.checkReferencedNotes(this.refCheckFile);
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
          void this.refreshReadOnlyMirror(file);
        }
      })
    );
  }

  private registerReadOnlyMirrorUi(): void {
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
    ]);

    this.registerMarkdownPostProcessor((el, context) => {
      const file = this.app.vault.getFileByPath(context.sourcePath);
      const readingView = el.closest('.markdown-reading-view');
      if (!file || !this.isReadOnlyMirror(file)) {
        readingView?.querySelectorAll('.notecolab-read-only-banner').forEach((banner) => banner.remove());
        return;
      }
      const mountBanner = () => {
        // Obsidian scrolls the reading-view container, not the rendered
        // Markdown child. The banner must be a direct child of that scroller
        // for position: sticky to follow the viewport.
        const root = el.closest('.markdown-reading-view');
        if (!root) return false;
        const existing = root.querySelector<HTMLElement>('.notecolab-read-only-banner');
        if (existing?.dataset.path === file.path) return true;
        existing?.remove();
        root.prepend(this.createReadOnlyBanner(file));
        return true;
      };
      if (!mountBanner()) {
        window.requestAnimationFrame(() => mountBanner());
      }
    });

    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        window.requestAnimationFrame(() => this.removeStaleReadOnlyBanner());
      }),
    );
    this.app.workspace.onLayoutReady(() => this.removeStaleReadOnlyBanner());
  }

  private removeStaleReadOnlyBanner(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || this.isReadOnlyMirror(view.file)) return;
    view.containerEl
      .querySelectorAll('.notecolab-read-only-banner')
      .forEach((banner) => banner.remove());
  }

  private createReadOnlyPanel(file: TFile): Panel {
    return {
      top: true,
      dom: this.createReadOnlyBanner(file),
    };
  }

  private createReadOnlyBanner(file: TFile): HTMLElement {
    const banner = createDiv();
    banner.className = 'notecolab-read-only-banner';
    banner.dataset.path = file.path;
    banner.setCssStyles({
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '10px',
      padding: '8px 12px',
      borderBottom: '1px solid var(--background-modifier-border)',
      background: 'var(--background-secondary)',
      position: 'sticky',
      top: '0',
      zIndex: '1',
    });

    const lock = banner.createSpan();
    setIcon(lock, 'lock');
    lock.setCssStyles({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '28px',
      height: '28px',
      borderRadius: 'var(--radius-s)',
      background: 'var(--background-modifier-hover)',
      flexShrink: '0',
    });

    const message = banner.createDiv();
    message.setCssStyles({ flex: '1 1 280px', minWidth: '0' });
    const heading = message.createDiv();
    heading.setCssStyles({ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' });
    heading.createEl('strong', { text: 'Read-only mirror' });
    const status = heading.createSpan({ cls: 'notecolab-read-only-status' });
    status.setCssStyles({ color: 'var(--color-green)', fontSize: 'var(--font-ui-smaller)' });
    const description = message.createDiv({
      text: 'Updates from the owner sync automatically. Any changes to this file are temporary and will be replaced by the owner’s version.',
    });
    description.setCssStyles({ color: 'var(--text-muted)', fontSize: 'var(--font-ui-smaller)' });

    const actions = banner.createDiv();
    actions.setCssStyles({
      display: 'flex',
      gap: '6px',
      flexShrink: '0',
    });

    const copy = actions.createEl('button', {
      text: 'Make a copy',
      cls: 'mod-cta',
    });
    copy.addEventListener('click', () => void this.createEditableCopy(file));

    const more = actions.createEl('button', {
      attr: {
        'aria-label': 'More actions for read-only mirror',
        'data-tooltip-position': 'top',
      },
    });
    setIcon(more, 'more-horizontal');
    more.addEventListener('click', (event) => {
      const menu = new Menu();
      menu.addItem((item) => item
        .setTitle('Delete and stop updates')
        .setIcon('trash-2')
        .onClick(() => this.confirmDeleteReadOnlyMirror(file)));
      menu.showAtMouseEvent(event);
    });

    this.updateReadOnlyBanner(banner, file.path);
    return banner;
  }

  private updateReadOnlyBanner(banner: HTMLElement, path: string): void {
    const status = banner.querySelector<HTMLElement>('.notecolab-read-only-status');
    if (!status) return;
    status.setText(this.refreshingReadOnlyMirrors.has(path) ? 'Updating…' : 'Read-only copy');
  }

  private updateReadOnlyBanners(path: string): void {
    document.querySelectorAll<HTMLElement>('.notecolab-read-only-banner').forEach((banner) => {
      if (banner.dataset.path === path) this.updateReadOnlyBanner(banner, path);
    });
  }

  private isReadOnlyMirror(file: TFile): boolean {
    return isReadOnlyRecipient(noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter));
  }

  private async restoreReadOnlyMirrorName(file: TFile, oldPath: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(oldPath)) {
      new Notice('This read-only mirror keeps the owner’s filename. Make a copy to rename it.');
      return;
    }
    this.allowedReadOnlyRenames.add(oldPath);
    await this.app.fileManager.renameFile(file, oldPath);
    new Notice('This read-only mirror keeps the owner’s filename. Make a copy to rename it.');
  }

  private async createEditableCopy(file: TFile): Promise<void> {
    if (!this.isReadOnlyMirror(file)) return;
    await this.refreshReadOnlyMirror(file);
    const content = stripColabMetadata(await this.app.vault.read(file));
    const basename = editableCopyBasename(file.basename);
    const folder = this.app.fileManager.getNewFileParent('', `${basename}.md`).path;
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
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(copy);
    this.removeStaleReadOnlyBanner();
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
    const fm = noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);

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
    const fm = noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
    const roomId = fm?.colab_share_id;
    const linkShareId = fm?.colab_link_id || shareIdFromLink(fm?.colab_link) || roomId;
    const encryptionKey = fm?.colab_encryption_key
      || (fm?.colab_link ? fm.colab_link.split('#')[1] : '');
    if (!roomId || !linkShareId || !encryptionKey) return;

    this.refreshingReadOnlyMirrors.add(file.path);
    this.updateReadOnlyBanners(file.path);
    this.updateStatusBar();
    try {
      const api = this.apiFor(fm?.colab_link);
      const note = await api.getNoteContent(linkShareId);
      if (!note) return;

      if (note.accessMode !== 'read_only') {
        await this.app.fileManager.processFrontMatter(file, (frontmatter: import('./share/frontmatter').NoteColabFrontmatter) => {
          if (note.accessMode === 'public_edit' || note.accessMode === 'invited_edit' || note.accessMode === 'read_only') {
            frontmatter.colab_access = note.accessMode;
          }
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
      const liveFm = noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
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
      this.updateReadOnlyBanners(startingPath);
      this.updateReadOnlyBanners(file.path);
      this.updateStatusBar();
    }
  }

  private async saveFolderShareState(state: FolderShareState): Promise<void> {
    const index = this.settings.folderShares.findIndex((item) => item.folderPath === state.folderPath && item.serverUrl === state.serverUrl && item.ownerUid === state.ownerUid);
    if (index >= 0) {
      const current = this.settings.folderShares[index];
      this.settings.folderShares[index] = { ...state, watching: current.watching };
    }
    else this.settings.folderShares.push(state);
    await this.saveSettings();
  }

  private async setFolderShareWatching(state: FolderShareState, watching: boolean): Promise<void> {
    const current = this.settings.folderShares.find((item) => item.folderPath === state.folderPath
      && item.serverUrl === state.serverUrl
      && item.ownerUid === state.ownerUid);
    if (!current) return;
    current.watching = watching;
    await this.saveSettings();
    this.folderShareSync?.setWatching(current.folderPath, watching);
    new Notice(watching
      ? `Watching ${current.folderPath}. New Markdown files will publish automatically.`
      : `Stopped watching ${current.folderPath}. Existing shares remain active.`);
  }

  private async recoverSharedNoteVersion(file: TFile): Promise<void> {
    const fm = noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
    const shareId = fm?.colab_share_id;
    const encryptionKey = fm?.colab_encryption_key;
    if (!shareId || !encryptionKey || fm.colab_access === 'read_only') return;
    const linkShareId = fm.colab_link_id || shareIdFromLink(fm.colab_link) || shareId;
    try {
      const recovered = await recoverPreviousSnapshot(
        this.app,
        this.apiFor(fm.colab_link),
        file,
        shareId,
        encryptionKey,
        linkShareId,
      );
      if (!recovered) {
        new Notice('No recoverable encrypted revision is available for this account.');
        return;
      }
      await this.app.workspace.getLeaf('tab').openFile(recovered);
      new Notice(`Recovered previous version to ${recovered.path}. The shared note was not changed.`);
    } catch (error) {
      new Notice(`Could not recover previous version: ${requestErrorMessage(error) || String(error)}`);
    }
  }

  private folderShareUsesCurrentServer(state: FolderShareState): boolean {
    if (state.ownerUid && state.ownerUid !== this.settings.uid) return false;
    const server = state.serverUrl || state.manifest?.shareUrl || Object.values(state.entries)[0]?.shareUrl;
    if (!server) return true;
    try {
      const shareOrigin = new URL(server).origin;
      const currentOrigin = new URL(this.settings.serverUrl).origin;
      return shareOrigin === currentOrigin || isOfficialServerAlias(shareOrigin, currentOrigin);
    } catch {
      return false;
    }
  }

  private async reviewAndPublishFolder(choice: FolderShareChoice): Promise<void> {
    if (!this.settings.apiKey && !await this.ensureAutomaticConnection()) {
      new Notice(this.automaticConnectionError || 'Note Colab could not connect automatically.');
      return;
    }
    const folderPath = normalizePath(choice.folderPath).replace(/\/$/, '');
    const paths = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${folderPath}/`))
      .map((file) => file.path.slice(folderPath.length + 1))
      .sort();
    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      new Notice(`Folder not found: ${folderPath}`);
      return;
    }
    new FolderPublishPreviewModal(this.app, { ...choice, folderPath }, paths, (accepted) => {
      if (!accepted) return;
      void this.publishFolderChoice({ ...choice, folderPath });
    }).open();
  }

  private async publishFolderChoice(choice: FolderShareChoice): Promise<void> {
    const settings = { ...this.settings };
    const progress = new FolderProgressModal(this.app, 'Publishing folder');
    progress.open();
    const previousState = this.settings.folderShares.find(
      (state) => state.folderPath === choice.folderPath && this.folderShareUsesCurrentServer(state),
    );
    try {
      const result = await publishFolder(this.app, new ApiClient(settings), {
        folderPath: choice.folderPath,
        serverUrl: settings.serverUrl,
        ownerUid: settings.uid,
        accessMode: choice.accessMode,
        // Watched folders are durable by default. Per-note sharing still offers
        // expiring links, but an expiring index cannot support subscriptions.
        expiresIn: undefined,
        previousState,
        saveState: (state) => this.saveFolderShareState(state),
        shouldContinue: () => progress.shouldContinue && this.settings.serverUrl === settings.serverUrl && this.settings.uid === settings.uid,
        canPublishEditable: (file) => getShareSyncStatus(file.path) === 'connected',
        onProgress: ({ phase, completed, total, path }) => progress.update(
          phase === 'manifest'
            ? 'Publishing encrypted folder index…'
            : `Publishing ${completed + 1}/${total}${path ? `: ${path}` : ''}`,
        ),
      });
      if (result.cancelled) {
        progress.finish('Stopped safely. Run Share folder again to resume.');
      } else if (result.failed.length) {
        progress.finish(`${result.failed.length} file${result.failed.length === 1 ? '' : 's'} need attention. Run again to retry.`);
        new Notice(result.failed.map((failure) => `${failure.path}: ${failure.message}`).join('\n'), 12_000);
      } else if (result.shareUrl) {
        await navigator.clipboard.writeText(result.shareUrl);
        progress.finish(`Published ${result.created + result.updated + result.unchanged} notes. Folder link copied.`);
        const active = this.app.workspace.getActiveFile();
        if (active?.path.startsWith(`${choice.folderPath}/`) && choice.accessMode === 'public_edit') {
          await this.autoConnectShareSync();
        }
      }
    } catch (error) {
      progress.finish('Folder publishing failed.');
      new Notice(`Failed to share folder: ${requestErrorMessage(error) || String(error)}`);
    }
  }

  private async previewAndImportFolder(manifestUrl: string): Promise<void> {
    try {
      const loaded = await loadFolderShare(this.app, this.api, manifestUrl, {
        settings: this.settings,
        saveSettings: () => this.saveSettings(),
      });
      if (!loaded) return;
      new FolderImportPreviewModal(this.app, loaded.manifest, (accepted) => {
        if (accepted) void this.importLoadedFolder(loaded);
      }).open();
    } catch (error) {
      new Notice(`Could not preview shared folder: ${requestErrorMessage(error) || String(error)}`);
    }
  }

  private async importLoadedFolder(loaded: LoadedFolderShare, targetRoot?: string): Promise<void> {
    const progress = new FolderProgressModal(this.app, 'Importing shared folder');
    progress.open();
    let result: Awaited<ReturnType<typeof importFolderShare>>;
    try {
      result = await importFolderShare(this.app, loaded, {
        settings: this.settings,
        saveSettings: () => this.saveSettings(),
        targetRoot,
        shouldContinue: () => progress.shouldContinue,
        onProgress: (completed, total, path) => progress.update(
          `Importing ${Math.min(completed + 1, total)}/${total}${path ? `: ${path}` : ''}`,
        ),
      });
    } catch (error) {
      progress.finish('Folder import failed.');
      new Notice(`Failed to import shared folder: ${requestErrorMessage(error) || String(error)}`);
      return;
    }
    progress.finish(result.cancelled
      ? 'Stopped safely. Import the same folder link to resume.'
      : `Imported ${result.imported}, skipped ${result.skipped}${result.failed.length ? `, ${result.failed.length} failed` : ''}.`);
    if (result.cancelled) return;
    new FolderSubscriptionPromptModal(this.app, loaded.manifest.name, (subscribe) => {
      if (subscribe) void this.subscribeFolder(loaded, result.rootPath, result.completedPaths);
    }).open();
  }

  private async subscribeFolder(loaded: LoadedFolderShare, rootPath: string, completedPaths: string[]): Promise<void> {
    const completed = new Set(completedPaths);
    const subscription: FolderSubscription = {
      manifestUrl: loaded.manifestUrl,
      rootPath,
      knownEntries: Object.fromEntries(
        loaded.manifest.entries.filter((entry) => completed.has(entry.path)).map((entry) => [entry.path, entry.shareUrl]),
      ),
      subscribedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
    };
    const origin = new URL(loaded.manifestUrl).origin;
    const configuredOrigin = new URL(this.settings.serverUrl).origin;
    if (origin !== configuredOrigin
      && !isOfficialServerAlias(origin, configuredOrigin)
      && !this.settings.trustedShareHosts.includes(origin)) {
      // Choosing ongoing checks is explicit permission to contact this exact
      // foreign origin again. withBaseUrl still strips home-server credentials.
      this.settings.trustedShareHosts.push(origin);
    }
    const existing = this.settings.folderSubscriptions.findIndex((item) => item.manifestUrl === loaded.manifestUrl);
    if (existing >= 0) this.settings.folderSubscriptions[existing] = subscription;
    else this.settings.folderSubscriptions.push(subscription);
    await this.saveSettings();
    new Notice('Watching this encrypted folder index. New notes will always require approval.');
  }

  private async unsubscribeFolder(manifestUrl: string): Promise<void> {
    this.settings.folderSubscriptions = this.settings.folderSubscriptions
      .filter((subscription) => subscription.manifestUrl !== manifestUrl);
    this.pendingFolderSubscriptionPrompts.delete(manifestUrl);
    await this.saveSettings();
  }

  private async checkFolderSubscriptions(): Promise<void> {
    if (this.checkingFolderSubscriptions) return;
    this.checkingFolderSubscriptions = true;
    try {
      for (const subscription of [...this.settings.folderSubscriptions]) {
        if (this.pendingFolderSubscriptionPrompts.has(subscription.manifestUrl)) continue;
        try {
          const loaded = await loadFolderShare(this.app, this.api, subscription.manifestUrl, {
            settings: this.settings,
            saveSettings: () => this.saveSettings(),
          });
          if (!loaded) continue;
          subscription.lastCheckedAt = new Date().toISOString();
          const additions = loaded.manifest.entries.filter(
            (entry) => subscription.knownEntries[entry.path] !== entry.shareUrl,
          );
          if (!additions.length) {
            await this.saveSettings();
            continue;
          }
          this.pendingFolderSubscriptionPrompts.add(subscription.manifestUrl);
          new FolderUpdatePreviewModal(
            this.app,
            loaded.manifest.name,
            additions.map((entry) => entry.path),
            (decision) => { void (async () => {
              try {
                if (decision === 'unsubscribe') {
                  await this.unsubscribeFolder(subscription.manifestUrl);
                  return;
                }
                if (decision !== 'import') return;
                const additionsOnly: LoadedFolderShare = {
                  ...loaded,
                  manifest: { ...loaded.manifest, entries: additions },
                };
                const progress = new FolderProgressModal(this.app, 'Importing new shared notes');
                progress.open();
                try {
                  const result = await importFolderShare(this.app, additionsOnly, {
                    settings: this.settings,
                    targetRoot: subscription.rootPath,
                    shouldContinue: () => progress.shouldContinue,
                    onProgress: (completed, total, path) => progress.update(
                      `Importing ${Math.min(completed + 1, total)}/${total}${path ? `: ${path}` : ''}`,
                    ),
                  });
                  const completed = new Set(result.completedPaths);
                  for (const entry of additions) {
                    if (completed.has(entry.path)) subscription.knownEntries[entry.path] = entry.shareUrl;
                  }
                  await this.saveSettings();
                  progress.finish(result.cancelled ? 'Stopped safely.' : `Imported ${result.imported} new notes.`);
                } catch (error) {
                  progress.finish('New-note import failed. It will remain available for retry.');
                  new Notice(`Failed to import folder update: ${requestErrorMessage(error) || String(error)}`);
                }
              } finally {
                this.pendingFolderSubscriptionPrompts.delete(subscription.manifestUrl);
              }
            })(); },
          ).open();
        } catch (error) {
          console.warn(`NoteColab: folder subscription check failed for ${subscription.manifestUrl}`, error);
        }
      }
    } finally {
      this.checkingFolderSubscriptions = false;
    }
  }

  async shareCurrentNote(): Promise<void> {
    if (!this.settings.apiKey) {
      const connected = await this.ensureAutomaticConnection();
      if (!connected) {
        new Notice(this.automaticConnectionError
          || 'Note Colab could not connect automatically. Check the server in Settings → Note Colab.');
        return;
      }
    }

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('Open a note before sharing');
      return;
    }

    if (noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter)?.colab_share_id) {
      new Notice('This note is already shared. Opening its sharing controls so you can resend it without creating a duplicate.');
      void this.openManageLinks(file);
      return;
    }

    const firstShare = this.settings.onboardingState === 'pending';
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
        updateMode: opts.updateMode,
        expiresIn: opts.accessMode === 'invited_edit' ? undefined : (opts.expiresIn || undefined),
        showHelp: opts.showHelp,
        theme: opts.theme,
        showHeader: opts.showHeader,
        showControls: opts.showControls,
        showChrome: opts.showChrome,
        collaborators: opts.collaborators,
      });

      if (!result) {
        return { ok: false, error: 'The share could not be created. Your choices are unchanged, so you can try again.' };
      }

      // Auto-start sync for editable shares
      if (opts.accessMode !== 'read_only') {
        try {
          const key = result.shareUrl.split('#')[1] || '';
          await startShareSync(this.app, this.settings, file, result.shareId, this.api, key);
        } catch (error) {
          console.warn('NoteColab: share created but live sync could not start', error);
          new Notice('Share created, but live sync could not start yet. Reopen the note to retry.');
        }
      }
      // Upload vault key for web dashboard access
      if (this.settings.vaultKey) {
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
      try {
        this.settings.sharedNoteCount += 1;
        this.settings.onboardingState = 'done';
        await this.saveSettings();
        void this.maybeWarnStorage(true);
        if (this.settings.usernamePromptState === 'after_shares' && this.settings.sharedNoteCount >= 3) {
          void this.maybePromptForUsername('after_shares');
        }
      } catch (error) {
        console.warn('NoteColab: share created but local share counters could not be saved', error);
      }
      // For invite-only: generate an invite link and copy it
      if (opts.accessMode === 'invited_edit') {
        try {
          const inviteResult = await this.api.createInviteLink(result.shareId);
          if (!inviteResult?.token) {
            new Notice('Share created, but the invite link could not be created. Open Manage shared links to try again.');
          } else {
            const encKey = result.shareUrl.split('#')[1] || '';
            const inviteUrl = `${this.settings.serverUrl}/invite/${inviteResult.token}#${encKey}`;
            try {
              await navigator.clipboard.writeText(inviteUrl);
              new Notice('Invite link copied to clipboard!\nShare it with anyone you want to invite.');
            } catch (error) {
              console.warn('NoteColab: invite link created but clipboard write failed', error);
              new Notice('Invite link created, but clipboard access failed. Open Manage shared links to create and copy another invite.');
            }
          }
        } catch (error) {
          console.warn('NoteColab: share created but invite link creation failed', error);
          new Notice('Share created, but the invite link could not be created. Open Manage shared links to try again.');
        }
      }
      return { ok: true };
    }, firstShare, file).open();
  }

  private openManageLinks(file: TFile): void {
    const fm = noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
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
    const fm = noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
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
    this.statusBarItem = null;
    this.presenceIdentity = '';
    this.presence?.destroy();
    this.presence = null;
    if (this.statusBarInterval) window.clearInterval(this.statusBarInterval);
    if (this.pendingSharesInterval) window.clearInterval(this.pendingSharesInterval);
    if (this.readOnlyRefreshInterval) window.clearInterval(this.readOnlyRefreshInterval);
    if (this.refCheckTimer) window.clearTimeout(this.refCheckTimer);
    if (this.folderSubscriptionInterval) window.clearInterval(this.folderSubscriptionInterval);
    this.folderShareSync?.stop();
    this.folderShareSync = null;
    for (const timer of this.pendingDeletions.values()) window.clearTimeout(timer);
    this.pendingDeletions.clear();
    destroyAllShareSyncs(this.app);
  }

  async loadSettings() {
    const saved = await this.loadData() as Partial<ColabSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.pinnedPublicKeys = { ...(saved?.pinnedPublicKeys || {}) };
    this.settings.folderShares = [...(saved?.folderShares || [])];
    this.settings.folderSubscriptions = [...(saved?.folderSubscriptions || [])];
    this.settings.usernamePromptState = initialUsernamePromptState(saved);
    this.settings.onboardingState = initialOnboardingState(saved);
    if (saved?.serverUrl && migrateOfficialServerUrl(saved.serverUrl) !== saved.serverUrl) {
      this.settings.serverUrl = migrateOfficialServerUrl(saved.serverUrl);
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async ensureAutomaticConnection(): Promise<boolean> {
    if (this.settings.apiKey) return true;
    if (this.settings.onboardingState !== 'pending' || this.settings.serverUrl !== OFFICIAL_SERVER_URL) return false;
    if (this.automaticConnection) return this.automaticConnection;

    const connection = (async () => {
      this.automaticConnectionError = null;
      try {
        const info = await this.api.getServerInfo();
        if (info?.registration?.mode && info.registration.mode !== 'open') return false;
        const keyPair = generateKeyPair();
        const identity = await this.api.register(keyPair.publicKey);
        this.settings.uid = identity.uid;
        this.settings.apiKey = identity.apiKey;
        this.settings.publicKey = keyPair.publicKey;
        this.settings.secretKey = keyPair.secretKey;
        await this.saveSettings();
        this.updateStatusBar();
        return true;
      } catch (error) {
        console.warn('Note Colab automatic connection failed:', error);
        this.automaticConnectionError = requestErrorMessage(error) || null;
        return false;
      } finally {
        this.automaticConnection = null;
      }
    })();
    this.automaticConnection = connection;

    return connection;
  }

  private async maybeStartOnboarding(): Promise<void> {
    if (this.onboardingOpen || this.settings.onboardingState !== 'pending') return;
    this.onboardingOpen = true;
    new OnboardingModal(this.app, {
      serverUrl: this.settings.serverUrl,
      connected: !!this.settings.apiKey,
      onConnect: async () => {
        const connected = await this.ensureAutomaticConnection();
        return connected ? { ok: true } : {
          ok: false,
          error: this.automaticConnectionError || 'Open Settings → Note Colab to connect to this server.',
        };
      },
      onShare: () => {
        this.onboardingOpen = false;
        void this.shareCurrentNote();
      },
      onDone: async (completed) => {
        this.onboardingOpen = false;
        if (completed) this.settings.onboardingState = 'done';
        await this.saveSettings();
      },
    }).open();
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
      await workspace.revealLeaf(leaf);
    }
  }

  refreshDashboard() {
    const leaves = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof DashboardView) {
        void view.loadData();
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
    const fm = noteColabFrontmatter(cache?.frontmatter);
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
    const fm = noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
    if (!fm?.colab_share_id || fm.colab_access !== 'read_only' || !mayPublishAsOwner(fm)) return;
    if (fm.colab_update_mode === 'snapshot') return;
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

  private watchPresenceWindow(target: Window) {
    if (this.presenceWindows.has(target)) return;
    this.presenceWindows.add(target);
    this.registerDomEvent(target, 'focus', () => this.updateStatusBar());
    this.registerDomEvent(target, 'blur', () => this.updateStatusBar());
    this.registerDomEvent(target.document, 'visibilitychange', () => this.updateStatusBar());
  }

  private updatePresence() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    const fm = file && noteColabFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
    const provider = file ? getShareSync(file.path)?.provider : undefined;
    const supported = fm?.colab_share_id && fm.colab_link
      && (provider || fm.colab_access === 'read_only');
    const identity = supported ? JSON.stringify([
      file?.path, fm.colab_share_id, fm.colab_link, fm.colab_link_id,
      fm.colab_encryption_key, this.settings.serverUrl, this.settings.apiKey,
    ]) : '';
    if (identity !== this.presenceIdentity || provider !== this.presenceProvider) {
      this.presence?.destroy();
      this.presence = null;
      this.presenceIdentity = identity;
      this.presenceProvider = provider;
      if (supported) {
        const presence = new NotePresence(() => this.updateStatusBar());
        this.presence = presence;
        if (provider) {
          presence.attach(provider);
        } else {
          const key = fm.colab_encryption_key || fm.colab_link!.split('#')[1];
          const shareId = fm.colab_share_id!;
          const linkId = fm.colab_link_id || shareIdFromLink(fm.colab_link) || shareId;
          const origin = foreignOrigin(fm.colab_link, this.settings.serverUrl) || this.settings.serverUrl;
          const credentials = websocketCredentials(this.settings.apiKey, this.apiFor(fm.colab_link).usesAccountCredentials);
          void (async () => {
            const roomToken = key ? await deriveRoomToken(key, shareId) : '';
            if (this.presence !== presence) return;
            const url = new URL(`${origin.replace(/^http/, 'ws')}/ws/yjs/${encodeURIComponent(shareId)}`);
            url.search = new URLSearchParams({ ...credentials, link: linkId, presence: '1', ...(roomToken ? { rt: roomToken } : {}) }).toString();
            presence.connect(url.toString());
          })().catch(() => { /* Keep the disconnected indicator; retry after the next note switch. */ });
        }
      }
    }
    if (view) {
      const document = view.containerEl.ownerDocument;
      if (document.defaultView) this.watchPresenceWindow(document.defaultView);
      this.presence?.setActive(isForeground(document));
    }
  }

  private updateStatusBar() {
    if (!this.statusBarItem) return;
    this.updatePresence();

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.statusBarItem.setText('');
      return;
    }

    const status = getShareSyncStatus(file.path);
    const saveState = getShareSaveState(file.path);
    const saveLabels = { 'saved-device': 'saved on device', uploading: 'saving…', 'saved-server': 'saved to server', offline: 'offline, changes pending', error: 'save failed, changes pending' } as const;
    if (this.isReadOnlyMirror(file)) {
      this.statusBarItem.setText(
        this.refreshingReadOnlyMirrors.has(file.path)
          ? 'Colab: read-only · updating…'
          : 'Colab: read-only',
      );
      this.statusBarItem.setCssStyles({ color: '' });
    } else if (status === 'connected'
      || saveState === 'saved-device'
      || saveState === 'uploading'
      || saveState === 'offline'
      || saveState === 'error') {
      this.statusBarItem.setText(`Colab: ${saveLabels[saveState || 'uploading']}`);
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
    if (this.presence) {
      const syncText = this.statusBarItem.textContent || 'Colab';
      this.statusBarItem.setText(`${syncText} · ${this.presence.label}`);
      this.statusBarItem.setAttribute('role', 'button');
      this.statusBarItem.tabIndex = 0;
      this.statusBarItem.setAttribute('aria-label', `${syncText}. ${this.presence.label}. Show participants`);
    } else {
      this.statusBarItem.removeAttribute('aria-label');
      this.statusBarItem.removeAttribute('role');
      this.statusBarItem.removeAttribute('tabindex');
    }
  }

  private rebuildSharedNoteCache() {
    this.sharedNoteCache.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = noteColabFrontmatter(cache?.frontmatter);
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
          return noteColabFrontmatter(cache?.frontmatter)?.colab_share_id === ps.shareId;
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
    const fm = noteColabFrontmatter(cache?.frontmatter);
    if (!fm?.colab_share_id || fm.colab_access === 'read_only') return;

    // Get collaborators for this note
    const collabs = await this.api.listCollaborators(fm.colab_share_id);
    if (collabs.length === 0) return;

    // Find all [[wikilinks]] in the note
    const links = cache?.links || [];
    for (const link of links) {
      const linkedFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
      if (!linkedFile || !(linkedFile).extension) continue;
      if ((linkedFile).extension !== 'md') continue;

      // Check if linked note is already shared
      const linkedCache = this.app.metadataCache.getFileCache(linkedFile);
      if (noteColabFrontmatter(linkedCache?.frontmatter)?.colab_share_id) continue;

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
    if (prev) window.clearTimeout(prev);
    const timer = window.setTimeout(() => {
      this.pendingDeletions.delete(cached.shareId);
      // The share reappeared elsewhere in the vault → it was moved, not deleted.
      if (this.isShareIdInVault(cached.shareId)) return;
      void this.promptDeleteFromServer(cached.shareId, cached.title);
    }, 1500);
    this.pendingDeletions.set(cached.shareId, timer);
  }

  /** Cancel a deferred "delete from server?" prompt (the note came back — a move). */
  private cancelPendingDeletion(shareId: string) {
    const timer = this.pendingDeletions.get(shareId);
    if (timer) {
      window.clearTimeout(timer);
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
      const sid = noteColabFrontmatter(this.app.metadataCache.getFileCache(f)?.frontmatter)?.colab_share_id;
      if (sid === shareId) return true;
    }
    return false;
  }

  private promptDeleteFromServer(shareId: string, title: string) {
    new DeleteConfirmModal(this.app, title, (deleteFromServer) => {
      void (async () => {
        if (deleteFromServer) {
          const ok = await this.api.deleteNote(shareId);
          if (ok) {
            new Notice(`"${title}" deleted from server`);
          } else {
            new Notice('Failed to delete from server. You can try again from the Note Colab dashboard.');
          }
        }
      })();
    }).open();
  }
}

import type { TAbstractFile, Vault } from 'obsidian';
import type { ApiClient } from '../api/client';
import type { App } from 'obsidian';
import { publishFolder, type FolderShareState, type PublishFolderResult } from './folderShare';

export interface FolderSyncOptions {
  getServerUrl: () => string;
  getOwnerUid: () => string;
  getStates: () => FolderShareState[];
  saveState: (state: FolderShareState) => Promise<void>;
  onResult?: (result: PublishFolderResult) => void;
  debounceMs?: number;
  canPublishEditable?: (path: string) => boolean;
}

function containsPath(state: FolderShareState, path: string): boolean {
  return path === state.folderPath || path.startsWith(`${state.folderPath}/`);
}

/**
 * Keeps explicitly registered folder shares current while Obsidian is open.
 * Creation, modification, rename, and deletion all reconcile the encrypted index;
 * deletion never calls the remote delete endpoint.
 */
export class FolderShareSync {
  private readonly app: App;
  private readonly api: () => ApiClient;
  private readonly options: FolderSyncOptions;
  private stopped = true;
  private timers = new Map<string, number>();
  private running = new Set<string>();
  private rerun = new Set<string>();
  private retryAttempts = new Map<string, number>();
  private generations = new Map<string, number>();
  private eventRefs: ReturnType<Vault['on']>[] = [];

  constructor(
    app: App,
    api: () => ApiClient,
    options: FolderSyncOptions,
  ) {
    this.app = app;
    this.api = api;
    this.options = options;
  }

  start() {
    if (this.eventRefs.length) return;
    this.stopped = false;
    this.eventRefs.push(
      this.app.vault.on('create', (file) => this.changed(file.path)),
      this.app.vault.on('modify', (file) => this.changed(file.path)),
      this.app.vault.on('delete', (file) => this.changed(file.path)),
      this.app.vault.on('rename', (file, oldPath) => {
        this.changed(oldPath);
        this.changed(file.path);
      }),
    );
  }

  stop() {
    this.stopped = true;
    for (const ref of this.eventRefs) this.app.vault.offref(ref);
    this.eventRefs = [];
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }

  setWatching(folderPath: string, watching: boolean) {
    this.generations.set(folderPath, (this.generations.get(folderPath) || 0) + 1);
    const timer = this.timers.get(folderPath);
    if (timer !== undefined) window.clearTimeout(timer);
    this.timers.delete(folderPath);
    this.retryAttempts.delete(folderPath);
    if (!watching) {
      this.rerun.delete(folderPath);
      return;
    }
    this.changed(folderPath);
  }

  private changed(path: TAbstractFile['path']) {
    for (const state of this.options.getStates()) {
      if (state.watching === false) continue;
      if (!containsPath(state, path)) continue;
      this.retryAttempts.set(state.folderPath, 0);
      const existing = this.timers.get(state.folderPath);
      if (existing !== undefined) window.clearTimeout(existing);
      this.timers.set(state.folderPath, window.setTimeout(
        () => void this.reconcile(state.folderPath),
        this.options.debounceMs ?? 1_000,
      ));
    }
  }

  private async reconcile(folderPath: string): Promise<void> {
    this.timers.delete(folderPath);
    if (this.running.has(folderPath)) {
      this.rerun.add(folderPath);
      return;
    }
    const state = this.options.getStates().find((candidate) => candidate.folderPath === folderPath);
    if (!state) return;
    if (this.stopped || state.watching === false) return;
    const serverUrl = this.options.getServerUrl();
    const ownerUid = this.options.getOwnerUid();
    const generation = this.generations.get(folderPath) || 0;
    this.running.add(folderPath);
    try {
      const result = await publishFolder(this.app, this.api(), {
        folderPath: state.folderPath,
        serverUrl, ownerUid,
        shouldContinue: () => !this.stopped
          && (this.generations.get(folderPath) || 0) === generation
          && this.options.getStates().some((candidate) => candidate.folderPath === folderPath && candidate.watching !== false)
          && this.options.getServerUrl() === serverUrl
          && this.options.getOwnerUid() === ownerUid,
        accessMode: state.accessMode,
        previousState: state,
        saveState: this.options.saveState,
        canPublishEditable: (file) => this.options.canPublishEditable?.(file.path) ?? false,
      });
      this.options.onResult?.(result);
      const attempt = this.retryAttempts.get(folderPath) || 0;
      const stillWatching = this.options.getStates()
        .some((candidate) => candidate.folderPath === folderPath && candidate.watching !== false);
      if (!this.stopped && stillWatching && result.failed.length && attempt < 5 && !this.timers.has(folderPath)) {
        this.retryAttempts.set(folderPath, attempt + 1);
        this.timers.set(folderPath, window.setTimeout(
          () => void this.reconcile(folderPath),
          Math.min(5_000 * 2 ** attempt, 60_000),
        ));
      } else if (!result.failed.length) {
        this.retryAttempts.delete(folderPath);
      }
    } catch (error) {
      console.warn('NoteColab: folder reconciliation failed', error);
    } finally {
      this.running.delete(folderPath);
      if (this.rerun.delete(folderPath)) await this.reconcile(folderPath);
    }
  }
}

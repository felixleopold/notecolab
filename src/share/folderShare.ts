import { TFile, TFolder, normalizePath, type App } from 'obsidian';
import type { ApiClient } from '../api/client';
import { decrypt, deriveRoomToken, deriveWriteCapability, encrypt, encryptBinary, generateKey } from '../crypto/crypto';
import { parseFrontmatter, rememberEncrypted } from '../session/sessions';
import { findImageEmbeds } from './imageEmbeds';
import { MAX_FOLDER_FILES, serializeFolderManifest, type FolderManifestEntry } from './folderManifest';
import { noteColabFrontmatter, type NoteColabFrontmatter } from './frontmatter';
import { mayPublishAsOwner } from './shareOwnership';
import { isOfficialServerAlias } from '../types';

export type FolderAccessMode = 'public_edit' | 'read_only';

export interface FolderPublishedNote {
  roomId: string;
  linkShareId: string;
  /** Legacy folder state used one identifier for both the room and permission link. */
  shareId?: string;
  shareUrl: string;
  encryptionKey: string;
  contentHash: string;
  accessMode?: FolderAccessMode;
  expiresAt?: string | null;
  /** Created remotely, but its room/write tokens are not yet confirmed. Retries finish setup. */
  roomTokenPending?: true;
  /** Uploaded embedded images keyed by embed name, valued by the local file's `mtime:size`. */
  assets?: Record<string, string>;
}

export interface FolderShareState {
  version: 1;
  folderPath: string;
  /** Undefined is treated as true for folder shares created by older plugin versions. */
  watching?: boolean;
  serverUrl?: string;
  ownerUid?: string;
  folderName: string;
  accessMode: FolderAccessMode;
  entries: Record<string, FolderPublishedNote>;
  manifest?: FolderPublishedNote;
  lastPublishedAt?: string;
}

export interface FolderShareProgress {
  phase: 'notes' | 'manifest';
  completed: number;
  total: number;
  path?: string;
}

export interface PublishFolderOptions {
  folderPath: string;
  serverUrl: string;
  ownerUid?: string;
  /**
   * The owner's explicit choice. Automatic reconciliation omits it so a queued run
   * follows the folder's current mode instead of a snapshot captured before it waited.
   */
  accessMode?: FolderAccessMode;
  expiresIn?: number;
  previousState?: FolderShareState;
  saveState?: (state: FolderShareState) => Promise<void>;
  onProgress?: (progress: FolderShareProgress) => void;
  shouldContinue?: () => boolean;
  /** Editable snapshots may only advance while their normal per-note Yjs sync is connected. */
  canPublishEditable?: (file: TFile) => boolean;
}

export interface PublishFolderResult {
  state: FolderShareState;
  shareUrl?: string;
  created: number;
  updated: number;
  unchanged: number;
  removedFromIndex: number;
  failed: { path: string; message: string }[];
  cancelled: boolean;
}

function shareUrl(serverUrl: string, shareId: string, encryptionKey: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/s/${shareId}#${encryptionKey}`;
}

function normalizeOfficialShareUrl(link: string, serverUrl: string): string {
  try {
    const url = new URL(link);
    const serverOrigin = new URL(serverUrl).origin;
    return url.origin !== serverOrigin && isOfficialServerAlias(url.origin, serverOrigin)
      ? `${serverOrigin}${url.pathname}${url.search}${url.hash}`
      : link;
  } catch {
    return link;
  }
}

function linkShareId(link: string): string | undefined {
  try {
    const parts = new URL(link).pathname.split('/').filter(Boolean);
    return parts.length === 2 && parts[0] === 's' ? parts[1] : undefined;
  } catch {
    return undefined;
  }
}

function normalizePublishedNote(note: FolderPublishedNote, serverUrl: string): FolderPublishedNote {
  const roomId = note.roomId || note.shareId;
  if (!roomId) throw new Error('Shared note is missing its canonical room ID');
  return {
    ...note,
    roomId,
    linkShareId: note.linkShareId || linkShareId(note.shareUrl) || roomId,
    shareId: undefined,
    shareUrl: normalizeOfficialShareUrl(note.shareUrl, serverUrl),
  };
}

async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mimeType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  } as Record<string, string>)[extension || ''] || 'application/octet-stream';
}

function resolveImage(app: App, filename: string, context: TFile): TFile | null {
  const exact = app.vault.getAbstractFileByPath(filename);
  if (exact instanceof TFile) return exact;
  return app.metadataCache.getFirstLinkpathDest(filename, context.path);
}

async function uploadImages(
  app: App,
  api: ApiClient,
  file: TFile,
  body: string,
  note: FolderPublishedNote,
  shouldContinue: () => boolean,
  onUploaded: () => Promise<void>,
): Promise<boolean> {
  for (const filename of findImageEmbeds(body)) {
    if (!shouldContinue()) return false;
    const image = resolveImage(app, filename, file);
    if (!image) continue;
    const signature = `${image.stat.mtime}:${image.stat.size}`;
    if (note.assets?.[filename] === signature) continue;
    const bytes = await app.vault.readBinary(image);
    if (!shouldContinue()) return false;
    const encryptedData = await encryptBinary(bytes, note.encryptionKey);
    if (!shouldContinue()) return false;
    const uploaded = await api.uploadImage(note.roomId, filename, encryptedData, mimeType(filename));
    if (!uploaded) throw new Error(`Failed to upload ${filename}`);
    note.assets = { ...note.assets, [filename]: signature };
    await onUploaded();
    if (!shouldContinue()) return false;
  }
  return true;
}

/**
 * Creates the remote note and persists its identity before any further request,
 * so a failed token setup is resumed by `secureSharedNote` instead of orphaned.
 */
async function createSharedNote(
  api: ApiClient,
  serverUrl: string,
  title: string,
  body: string,
  accessMode: FolderAccessMode,
  expiresIn: number | undefined,
  persist: (note: FolderPublishedNote) => Promise<void>,
): Promise<FolderPublishedNote> {
  const encryptionKey = await generateKey();
  const result = await api.shareNote({
    encryptedTitle: await encrypt(title, encryptionKey),
    encryptedContent: await encrypt(body, encryptionKey),
    accessMode,
    expiresIn,
  });
  const note: FolderPublishedNote = {
    roomId: result.shareId,
    linkShareId: result.shareId,
    shareUrl: shareUrl(serverUrl, result.shareId, encryptionKey),
    encryptionKey,
    contentHash: await contentHash(body),
    accessMode,
    expiresAt: result.expiresAt,
    roomTokenPending: true,
  };
  await persist(note);
  await secureSharedNote(api, note);
  return note;
}

/** Idempotent: the tokens are derived from the key and room, so a retry sets the same values. */
async function secureSharedNote(api: ApiClient, note: FolderPublishedNote): Promise<void> {
  const [roomToken, writeToken] = await Promise.all([
    deriveRoomToken(note.encryptionKey, note.roomId),
    deriveWriteCapability(note.encryptionKey, note.roomId),
  ]);
  if (!await api.setRoomToken(note.roomId, roomToken, writeToken)) {
    throw new Error('Failed to secure the shared note');
  }
  delete note.roomTokenPending;
}

async function updateSharedNote(
  api: ApiClient,
  note: FolderPublishedNote,
  title: string,
  body: string | undefined,
  accessMode?: FolderAccessMode,
): Promise<void> {
  const updated = await api.updateNote(note.roomId, {
    encryptedTitle: await encrypt(title, note.encryptionKey),
    ...(body === undefined ? {} : { encryptedContent: await encrypt(body, note.encryptionKey) }),

  });
  if (!updated) throw new Error('Failed to update shared note');
  if (accessMode && !await api.updateLink(note.linkShareId, { accessMode })) {
    throw new Error('Failed to update shared-note permissions');
  }
}

function frontmatterNote(app: App, file: TFile, serverUrl: string): FolderPublishedNote | undefined {
  const fm = noteColabFrontmatter(app.metadataCache.getFileCache(file)?.frontmatter);
  const encryptionKey = fm?.colab_encryption_key || fm?.colab_link?.split('#')[1] || '';
  if (!fm?.colab_share_id || !fm.colab_link || !encryptionKey || !mayPublishAsOwner(fm)) return undefined;
  if (fm.colab_access !== 'read_only' && fm.colab_access !== 'public_edit') return undefined;
  let normalizedLink = fm.colab_link;
  let permissionLinkId: string;
  try {
    const linkUrl = new URL(fm.colab_link);
    const serverOrigin = new URL(serverUrl).origin;
    if (linkUrl.origin !== serverOrigin && !isOfficialServerAlias(linkUrl.origin, serverOrigin)) return undefined;
    if (linkUrl.origin !== serverOrigin) normalizedLink = normalizeOfficialShareUrl(fm.colab_link, serverUrl);
    permissionLinkId = linkShareId(normalizedLink) || fm.colab_link_id || fm.colab_share_id;
  } catch {
    return undefined;
  }
  return {
    roomId: fm.colab_share_id,
    linkShareId: permissionLinkId,
    shareUrl: normalizedLink,
    encryptionKey,
    contentHash: '',
    accessMode: fm.colab_access,
    expiresAt: fm.colab_expires || null,
  };
}

async function attachOwnerFrontmatter(app: App, file: TFile, note: FolderPublishedNote): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm: NoteColabFrontmatter) => {
    fm.colab_share_id = note.roomId;
    fm.colab_link_id = note.linkShareId;
    fm.colab_link = note.shareUrl;
    fm.colab_access = note.accessMode;
    fm.colab_encryption_key = note.encryptionKey;
    fm.colab_owner = true;
    fm.colab_update_mode = 'live';
    if (note.expiresAt) fm.colab_expires = note.expiresAt;
    else delete fm.colab_expires;
  });
}

function hasOwnerFrontmatter(app: App, file: TFile, note: FolderPublishedNote): boolean {
  const fm = noteColabFrontmatter(app.metadataCache.getFileCache(file)?.frontmatter);
  return fm?.colab_share_id === note.roomId
    && fm.colab_link_id === note.linkShareId
    && fm.colab_link === note.shareUrl
    && fm.colab_encryption_key === note.encryptionKey
    && fm.colab_owner === true
    && fm.colab_access === note.accessMode;
}

interface PublicationTracker {
  pending: number;
  /** Latest state saved by a publication in this queue; newer than callers' snapshots. */
  state?: FolderShareState;
  queue: Promise<unknown>;
}

const publications = new Map<string, PublicationTracker>();

function publicationKey(serverUrl: string, ownerUid: string | undefined, folderPath: string): string {
  let server = serverUrl;
  try {
    server = new URL(serverUrl).origin;
  } catch {
    // An unparseable server URL still identifies its own queue.
  }
  return JSON.stringify([server, ownerUid || '', folderPath]);
}

/**
 * Reconcile a local folder into ordinary encrypted note shares plus one encrypted index note.
 * State should be persisted in plugin data after every callback. Missing local files disappear
 * from the next index, but their remote shares are deliberately never deleted.
 *
 * Publications of the same server, owner, and folder run one at a time. A queued publication
 * starts from the state its predecessor saved rather than the caller's older snapshot.
 */
export async function publishFolder(
  app: App,
  api: ApiClient,
  options: PublishFolderOptions,
): Promise<PublishFolderResult> {
  const folderPath = normalizePath(options.folderPath).replace(/\/$/, '');
  const key = publicationKey(options.serverUrl, options.ownerUid, folderPath);
  const tracker = publications.get(key) || { pending: 0, queue: Promise.resolve() };
  publications.set(key, tracker);
  tracker.pending++;
  const run = tracker.queue.catch(() => undefined)
    .then(() => reconcileFolder(app, api, options, folderPath, tracker));
  tracker.queue = run;
  try {
    return await run;
  } finally {
    // Once the queue drains, callers read the persisted state again.
    if (--tracker.pending === 0) publications.delete(key);
  }
}

async function reconcileFolder(
  app: App,
  api: ApiClient,
  options: PublishFolderOptions,
  folderPath: string,
  tracker: PublicationTracker,
): Promise<PublishFolderResult> {
  if (!(app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
    throw new Error(`Vault folder not found: ${folderPath}`);
  }
  const folderName = folderPath.split('/').pop() || 'Shared folder';
  const current = tracker.state
    ? { ...tracker.state, watching: options.previousState?.watching ?? tracker.state.watching }
    : options.previousState;
  const previous = current?.folderPath === folderPath ? current : undefined;
  const accessMode = options.accessMode || previous?.accessMode;
  if (!accessMode) throw new Error('Choose how the shared folder can be accessed');
  const state: FolderShareState = previous
    ? structuredClone(previous)
    : { version: 1, folderPath, watching: true, folderName, accessMode, entries: {} };
  // Record an explicit choice at once so runs queued behind this one follow it, even if this one fails.
  state.accessMode = accessMode;
  state.serverUrl = options.serverUrl;
  state.ownerUid = options.ownerUid;
  state.entries = Object.fromEntries(Object.entries(state.entries).map(([path, note]) => [
    path,
    normalizePublishedNote(note, options.serverUrl),
  ]));
  if (state.manifest) state.manifest = normalizePublishedNote(state.manifest, options.serverUrl);
  const save = async () => {
    tracker.state = structuredClone(state);
    await options.saveState?.(state);
  };
  const shouldContinue = options.shouldContinue || (() => true);
  const files = app.vault.getMarkdownFiles()
    .filter((file) => file.path.startsWith(`${folderPath}/`))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > MAX_FOLDER_FILES) throw new Error(`A shared folder can contain at most ${MAX_FOLDER_FILES} Markdown files. Choose a smaller folder.`);
  const activePaths = new Set(files.map((file) => file.path.slice(folderPath.length + 1)));
  const removedFromIndex = Object.keys(state.entries).filter((path) => !activePaths.has(path)).length;
  const availableRenames = new Map<string, FolderPublishedNote>();
  for (const [path, note] of Object.entries(state.entries)) {
    if (!activePaths.has(path)) availableRenames.set(note.contentHash, note);
  }

  const nextEntries: Record<string, FolderPublishedNote> = {};
  const failed: PublishFolderResult['failed'] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const saveEntries = async () => {
    state.entries = { ...state.entries, ...nextEntries };
    await save();
  };

  const cancelledResult = async (): Promise<PublishFolderResult> => {
    await saveEntries();
    return { state, created, updated, unchanged, removedFromIndex, failed, cancelled: true };
  };

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const relativePath = file.path.slice(folderPath.length + 1);
    options.onProgress?.({ phase: 'notes', completed: index, total: files.length, path: relativePath });
    if (!shouldContinue()) return cancelledResult();

    try {
      const fm = noteColabFrontmatter(app.metadataCache.getFileCache(file)?.frontmatter);
      if (fm?.colab_update_mode === 'snapshot') {
        throw new Error('This note is a snapshot. Revoke its snapshot share and share it as an updating note before publishing the folder');
      }
      const { body } = parseFrontmatter(await app.vault.read(file));
      if (!shouldContinue()) return cancelledResult();
      const hash = await contentHash(body);
      if (!shouldContinue()) return cancelledResult();
      const tracked = state.entries[relativePath];
      const trackedJson = tracked && JSON.stringify(tracked);
      let note: FolderPublishedNote | undefined = tracked
        || frontmatterNote(app, file, options.serverUrl);
      let renamed = false;
      if (!note) {
        note = availableRenames.get(hash);
        renamed = !!note;
        if (note) availableRenames.delete(hash);
      }
      if (note?.roomTokenPending) await secureSharedNote(api, note);
      const existingNote = !!note;
      if (!note) {
        note = await createSharedNote(
          api, options.serverUrl, relativePath, body, accessMode, options.expiresIn,
          async (pending) => {
            nextEntries[relativePath] = pending;
            await saveEntries();
          },
        );
        await attachOwnerFrontmatter(app, file, note);
        created++;
      } else if (note.contentHash !== hash || renamed || note.accessMode !== accessMode) {
        const bodyChanged = note.contentHash !== hash;
        if (!hasOwnerFrontmatter(app, file, note)) await attachOwnerFrontmatter(app, file, note);
        // Owners' notes of every mode publish body edits through their live session.
        if (bodyChanged && !options.canPublishEditable?.(file)) {
          throw new Error('Open this note and wait for NoteColab sync before publishing its local changes');
        }
        if (bodyChanged) {
          const remote = await api.getNoteContent(note.roomId);
          if (!shouldContinue()) return cancelledResult();
          if (remote) await rememberEncrypted('', note.encryptionKey, note.roomId, remote);
          if (!remote || await decrypt(remote.encryptedContent, note.encryptionKey) !== body) {
            throw new Error('Note content is still publishing through its normal per-note sync. Wait, then retry folder publishing');
          }
        }
        // Existing notes publish content through their conflict-aware per-note
        // path. Folder reconciliation only updates metadata, never a stale
        // encrypted snapshot.
        await updateSharedNote(
          api,
          note,
          relativePath,
          undefined,
          accessMode,
        );
        note.contentHash = hash;
        note.accessMode = accessMode;
        updated++;
      } else {
        unchanged++;
      }
      note.shareUrl = normalizeOfficialShareUrl(note.shareUrl, options.serverUrl);
      if (existingNote && !hasOwnerFrontmatter(app, file, note)) {
        await attachOwnerFrontmatter(app, file, note);
      }
      // Persist a new or changed remote identity before asset upload. If an asset
      // fails, the next run updates this same note rather than creating an orphan.
      nextEntries[relativePath] = note;
      if (JSON.stringify(note) !== trackedJson) await saveEntries();
      if (!shouldContinue()) return cancelledResult();
      if (!await uploadImages(app, api, file, body, note, shouldContinue, saveEntries)) return cancelledResult();
    } catch (error) {
      if (!shouldContinue()) return cancelledResult();
      failed.push({ path: relativePath, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!shouldContinue()) return cancelledResult();

  if (failed.length > 0) {
    await saveEntries();
    return { state, created, updated, unchanged, removedFromIndex, failed, cancelled: false };
  }

  state.entries = nextEntries;
  const entries: FolderManifestEntry[] = Object.entries(nextEntries).map(([path, note]) => ({
    path,
    shareUrl: note.shareUrl,
  }));
  const publishedAt = new Date().toISOString();
  const manifestBody = serializeFolderManifest(folderName, entries, publishedAt);
  options.onProgress?.({ phase: 'manifest', completed: files.length, total: files.length });
  if (!shouldContinue()) return cancelledResult();
  try {
    if (state.manifest?.roomTokenPending) await secureSharedNote(api, state.manifest);
    if (!state.manifest) {
      state.manifest = await createSharedNote(
        api, options.serverUrl, `Folder: ${folderName}`, manifestBody, 'read_only', options.expiresIn,
        async (pending) => {
          state.manifest = pending;
          await save();
        },
      );
    } else {
      await updateSharedNote(api, state.manifest, `Folder: ${folderName}`, manifestBody);
      state.manifest.contentHash = await contentHash(manifestBody);
    }
    state.lastPublishedAt = publishedAt;
    await save();
    if (!shouldContinue()) return cancelledResult();
  } catch (error) {
    if (!shouldContinue()) return cancelledResult();
    failed.push({ path: '[folder index]', message: error instanceof Error ? error.message : String(error) });
  }

  return {
    state,
    shareUrl: failed.length === 0 ? state.manifest?.shareUrl : undefined,
    created,
    updated,
    unchanged,
    removedFromIndex,
    failed,
    cancelled: false,
  };
}

import { TFile, TFolder, normalizePath, type App } from 'obsidian';
import type { ApiClient } from '../api/client';
import { decrypt, deriveRoomToken, deriveWriteCapability, encrypt, encryptBinary, generateKey } from '../crypto/crypto';
import { parseFrontmatter } from '../session/sessions';
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
  accessMode: FolderAccessMode;
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
): Promise<boolean> {
  for (const filename of findImageEmbeds(body)) {
    if (!shouldContinue()) return false;
    const image = resolveImage(app, filename, file);
    if (!image) continue;
    const bytes = await app.vault.readBinary(image);
    if (!shouldContinue()) return false;
    const encryptedData = await encryptBinary(bytes, note.encryptionKey);
    if (!shouldContinue()) return false;
    const uploaded = await api.uploadImage(note.roomId, filename, encryptedData, mimeType(filename));
    if (!uploaded) throw new Error(`Failed to upload ${filename}`);
    if (!shouldContinue()) return false;
  }
  return true;
}

async function createSharedNote(
  api: ApiClient,
  serverUrl: string,
  title: string,
  body: string,
  accessMode: FolderAccessMode,
  expiresIn?: number,
): Promise<FolderPublishedNote> {
  const encryptionKey = await generateKey();
  const result = await api.shareNote({
    encryptedTitle: await encrypt(title, encryptionKey),
    encryptedContent: await encrypt(body, encryptionKey),
    accessMode,
    expiresIn,
  });
  const [roomToken, writeToken] = await Promise.all([
    deriveRoomToken(encryptionKey, result.shareId),
    deriveWriteCapability(encryptionKey, result.shareId),
  ]);
  if (!await api.setRoomToken(result.shareId, roomToken, writeToken)) {
    throw new Error('Failed to secure the shared note');
  }
  return {
    roomId: result.shareId,
    linkShareId: result.shareId,
    shareUrl: shareUrl(serverUrl, result.shareId, encryptionKey),
    encryptionKey,
    contentHash: await contentHash(body),
    accessMode,
    expiresAt: result.expiresAt,
  };
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

/**
 * Reconcile a local folder into ordinary encrypted note shares plus one encrypted index note.
 * State should be persisted in plugin data after every callback. Missing local files disappear
 * from the next index, but their remote shares are deliberately never deleted.
 */
export async function publishFolder(
  app: App,
  api: ApiClient,
  options: PublishFolderOptions,
): Promise<PublishFolderResult> {
  const folderPath = normalizePath(options.folderPath).replace(/\/$/, '');
  if (!(app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
    throw new Error(`Vault folder not found: ${folderPath}`);
  }
  const folderName = folderPath.split('/').pop() || 'Shared folder';
  const previous = options.previousState?.folderPath === folderPath
    ? options.previousState
    : undefined;
  const state: FolderShareState = previous
    ? structuredClone(previous)
    : { version: 1, folderPath, watching: true, folderName, accessMode: options.accessMode, entries: {} };
  state.serverUrl = options.serverUrl;
  state.ownerUid = options.ownerUid;
  state.entries = Object.fromEntries(Object.entries(state.entries).map(([path, note]) => [
    path,
    normalizePublishedNote(note, options.serverUrl),
  ]));
  if (state.manifest) state.manifest = normalizePublishedNote(state.manifest, options.serverUrl);
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

  const cancelledResult = async (): Promise<PublishFolderResult> => {
    state.entries = { ...state.entries, ...nextEntries };
    await options.saveState?.(state);
    return { state, created, updated, unchanged, removedFromIndex, failed, cancelled: true };
  };

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const relativePath = file.path.slice(folderPath.length + 1);
    options.onProgress?.({ phase: 'notes', completed: index, total: files.length, path: relativePath });
    if (!shouldContinue()) return cancelledResult();

    try {
      const { body } = parseFrontmatter(await app.vault.read(file));
      if (!shouldContinue()) return cancelledResult();
      const hash = await contentHash(body);
      if (!shouldContinue()) return cancelledResult();
      let note: FolderPublishedNote | undefined = state.entries[relativePath]
        || frontmatterNote(app, file, options.serverUrl);
      let renamed = false;
      if (!note) {
        note = availableRenames.get(hash);
        renamed = !!note;
        if (note) availableRenames.delete(hash);
      }
      const existingNote = !!note;
      if (!note) {
        note = await createSharedNote(api, options.serverUrl, relativePath, body, options.accessMode, options.expiresIn);
        await attachOwnerFrontmatter(app, file, note);
        created++;
      } else if (note.contentHash !== hash || renamed || note.accessMode !== options.accessMode) {
        const bodyChanged = note.contentHash !== hash;
        const requiresLiveSync = bodyChanged && note.accessMode === 'public_edit';
        if (!hasOwnerFrontmatter(app, file, note)) await attachOwnerFrontmatter(app, file, note);
        if (requiresLiveSync && !options.canPublishEditable?.(file)) {
          throw new Error('Open this editable note and wait for NoteColab sync before publishing its local changes');
        }
        if (bodyChanged) {
          const remote = await api.getNoteContent(note.roomId);
          if (!shouldContinue()) return cancelledResult();
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
          options.accessMode,
        );
        note.contentHash = hash;
        note.accessMode = options.accessMode;
        updated++;
      } else {
        unchanged++;
      }
      note.shareUrl = normalizeOfficialShareUrl(note.shareUrl, options.serverUrl);
      if (existingNote && !hasOwnerFrontmatter(app, file, note)) {
        await attachOwnerFrontmatter(app, file, note);
      }
      // Persist the new remote identity before asset upload. If an asset fails,
      // the next run updates this same note rather than creating an orphan.
      nextEntries[relativePath] = note;
      state.entries = { ...state.entries, ...nextEntries };
      await options.saveState?.(state);
      if (!shouldContinue()) return cancelledResult();
      if (!await uploadImages(app, api, file, body, note, shouldContinue)) return cancelledResult();
    } catch (error) {
      if (!shouldContinue()) return cancelledResult();
      failed.push({ path: relativePath, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!shouldContinue()) return cancelledResult();

  if (failed.length > 0) {
    state.entries = { ...state.entries, ...nextEntries };
    await options.saveState?.(state);
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
    if (!state.manifest) {
      state.manifest = await createSharedNote(api, options.serverUrl, `Folder: ${folderName}`, manifestBody, 'read_only', options.expiresIn);
    } else {
      await updateSharedNote(api, state.manifest, `Folder: ${folderName}`, manifestBody);
      state.manifest.contentHash = await contentHash(manifestBody);
    }
    state.lastPublishedAt = publishedAt;
    state.accessMode = options.accessMode;
    await options.saveState?.(state);
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

import { Notice, TFile, normalizePath, type App, type EventRef } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { ColabSettings } from '../types';
import type { ApiClient } from '../api/client';
import { decrypt, deriveRoomToken, deriveWriteCapability, encrypt, encryptBinary } from '../crypto/crypto';
import { websocketCredentials } from '../api/credentials';
import { downloadMissingAssets } from '../share/assets';
import { findImageEmbeds } from '../share/imageEmbeds';
import { hasMatchingEditableShareIdentity, hasMatchingShareIdentity } from './shareIdentity';
import type { NoteColabFrontmatter } from '../share/frontmatter';

// Strip frontmatter from note content — only the body syncs via Yjs
export function parseFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (match) {
    return { frontmatter: match[0], body: content.slice(match[0].length) };
  }
  return { frontmatter: '', body: content };
}

// --- Share Sync ---
// Connects plugin to the same Yjs room (using shareId) that the web editor uses,
// enabling real-time bidirectional sync between Obsidian and web editors.

export type ShareSaveState = 'saved-device' | 'uploading' | 'saved-server' | 'offline' | 'error';

export interface ShareSyncState {
  doc: Y.Doc;
  provider: WebsocketProvider;
  shareId: string;
  filePath: string;
  modifyRef: EventRef;
  healthInterval?: number;
  cleanupTimers: () => void;
  saveState: ShareSaveState;
}

const activeShareSyncs = new Map<string, ShareSyncState>();
const startingShareSyncs = new Map<string, string>();
const startingSharePaths = new Map<string, string>();
let shareSyncGeneration = 0;
const shareSyncListeners = new Set<() => void>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function localCheckpointKey(origin: string, roomId: string): string {
  return `notecolab:crdt:v1:${origin}:${roomId}`;
}

interface LocalCheckpointV2 {
  version: 2;
  document: string;
  vaultBaseline: string;
  pendingVault?: {
    body: string;
    baseline: string;
  };
}

function serializeLocalCheckpoint(
  doc: Y.Doc,
  fileDoc: Y.Doc,
  pendingVault: LocalCheckpointV2['pendingVault'],
): string {
  return JSON.stringify({
    version: 2,
    document: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    vaultBaseline: bytesToBase64(Y.encodeStateAsUpdate(fileDoc)),
    ...(pendingVault ? { pendingVault } : {}),
  } satisfies LocalCheckpointV2);
}

function parseLocalCheckpoint(value: string): LocalCheckpointV2 {
  try {
    const parsed = JSON.parse(value) as Partial<LocalCheckpointV2>;
    if (parsed.version === 2
      && typeof parsed.document === 'string'
      && typeof parsed.vaultBaseline === 'string') {
      return {
        version: 2,
        document: parsed.document,
        vaultBaseline: parsed.vaultBaseline,
        ...(parsed.pendingVault
          && typeof parsed.pendingVault.body === 'string'
          && typeof parsed.pendingVault.baseline === 'string'
          ? { pendingVault: parsed.pendingVault }
          : {}),
      };
    }
  } catch {
    // Version 1 stored only a raw base64 document update.
  }
  return { version: 2, document: value, vaultBaseline: value };
}

function replaceDocumentText(document: Y.Doc, body: string): void {
  const text = document.getText('content');
  if (text.toString() === body) return;
  document.transact(() => {
    text.delete(0, text.length);
    if (body) text.insert(0, body);
  });
}

/** Give simultaneous first loads the same immutable baseline, then edit with each peer's own ID. */
async function seedServerSnapshot(
  document: Y.Doc,
  body: string,
  roomId: string,
  version: number,
): Promise<void> {
  if (!body) return;
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(['notecolab-seed-v1', roomId, version, body]),
  )));
  const seed = new Y.Doc();
  try {
    seed.clientID = bytes.slice(0, 6).reduce((value, byte) => value * 256 + byte, 0);
    seed.getText('content').insert(0, body);
    Y.applyUpdate(document, Y.encodeStateAsUpdate(seed));
  } finally {
    seed.destroy();
  }
}

/**
 * Restore a device checkpoint without concatenating independently seeded text.
 * In the independent case, fileDoc is rebuilt as an ancestor of the canonical
 * document so subsequent vault diffs cannot reintroduce a second full-text seed.
 */
function mergeLocalCheckpoint(
  document: Y.Doc,
  fileDoc: Y.Doc,
  checkpoint: LocalCheckpointV2,
  localBody: string,
): boolean {
  const device = new Y.Doc();
  const baseline = new Y.Doc();
  try {
    Y.applyUpdate(device, base64ToBytes(checkpoint.document));
    const baselineUpdate = checkpoint.pendingVault?.body === localBody
      ? checkpoint.pendingVault.baseline
      : checkpoint.vaultBaseline;
    Y.applyUpdate(baseline, base64ToBytes(baselineUpdate));

    const serverVector = Y.decodeStateVector(Y.encodeStateVector(document));
    const deviceVector = Y.decodeStateVector(Y.encodeStateVector(device));
    const sharesHistory = [...deviceVector.keys()].some(client => serverVector.has(client));
    if (serverVector.size === 0 || sharesHistory) {
      Y.applyUpdate(document, Y.encodeStateAsUpdate(device));
      Y.applyUpdate(fileDoc, Y.encodeStateAsUpdate(baseline));
      return true;
    }
    if (deviceVector.size === 0) return false;

    const serverBody = document.getText('content').toString();
    const deviceBody = device.getText('content').toString();
    const storedBaselineBody = baseline.getText('content').toString();
    const canonicalBaseline = localBody === serverBody
      ? serverBody
      : localBody === deviceBody
        ? deviceBody
        : storedBaselineBody;

    // Anchor the file replica in the server's Yjs history, advance both docs
    // to the acknowledged visible baseline, then add recovery text only to the
    // merged document. fileDoc therefore remains a real ancestor of document.
    Y.applyUpdate(fileDoc, Y.encodeStateAsUpdate(document));
    const baselineVector = Y.encodeStateVector(fileDoc);
    replaceDocumentText(fileDoc, canonicalBaseline);
    Y.applyUpdate(document, Y.encodeStateAsUpdate(fileDoc, baselineVector));

    const recovered = serverBody === deviceBody
      ? serverBody
      : `${deviceBody}\n\n<<<<<<< NoteColab recovered server snapshot\n${serverBody}\n>>>>>>>`;
    replaceDocumentText(document, recovered);
    return true;
  } finally {
    device.destroy();
    baseline.destroy();
  }
}

function openCheckpointDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open('notecolab-sync-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('checkpoints');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readLocalCheckpoint(key: string): Promise<string | null> {
  const db = await openCheckpointDb();
  if (!db) {
    try { return window.localStorage?.getItem(key) || null; } catch { return null; }
  }
  return new Promise<string | null>((resolve) => {
    const request = db.transaction('checkpoints').objectStore('checkpoints').get(key);
    request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
    request.onerror = () => resolve(null);
  }).finally(() => db.close());
}

async function writeLocalCheckpoint(key: string, value: string): Promise<boolean> {
  const db = await openCheckpointDb();
  if (!db) {
    try {
      window.localStorage?.setItem(key, value);
      return window.localStorage?.getItem(key) === value;
    } catch {
      return false;
    }
  }
  const written = await new Promise<boolean>((resolve) => {
    const transaction = db.transaction('checkpoints', 'readwrite');
    transaction.objectStore('checkpoints').put(value, key);
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
    transaction.onabort = () => resolve(false);
  });
  db.close();
  return written;
}

export function onShareSyncChange(listener: () => void): () => void {
  shareSyncListeners.add(listener);
  return () => shareSyncListeners.delete(listener);
}

function notifyShareSyncChange() {
  for (const listener of shareSyncListeners) listener();
}

/** Get the MIME type for common image extensions */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  };
  return types[ext] || 'application/octet-stream';
}

// --- Snapshot publishing (Obsidian → server stored content) ---
//
// The Yjs relay's in-memory room state is separate from the encrypted REST
// snapshot. The web editor re-encrypts and
// PATCHes the stored snapshot on every change; the plugin must do the same or
// Obsidian edits never reach the snapshot the web loads. This is the *only* update
// path for read-only shares (which have no Yjs sync at all) and it guarantees edit
// shares persist even when no web peer is connected to bridge Yjs → server.

const snapshotTimers = new Map<string, number>();
const lastPublishedBody = new Map<string, string>();
const snapshotRetryDelays = new Map<string, number>();
const blockedSnapshotPaths = new Set<string>();

function isManualSnapshot(frontmatter: string): boolean {
  return /^colab_update_mode:\s*["']?snapshot["']?\s*$/m.test(frontmatter);
}

/** Re-encrypt the note body and a matching CRDT checkpoint, then PATCH them together. */
export function publishSnapshot(
  app: App,
  api: ApiClient,
  file: TFile,
  shareId: string,
  encryptionKey: string,
  delay = 800,
  linkShareId = shareId,
  retry = false,
): void {
  if (!encryptionKey) return;
  if (retry && blockedSnapshotPaths.has(file.path)) return;
  if (!retry) blockedSnapshotPaths.delete(file.path);
  const prev = snapshotTimers.get(file.path);
  if (prev) window.clearTimeout(prev);
  snapshotTimers.set(file.path, window.setTimeout(() => { void (async () => {
    snapshotTimers.delete(file.path);
    try {
      const content = await app.vault.read(file);
      const { frontmatter, body } = parseFrontmatter(content);
      if (isManualSnapshot(frontmatter)) {
        blockedSnapshotPaths.add(file.path);
        return;
      }
      if (!hasMatchingShareIdentity(
        frontmatter,
        shareId,
        ['read_only', 'public_edit', 'invited_edit'],
      )) return;
      if (lastPublishedBody.get(file.path) === body) return; // nothing changed since last publish
      const note = await api.getNoteContent(linkShareId);
      if (!note) throw new Error('Could not load snapshot version');
      const snapshotDoc = new Y.Doc();
      let restoredCrdt = false;
      if (note.encryptedCrdt) {
        try {
          Y.applyUpdate(snapshotDoc, base64ToBytes(await decrypt(note.encryptedCrdt, encryptionKey)));
          restoredCrdt = true;
        } catch {
          // Legacy or damaged checkpoints fall back to a fresh encrypted state.
        }
      }
      if (!restoredCrdt && note.encryptedContent) {
        const storedBody = await decrypt(note.encryptedContent, encryptionKey);
        await seedServerSnapshot(snapshotDoc, storedBody, shareId, note.contentVersion || 1);
      }
      const snapshotText = snapshotDoc.getText('content');
      const previous = snapshotText.toString();
      let start = 0;
      while (start < previous.length && start < body.length && previous[start] === body[start]) start++;
      let oldEnd = previous.length, newEnd = body.length;
      while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === body[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      snapshotDoc.transact(() => {
        if (oldEnd > start) snapshotText.delete(start, oldEnd - start);
        if (newEnd > start) snapshotText.insert(start, body.slice(start, newEnd));
      });
      const [encrypted, encryptedCrdt] = await Promise.all([
        encrypt(body, encryptionKey),
        encrypt(bytesToBase64(Y.encodeStateAsUpdate(snapshotDoc)), encryptionKey),
      ]);
      snapshotDoc.destroy();
      const latestContent = await app.vault.read(file);
      const latest = parseFrontmatter(latestContent);
      if (latest.body !== body || !hasMatchingShareIdentity(
        latest.frontmatter,
        shareId,
        ['read_only', 'public_edit', 'invited_edit'],
      )) return;
      const result = await api.updateSnapshot(linkShareId, {
        encryptedContent: encrypted,
        encryptedCrdt,
        baseVersion: note.contentVersion || 1,
      });
      if (!result.ok) {
        if (result.status === 403 || result.status === 404 || result.status === 410) {
          blockedSnapshotPaths.add(file.path);
          return;
        }
        const retryDelay = snapshotRetryDelays.get(file.path) || 1_000;
        snapshotRetryDelays.set(file.path, Math.min(retryDelay * 2, 30_000));
        publishSnapshot(app, api, file, shareId, encryptionKey, retryDelay, linkShareId, true);
        return;
      }
      snapshotRetryDelays.delete(file.path);
      lastPublishedBody.set(file.path, body);
      // Upload any newly-referenced images so they render on the web
      const afterPublish = parseFrontmatter(await app.vault.read(file));
      if (afterPublish.body === body && hasMatchingShareIdentity(
        afterPublish.frontmatter,
        shareId,
        ['read_only', 'public_edit', 'invited_edit'],
      )) {
        await uploadReferencedImages(
          app,
          api,
          file,
          shareId,
          linkShareId,
          encryptionKey,
          body,
        );
      }
    } catch (e) {
      console.error('Colab publishSnapshot error:', e);
      const retryDelay = snapshotRetryDelays.get(file.path) || 1_000;
      snapshotRetryDelays.set(file.path, Math.min(retryDelay * 2, 30_000));
      if (!blockedSnapshotPaths.has(file.path)) {
        publishSnapshot(app, api, file, shareId, encryptionKey, retryDelay, linkShareId, true);
      }
    }
  })(); }, delay));
}

/** Cancel a pending snapshot publish and forget cached state for a file. */
export function cancelSnapshot(filePath: string): void {
  blockedSnapshotPaths.add(filePath);
  const t = snapshotTimers.get(filePath);
  if (t) window.clearTimeout(t);
  snapshotTimers.delete(filePath);
  lastPublishedBody.delete(filePath);
  snapshotRetryDelays.delete(filePath);
}

/** Decrypt the newest retained revision into a separate, unshared local file. */
export async function recoverPreviousSnapshot(
  app: App,
  api: ApiClient,
  file: TFile,
  shareId: string,
  encryptionKey: string,
  linkShareId = shareId,
): Promise<TFile | null> {
  const current = parseFrontmatter(await app.vault.read(file));
  if (!hasMatchingShareIdentity(
    current.frontmatter,
    shareId,
    ['read_only', 'public_edit', 'invited_edit'],
  )) return null;
  const history = await api.getNoteHistory(linkShareId);
  const revision = history?.revisions.find((candidate) => candidate.encryptedContent);
  if (!revision?.encryptedContent) return null;
  const body = await decrypt(revision.encryptedContent, encryptionKey);
  const directory = file.parent?.path ? `${file.parent.path}/` : '';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const basename = `${file.basename} recovered ${timestamp}`;
  let path = normalizePath(`${directory}${basename}.md`);
  let counter = 2;
  while (app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(`${directory}${basename} ${counter}.md`);
    counter++;
  }
  return app.vault.create(path, body);
}

/** Upload any image embeds referenced in body that aren't on the server yet. */
async function uploadReferencedImages(
  app: App,
  api: ApiClient,
  file: TFile,
  shareId: string,
  linkShareId: string,
  encryptionKey: string,
  body: string
): Promise<void> {
  const imageNames = findImageEmbeds(body);
  if (imageNames.length === 0) return;
  let serverImages: Set<string>;
  try {
    serverImages = new Set((await api.listImages(linkShareId)).map((i) => i.filename));
  } catch {
    return;
  }
  for (const imgName of imageNames) {
    if (serverImages.has(imgName)) continue;
    const imgFile = app.metadataCache.getFirstLinkpathDest(imgName, file.path);
    if (!imgFile) continue;
    try {
      const data = await app.vault.readBinary(imgFile);
      const enc = await encryptBinary(data, encryptionKey);
      const current = parseFrontmatter(await app.vault.read(file));
      if (!hasMatchingShareIdentity(
        current.frontmatter,
        shareId,
        ['read_only', 'public_edit', 'invited_edit'],
      )) return;
      await api.uploadImage(linkShareId, imgName, enc, getMimeType(imgName));
    } catch (e) {
      console.warn(`Colab: failed to upload image ${imgName}:`, e);
    }
  }
}

export function getShareSync(filePath: string): ShareSyncState | undefined {
  return activeShareSyncs.get(filePath);
}

export function getShareSyncShareId(filePath: string): string | undefined {
  return activeShareSyncs.get(filePath)?.shareId;
}

export function getShareSyncPathByShareId(shareId: string): string | undefined {
  for (const state of activeShareSyncs.values()) {
    if (state.shareId === shareId) return state.filePath;
  }
  return startingSharePaths.get(shareId);
}

export function getShareSyncStatus(filePath: string): 'connected' | 'connecting' | 'disconnected' | null {
  const state = activeShareSyncs.get(filePath);
  if (!state) return null;
  return state.provider.wsconnected ? 'connected' : state.provider.wsconnecting ? 'connecting' : 'disconnected';
}

export function getShareSaveState(filePath: string): ShareSaveState | null {
  return activeShareSyncs.get(filePath)?.saveState ?? null;
}

export async function startShareSync(
  app: App,
  settings: ColabSettings,
  file: TFile,
  shareId: string,
  api?: ApiClient,
  encryptionKey?: string,
  // Base URL of the server hosting this note. Defaults to the configured
  // server, but a cross-server share link carries its own origin so the relay
  // WebSocket must connect there instead. The relay authorizes read_only /
  // public_edit links by shareId + derived room token, so no account on that
  // server is needed. (issue #8)
  origin?: string,
  // The exact link that granted access. This may differ from the canonical
  // room ID when a note has multiple links with different permissions.
  linkShareId?: string,
): Promise<void> {
  const permissionShareId = linkShareId || shareId;
  const startingPath = file.path;
  const generation = shareSyncGeneration;
  if (activeShareSyncs.has(startingPath) || startingShareSyncs.has(startingPath)) return;
  if (getShareSyncPathByShareId(shareId)) return;
  startingShareSyncs.set(startingPath, shareId);
  startingSharePaths.set(shareId, startingPath);
  let pendingDoc: Y.Doc | null = null;
  let pendingProvider: WebsocketProvider | null = null;

  try {
    const initialContent = await app.vault.read(file);
    if (generation !== shareSyncGeneration) return;
    const initialFrontmatter = parseFrontmatter(initialContent).frontmatter;
    if (!hasMatchingEditableShareIdentity(initialFrontmatter, shareId)) return;

    const doc = new Y.Doc();
    pendingDoc = doc;
    const ytext = doc.getText('content');

    // The file is a delayed replica, not a replacement for the live document.
    // Keep its Yjs version so local edits cannot delete unseen remote characters.
    const fileDoc = new Y.Doc();
    const fileText = fileDoc.getText('content');
    let initialized = false;
    let writingToYjs = false;
    let disposed = false;
    let contentVersion = 1;
    let saveState: ShareSaveState = 'saved-server';
    let initialSnapshotNeeded = false;
    const checkpointKey = localCheckpointKey(origin || settings.serverUrl, shareId);

    function setSaveState(next: ShareSaveState): void {
      if (saveState === next) return;
      saveState = next;
      const active = activeShareSyncs.get(file.path);
      if (active) active.saveState = next;
      notifyShareSyncChange();
    }

    function acceptFileEdit(body: string) {
      const previous = fileText.toString();
      if (body === previous) return;
      let start = 0;
      while (start < previous.length && start < body.length && previous[start] === body[start]) start++;
      let oldEnd = previous.length, newEnd = body.length;
      while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === body[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      const version = Y.encodeStateVector(fileDoc);
      fileDoc.transact(() => {
        if (oldEnd > start) fileText.delete(start, oldEnd - start);
        if (newEnd > start) fileText.insert(start, body.slice(start, newEnd));
      });
      writingToYjs = true;
      try {
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(fileDoc, version));
      } finally {
        writingToYjs = false;
      }
    }

    // Hydrate the shared CRDT from the encrypted REST checkpoint before opening
    // the relay. Every reconnect therefore starts from the same Yjs identities,
    // while edits made to the vault during downtime are applied as a local diff.
    if (api && encryptionKey) {
      const note = await api.getNoteContent(permissionShareId);
      if (generation !== shareSyncGeneration) return;
      if (note) {
        contentVersion = note.contentVersion || 1;
        let storedBody = '';
        try {
          storedBody = note.encryptedContent ? await decrypt(note.encryptedContent, encryptionKey) : '';
        } catch (error) {
          console.warn('Colab: encrypted snapshot could not be restored:', error);
        }
        if (note.encryptedCrdt) {
          let restoredCrdt = false;
          try {
            Y.applyUpdate(doc, base64ToBytes(await decrypt(note.encryptedCrdt, encryptionKey)));
            restoredCrdt = true;
          } catch (error) {
            console.warn('Colab: encrypted collaboration checkpoint could not be restored:', error);
          }
          if (!restoredCrdt && storedBody) {
            await seedServerSnapshot(doc, storedBody, shareId, contentVersion);
            initialSnapshotNeeded = true;
          }
        } else if (note.encryptedContent) {
          await seedServerSnapshot(doc, storedBody, shareId, contentVersion);
          initialSnapshotNeeded = true;
        }

        const localBody = parseFrontmatter(initialContent).body;
        const localCheckpoint = await readLocalCheckpoint(checkpointKey);
        let restoredLocalBaseline = false;
        if (localCheckpoint) {
          try {
            const checkpoint = parseLocalCheckpoint(await decrypt(localCheckpoint, encryptionKey));
            restoredLocalBaseline = mergeLocalCheckpoint(doc, fileDoc, checkpoint, localBody);
          } catch {
            // A stale checkpoint encrypted with an old key is harmless.
          }
        }
        if (restoredLocalBaseline) {
          acceptFileEdit(localBody);
        } else {
          Y.applyUpdate(fileDoc, Y.encodeStateAsUpdate(doc));
          const serverBody = ytext.toString();
          if (localBody !== serverBody) {
            // Upgrade path for a vault that predates durable checkpoints. There
            // is no common CRDT baseline, so surface both versions rather than
            // guessing which characters to delete.
            const recovered = `${localBody}\n\n<<<<<<< NoteColab recovered server snapshot\n${serverBody}\n>>>>>>>`;
            acceptFileEdit(recovered);
          }
        }
        if (ytext.toString() !== storedBody) initialSnapshotNeeded = true;
        initialized = true;
      }
    }

    // Debounced file writer — batches rapid remote Yjs changes into a single file write
    let writeTimer: number | null = null;
    let fileWriteQueue = Promise.resolve();
    let pendingVault: LocalCheckpointV2['pendingVault'];
    function queueFileWrite(): Promise<void> {
      fileWriteQueue = fileWriteQueue.then(async () => {
        if (disposed) return;
        try {
          const fileContent = await app.vault.read(file);
          if (disposed) return;
          const { frontmatter, body } = parseFrontmatter(fileContent);
          if (!hasMatchingEditableShareIdentity(frontmatter, shareId)) {
            stopShareSync(app, file.path);
            return;
          }
          if (initialized) acceptFileEdit(body);
          const remoteBody = ytext.toJSON();
          const mirroredVersion = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(fileDoc));
          if (remoteBody !== body) {
            if (disposed) return;
            const pendingBaseline = new Y.Doc();
            Y.applyUpdate(pendingBaseline, Y.encodeStateAsUpdate(fileDoc));
            Y.applyUpdate(pendingBaseline, mirroredVersion);
            pendingVault = {
              body: remoteBody,
              baseline: bytesToBase64(Y.encodeStateAsUpdate(pendingBaseline)),
            };
            pendingBaseline.destroy();
            await app.vault.modify(file, frontmatter + remoteBody);
          }
          if (disposed) return;
          Y.applyUpdate(fileDoc, mirroredVersion);
          pendingVault = undefined;
          initialized = true;
          // Persist only after vault.modify resolves and fileDoc advances. A
          // checkpoint written while the mirror is pending must retain the
          // older acknowledged baseline so restart cannot treat unseen remote
          // text as a local deletion.
          void persistLocalCheckpoint();
          // After writing text, sync any missing images
          if (!disposed && api && encryptionKey) {
            syncMissingImages(remoteBody);
          }
        } catch (e) {
          console.error('Share sync yjs→file error:', e);
        }
      });
      return fileWriteQueue;
    }

    function scheduleFileWrite() {
      if (writeTimer) window.clearTimeout(writeTimer);
      writeTimer = window.setTimeout(() => {
        writeTimer = null;
        void queueFileWrite();
      }, 50);
    }

    // Download images referenced in synced text that are missing from the vault
    let imageSyncTimer: number | null = null;
    function syncMissingImages(body: string) {
      if (imageSyncTimer) window.clearTimeout(imageSyncTimer);
      imageSyncTimer = window.setTimeout(() => { void (async () => {
        imageSyncTimer = null;
        if (disposed) return;
        const imageNames = findImageEmbeds(body);
        if (imageNames.length === 0) return;
        const noteFolder = file.path.substring(0, file.path.lastIndexOf('/')) || '';
        if (disposed) return;
        await downloadMissingAssets(
          app,
          api!,
          permissionShareId,
          encryptionKey!,
          imageNames,
          noteFolder,
          file.path,
          () => !disposed,
        );
      })(); }, 500);
    }

    // Upload images referenced in text that aren't yet on the server
    const uploadedImages = new Set<string>(); // track already-uploaded filenames this session
    let imageUploadTimer: number | null = null;
    function uploadNewImages(body: string) {
      if (imageUploadTimer) window.clearTimeout(imageUploadTimer);
      imageUploadTimer = window.setTimeout(() => { void (async () => {
        imageUploadTimer = null;
        if (disposed) return;
        const imageNames = findImageEmbeds(body);
        if (imageNames.length === 0) return;

        // Filter to only images we haven't uploaded yet this session
        const candidates = imageNames.filter(n => !uploadedImages.has(n));
        if (candidates.length === 0) return;

        // Check what's already on the server
        let serverImages: Set<string>;
        try {
          const list = await api!.listImages(permissionShareId);
          if (disposed) return;
          serverImages = new Set(list.map(i => i.filename));
        } catch (e) {
          console.warn('Share sync: failed to list server images:', e);
          return;
        }

        for (const imgName of candidates) {
          if (disposed) return;
          if (serverImages.has(imgName)) {
            uploadedImages.add(imgName);
            continue;
          }

          // Resolve image file in the vault
          const imgFile = app.metadataCache.getFirstLinkpathDest(imgName, file.path);
          if (!imgFile) continue;

          try {
            const imgData = await app.vault.readBinary(imgFile);
            if (disposed) return;
            const encryptedImg = await encryptBinary(imgData, encryptionKey!);
            if (disposed) return;
            const mimeType = getMimeType(imgName);
            await api!.uploadImage(permissionShareId, imgName, encryptedImg, mimeType);
            if (disposed) return;
            uploadedImages.add(imgName);
          } catch (e) {
            console.warn(`Share sync: failed to upload image ${imgName}:`, e);
          }
        }
      })(); }, 500);
    }

    let snapshotTimer: number | null = null;
    let retryTimer: number | null = null;
    let snapshotSaving = false;
    let snapshotDirty = false;
    let retryDelay = 1_000;
    let checkpointGeneration = 0;
    let checkpointWriteQueue = Promise.resolve(true);

    function queueCheckpointWrite(value: string, generation: number): Promise<boolean> {
      checkpointWriteQueue = checkpointWriteQueue.then(() => {
        if (generation !== checkpointGeneration) return true;
        return writeLocalCheckpoint(checkpointKey, value);
      });
      return checkpointWriteQueue;
    }

    async function persistLocalCheckpoint(): Promise<void> {
      if (!encryptionKey || disposed) return;
      const generation = ++checkpointGeneration;
      // Capture both states synchronously. fileDoc advances only after a vault
      // write succeeds, so it remains safe if cleanup races a pending write.
      const checkpoint = serializeLocalCheckpoint(doc, fileDoc, pendingVault);
      const encrypted = await encrypt(checkpoint, encryptionKey);
      if (generation !== checkpointGeneration) return;
      const written = await queueCheckpointWrite(encrypted, generation);
      if (generation !== checkpointGeneration) return;
      if (disposed) return;
      if (!written) {
        if (snapshotDirty) setSaveState('error');
      } else if (!snapshotSaving && snapshotDirty) {
        setSaveState('saved-device');
      }
    }

    function scheduleSnapshot(delay = 800): void {
      if (!api || !encryptionKey || disposed) return;
      snapshotDirty = true;
      setSaveState('uploading');
      void persistLocalCheckpoint();
      if (snapshotTimer) window.clearTimeout(snapshotTimer);
      snapshotTimer = window.setTimeout(() => {
        snapshotTimer = null;
        void flushSnapshot();
      }, delay);
    }

    async function flushSnapshot(): Promise<void> {
      if (!api || !encryptionKey || disposed || snapshotSaving || !snapshotDirty) return;
      snapshotSaving = true;
      snapshotDirty = false;
      setSaveState('uploading');
      try {
        const [encryptedContent, encryptedCrdt] = await Promise.all([
          encrypt(ytext.toString(), encryptionKey),
          encrypt(bytesToBase64(Y.encodeStateAsUpdate(doc)), encryptionKey),
        ]);
        if (disposed) return;
        const result = await api.updateSnapshot(permissionShareId, {
          encryptedContent,
          encryptedCrdt,
          baseVersion: contentVersion,
        });
        if (result.ok) {
          contentVersion = result.contentVersion || contentVersion + 1;
          retryDelay = 1_000;
          void persistLocalCheckpoint();
          setSaveState('saved-server');
        } else if (result.conflict) {
          contentVersion = result.conflict.contentVersion;
          if (result.conflict.encryptedCrdt) {
            const update = await decrypt(result.conflict.encryptedCrdt, encryptionKey);
            Y.applyUpdate(doc, base64ToBytes(update));
          } else if (result.conflict.encryptedContent) {
            // One-time migration collision with an older client. Preserve both
            // bodies visibly instead of choosing a winner.
            const remote = await decrypt(result.conflict.encryptedContent, encryptionKey);
            const local = ytext.toString();
            if (remote !== local) {
              ytext.delete(0, ytext.length);
              ytext.insert(0, `${local}\n\n<<<<<<< NoteColab recovered remote snapshot\n${remote}\n>>>>>>>`);
            }
          }
          snapshotDirty = true;
        } else if (result.status === 403 || result.status === 404 || result.status === 410) {
          setSaveState('error');
          new Notice('Colab: this note can no longer be saved. Your local vault copy was preserved.', 0);
          return;
        } else {
          snapshotDirty = true;
          setSaveState('offline');
          if (!retryTimer) {
            retryTimer = window.setTimeout(() => {
              retryTimer = null;
              void flushSnapshot();
            }, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30_000);
          }
        }
      } catch (error) {
        snapshotDirty = true;
        setSaveState('offline');
        console.warn('Colab: encrypted snapshot save will retry:', error);
        if (!retryTimer && !disposed) {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            void flushSnapshot();
          }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }
      } finally {
        snapshotSaving = false;
        if (snapshotDirty && !retryTimer && !disposed) scheduleSnapshot(50);
      }
    }

    // Connect WebSocket to same room as web editor
    const [roomToken, writeCapability] = encryptionKey
      ? await Promise.all([
          deriveRoomToken(encryptionKey, shareId),
          deriveWriteCapability(encryptionKey, shareId),
        ])
      : ['', ''];
    if (generation !== shareSyncGeneration) return;
    const latestContent = await app.vault.read(file);
    if (generation !== shareSyncGeneration) return;
    if (!hasMatchingEditableShareIdentity(parseFrontmatter(latestContent).frontmatter, shareId)) {
      doc.destroy();
      return;
    }
    if (api && writeCapability) {
      api = api.withWriteCapability(writeCapability);
    }
    if (api?.usesAccountCredentials && roomToken) {
      void api.setRoomToken(shareId, roomToken, writeCapability);
    }

    const preRelayVector = Y.encodeStateVector(doc);
    const preRelayBody = ytext.toString();
    const wsUrl = (origin || settings.serverUrl).replace(/^http/, 'ws');
    const provider = new WebsocketProvider(wsUrl + '/ws/yjs', shareId, doc, {
      params: {
        ...websocketCredentials(settings.apiKey, api?.usesAccountCredentials ?? !origin),
        link: permissionShareId,
        ...(roomToken ? { rt: roomToken } : {}),
      },
    });
    pendingProvider = provider;
    provider.on('status', ({ status }: { status: string }) => {
      if (disposed) return;
      if (status === 'disconnected' && snapshotDirty) setSaveState('offline');
      if (status === 'connected' && snapshotDirty) scheduleSnapshot(0);
    });

    // After initial sync with server, initialize content if needed
    const onSync = async (synced: boolean) => {
      if (!synced) return;
      provider.off('sync', onSync);

      try {
        const relayOnly = new Y.Doc();
        Y.applyUpdate(relayOnly, Y.encodeStateAsUpdate(doc, preRelayVector));
        const relayBody = relayOnly.getText('content').toString();
        relayOnly.destroy();
        const mergedBody = ytext.toString();
        const duplicatedBaseline = !!preRelayBody && mergedBody === preRelayBody + preRelayBody;
        const independentlySeeded = duplicatedBaseline || relayBody && (
          mergedBody === preRelayBody + relayBody
          || mergedBody === relayBody + preRelayBody
        );
        if (independentlySeeded) {
          const recoveredRelayBody = relayBody || preRelayBody;
          const recovered = !preRelayBody
            ? recoveredRelayBody
            : preRelayBody === recoveredRelayBody
              ? preRelayBody
              : `${preRelayBody}\n\n<<<<<<< NoteColab recovered live room\n${recoveredRelayBody}\n>>>>>>>`;
          ytext.delete(0, ytext.length);
          if (recovered) ytext.insert(0, recovered);
          initialSnapshotNeeded = true;
        }
        const fileContent = await app.vault.read(file);
        if (disposed) return;
        const { frontmatter, body } = parseFrontmatter(fileContent);
        if (!hasMatchingEditableShareIdentity(frontmatter, shareId)) {
          stopShareSync(app, file.path);
          return;
        }
        if (ytext.length === 0 && body) {
          // Server doc empty — we're first peer, push body content
          if (disposed) return;
          writingToYjs = true;
          try {
            ytext.insert(0, body);
          } finally {
            writingToYjs = false;
          }
        }
        // Establish the file's exact Yjs version before accepting file events.
        await queueFileWrite();
        if (disposed) return;
        scheduleFileWrite();
        if (initialSnapshotNeeded || ytext.toString() !== preRelayBody) scheduleSnapshot();
      } catch (e) {
        console.error('Share sync initial sync error:', e);
      }

      // Sync any missing images after initial content sync
      if (!disposed && api && encryptionKey) {
        syncMissingImages(ytext.toJSON());
        uploadNewImages(ytext.toJSON());
      }
    };
    provider.on('sync', onSync);

    // Remote Yjs changes → schedule file write
    ytext.observe(() => {
      if (!initialized) return;
      if (!writingToYjs) scheduleFileWrite();
      scheduleSnapshot();
    });

    // Local file changes → update Yjs body only (diff-based, frontmatter excluded)
    const modifyRef = app.vault.on('modify', (changed) => {
      if (changed.path !== file.path || !initialized || disposed) return;
      // Read after queued writes finish, including notifications delivered after
      // vault.modify resolves. Both directions must use the same file version.
      fileWriteQueue = fileWriteQueue.then(async () => {
        if (disposed) return;
        try {
          if (!(changed instanceof TFile)) return;
          const fileContent = await app.vault.read(changed);
          if (disposed) return;
          const { frontmatter, body } = parseFrontmatter(fileContent);
          if (!hasMatchingEditableShareIdentity(frontmatter, shareId)) {
            stopShareSync(app, file.path);
            return;
          }
          acceptFileEdit(body);
          if (body !== ytext.toString()) scheduleFileWrite();
          // Upload any new images referenced in the local content
          if (!disposed && api && encryptionKey) {
            uploadNewImages(body);
          }
          // Persist the snapshot too, so edits survive even when no web peer is
          // connected to bridge Yjs → server (the relay holds no durable state).
          if (!disposed && api && encryptionKey) scheduleSnapshot();
        } catch (e) {
          console.error('Share sync file→yjs error:', e);
        }
      });
      return fileWriteQueue;
    });

    const cleanupTimers = () => {
      void persistLocalCheckpoint();
      disposed = true;
      fileDoc.destroy();
      if (writeTimer) window.clearTimeout(writeTimer);
      if (imageSyncTimer) window.clearTimeout(imageSyncTimer);
      if (imageUploadTimer) window.clearTimeout(imageUploadTimer);
      if (snapshotTimer) window.clearTimeout(snapshotTimer);
      if (retryTimer) window.clearTimeout(retryTimer);
      writeTimer = null;
      imageSyncTimer = null;
      imageUploadTimer = null;
      snapshotTimer = null;
      retryTimer = null;
    };
    activeShareSyncs.set(file.path, {
      doc,
      provider,
      shareId,
      filePath: file.path,
      modifyRef,
      cleanupTimers,
      saveState,
    });
    pendingDoc = null;
    pendingProvider = null;
    notifyShareSyncChange();

    // Periodic health check: detect expiry or permission changes
    if (api) {
      const healthApi = api;
      let consecutiveFailures = 0;
      let lastFailureReason: string | null = null;
      const FAILURE_THRESHOLD = 3; // require 3 consecutive same-reason failures before acting

      const healthInterval = window.setInterval(() => { void (async () => {
        try {
          const meta = await healthApi.getNoteMeta(permissionShareId);
          if (disposed) return;

          // Classify this poll. `null` means a network/transient error (timeout,
          // 5xx, or a proxy/redeploy hiccup that can briefly 404) — treat it as
          // inconclusive and reset the streak. Only an *uninterrupted* run of the
          // *same* definitive failure may ever declare a note gone, so a flaky
          // connection can never be mistaken for a deletion. (issue #3)
          let reason: string | null = null;
          if (meta === null) {
            consecutiveFailures = 0;
            lastFailureReason = null;
            return;
          } else if (meta === 'expired') {
            reason = 'expired';
          } else if (meta === 'not_found') {
            reason = 'not_found';
          } else if (meta === 'forbidden') {
            reason = 'forbidden';
          } else if (meta.accessMode === 'read_only') {
            reason = 'read_only';
          }

          if (!reason) {
            // Healthy editable share — reset the streak.
            consecutiveFailures = 0;
            lastFailureReason = null;
            return;
          }

          // A definitive failure only counts toward the threshold while it keeps
          // returning the same reason; a different reason restarts the run.
          if (reason === lastFailureReason) {
            consecutiveFailures++;
          } else {
            consecutiveFailures = 1;
            lastFailureReason = reason;
          }

          if (consecutiveFailures >= FAILURE_THRESHOLD) {
            // Read the live basename so a renamed note shows its current title.
            const noteLabel = file.basename;
            if (reason === 'expired') {
              new Notice(`Colab: "${noteLabel}" — share link expired. Sync stopped.`, 0);
            } else if (reason === 'not_found') {
              new Notice(`Colab: "${noteLabel}" — shared note deleted. Sync stopped.`, 0);
            } else if (reason === 'forbidden') {
              new Notice(`Colab: "${noteLabel}" — access revoked. Sync stopped.`, 0);
            } else if (reason === 'read_only') {
              new Notice(`Colab: "${noteLabel}" — now read-only. Sync stopped.`, 0);
              await app.fileManager.processFrontMatter(file, (frontmatter: NoteColabFrontmatter) => {
                frontmatter.colab_access = 'read_only';
              });
            }
            stopShareSync(app, file.path);
          }
        } catch {
          // Unexpected error — don't break sync
        }
      })(); }, 30_000);
      const state = activeShareSyncs.get(file.path);
      if (state) state.healthInterval = healthInterval;
    }

  } finally {
    pendingProvider?.destroy();
    pendingDoc?.destroy();
    if (startingShareSyncs.get(startingPath) === shareId) {
      startingShareSyncs.delete(startingPath);
    }
    if (startingSharePaths.get(shareId) === startingPath) {
      startingSharePaths.delete(shareId);
    }
  }
}

export function stopShareSync(app: App, filePath: string): void {
  const state = activeShareSyncs.get(filePath);
  if (!state) return;
  if (state.healthInterval) window.clearInterval(state.healthInterval);
  state.cleanupTimers();
  app.vault.offref(state.modifyRef);
  state.provider.destroy();
  state.doc.destroy();
  activeShareSyncs.delete(filePath);
  notifyShareSyncChange();
  cancelSnapshot(filePath);
}

/**
 * Re-key an active sync (and its pending snapshot state) when its note is
 * moved or renamed. Without this a rename would orphan the session under the
 * old path — sync would silently stop and the note could be mistaken for a
 * deletion. Safe to call for any path; no-ops when nothing is tracked. (issue #3)
 */
export function renameShareSync(oldPath: string, newPath: string): void {
  if (oldPath === newPath) return;

  const state = activeShareSyncs.get(oldPath);
  if (state) {
    activeShareSyncs.delete(oldPath);
    state.filePath = newPath;
    activeShareSyncs.set(newPath, state);
    notifyShareSyncChange();
  }

  // Snapshot debounce + "last published body" are keyed by path too.
  const timer = snapshotTimers.get(oldPath);
  if (timer) {
    snapshotTimers.delete(oldPath);
    snapshotTimers.set(newPath, timer);
  }
  const body = lastPublishedBody.get(oldPath);
  if (body !== undefined) {
    lastPublishedBody.delete(oldPath);
    lastPublishedBody.set(newPath, body);
  }
  if (blockedSnapshotPaths.delete(oldPath)) blockedSnapshotPaths.add(newPath);
}

export function destroyAllShareSyncs(app: App): void {
  shareSyncGeneration++;
  for (const [path] of activeShareSyncs) {
    stopShareSync(app, path);
  }
}

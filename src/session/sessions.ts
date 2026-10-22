import { Notice, TFile, normalizePath, type App, type EventRef, type MarkdownView } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import type { ColabSettings, NoteContent } from '../types';
import type { ApiClient } from '../api/client';
import type { LiveProvider } from '../live/liveProvider';
import { LiveE2EProvider, type CheckpointSource } from '../live/provider';
import { deriveLiveKey, livePinId } from '../live/keys';
import { addRoomPin, isRoomPinned, liveOrigin, onRoomPinned, pinIfEncrypted } from '../live/pins';
import { readLiveMarker, resolveLiveMode, setLiveMarker, type LiveMode } from '../live/mode';
import { enableLiveE2E, type EnableLiveE2EResult } from '../live/enable';
import { base64ToBytes, bytesToBase64, carriesLiveMarker, decryptCrdt, encryptCrdt, hasHistory, seedClientId, seedUpdate } from '../live/checkpoint';
import { decrypt, deriveRoomToken, deriveWriteCapability, encrypt, encryptBinary } from '../crypto/crypto';
import { websocketCredentials } from '../api/credentials';
import { downloadMissingAssets } from '../share/assets';
import { findImageEmbeds } from '../share/imageEmbeds';
import { hasMatchingEditableShareIdentity, hasMatchingShareIdentity, ownsShare } from './shareIdentity';
import { documentMatchesSnapshot, mergedIndependentHistory } from './independentHistory';
import type { NoteColabFrontmatter } from '../share/frontmatter';
import { editableCopyBasename, stripColabMetadata } from '../share/readOnlyMirror';

// Strip frontmatter from note content — only the body syncs via Yjs
export function parseFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (match) {
    return { frontmatter: match[0], body: content.slice(match[0].length) };
  }
  return { frontmatter: '', body: content };
}

/**
 * Imports leave a blank line after the frontmatter; the vault still only shows
 * the stored body. A deliberate leading blank line is the most this can drop.
 */
function showsStoredBody(body: string, stored: string | null): boolean {
  return stored !== null && (body === stored || body === `\n${stored}`);
}

// --- Share Sync ---
// Connects plugin to the same Yjs room (using shareId) that the web editor uses,
// enabling real-time bidirectional sync between Obsidian and web editors.

export type ShareSaveState = 'saved-device' | 'uploading' | 'saved-server' | 'offline' | 'error';

/** Encrypted live collaboration controls of a session (docs/LIVE-E2E-ENCRYPTION.md). */
export interface LiveControls {
  readonly mode: LiveMode;
  /** An `e2e` note whose history could not be loaded from any source yet (§5.1 step 2). */
  readonly historyMissing: boolean;
  /** Pull from peers and the checkpoint, e.g. when Obsidian regains focus (§5.2). */
  resync(): void;
  /** Owner only: reseed a note with missing history from its saved Markdown. */
  repair(): Promise<boolean>;
  /** Owner only: switch this note to encrypted live mode (§6.2). */
  enable(): Promise<EnableLiveE2EResult>;
}

export interface ShareSyncState {
  doc: Y.Doc;
  provider: LiveProvider;
  live?: LiveControls;
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

// Sessions whose startup failed transiently (offline, timeout, server restart),
// keyed by vault path. Delays persist across attempts; timers are cancellable.
const startRetryDelays = new Map<string, number>();
const startRetryTimers = new Map<string, { timer: number; retry: () => void }>();

function retryStartsNow(): void {
  for (const { retry } of [...startRetryTimers.values()]) retry();
}

function clearStartRetryTimer(path: string): void {
  const pending = startRetryTimers.get(path);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  startRetryTimers.delete(path);
  if (startRetryTimers.size === 0) window.removeEventListener('online', retryStartsNow);
}

function forgetStartRetry(path: string): void {
  clearStartRetryTimer(path);
  startRetryDelays.delete(path);
}

/** Retry after 2 s, doubling to 60 s, and immediately when the device comes back online. */
function scheduleStartRetry(file: TFile, start: () => void): void {
  const path = file.path;
  const previous = startRetryDelays.get(path);
  if (previous === undefined) {
    new Notice(`Colab: couldn't reach the server for "${file.basename}". Your vault copy is unchanged; NoteColab will keep retrying.`);
  }
  const delay = previous === undefined ? 2_000 : Math.min(previous * 2, 60_000);
  startRetryDelays.set(path, delay);
  clearStartRetryTimer(path);
  if (startRetryTimers.size === 0) window.addEventListener('online', retryStartsNow);
  const retry = () => {
    // The file may have been renamed since; retries are re-keyed with it.
    clearStartRetryTimer(file.path);
    start();
  };
  startRetryTimers.set(path, { timer: window.setTimeout(retry, delay), retry });
}
const shareSyncListeners = new Set<() => void>();

let liveHooks = {
  settings: (): ColabSettings | null => null,
  saveSettings: async (): Promise<void> => {},
  client: 'obsidian',
};

/** The plugin persists room pins and reports its version to encrypted rooms (§6.1, §6.2). */
export function configureLiveSessions(hooks: typeof liveHooks): void {
  liveHooks = hooks;
}

function pinRoom(settings: ColabSettings, origin: string, pinId: string): void {
  if (addRoomPin(settings, origin, pinId)) void liveHooks.saveSettings();
}

/**
 * Pin a note any fetch shows as encrypted, so a later plain report can't lift it
 * (§6.1). Returns whether the note is pinned. `origin` is '' for the configured server.
 */
export async function rememberEncrypted(
  origin: string,
  noteKey: string,
  roomId: string,
  note: Parameters<typeof pinIfEncrypted>[4],
): Promise<boolean> {
  const settings = liveHooks.settings();
  if (!settings) return false;
  if (await pinIfEncrypted(settings, origin, noteKey, roomId, note)) await liveHooks.saveSettings();
  return isRoomPinned(settings, liveOrigin(settings, origin), await livePinId(noteKey));
}

const REFUSED_LIVE_MODE = 'the server reports this note as unencrypted; live editing is paused to protect it.';
// The relay's 1008 reasons that mean the room's mode differs from the one joined.
const MODE_CLOSE_REASONS = new Set(['Update NoteColab to join this encrypted note', 'Room is not encrypted']);

async function waitUntil(condition: () => boolean, timeout: number): Promise<boolean> {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= end) return false;
    await new Promise(resolve => window.setTimeout(resolve, 50));
  }
  return true;
}

// Every vault in one Obsidian app shares IndexedDB, so the vault id keeps one
// vault's copy of a room from restoring another's checkpoint.
// The latest checkpoint of each note, set as soon as it is produced. A restart
// in this app session uses it instead of a durable copy that may be older
// (still being written, or failed), which would apply saved edits again.
const latestCheckpoints = new Map<string, { encryptionKey: string; checkpoint: string }>();
// Durable writes and deletes of a note's checkpoint run in the order they were
// issued, across sessions, so an older write or its cleanup never replaces or
// removes a newer checkpoint.
const checkpointWrites = new Map<string, Promise<boolean>>();
// A durable write or delete that has not settled by then counts as failed, so a
// stalled IndexedDB request cannot hold back the note's later checkpoints.
const CHECKPOINT_STEP_TIMEOUT = 3_000;

function settlesWithin<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), CHECKPOINT_STEP_TIMEOUT);
    const settle = (value: T) => { window.clearTimeout(timer); resolve(value); };
    promise.then(settle, () => settle(fallback));
  });
}

function localCheckpointKey(vaultId: string, origin: string, roomId: string): string {
  return `notecolab:crdt:v1:${vaultId}:${origin}:${roomId}`;
}

interface LocalCheckpointV2 {
  version: 2;
  document: string;
  vaultBaseline: string;
  // The server version the document includes; absent in older checkpoints.
  contentVersion?: number;
  pendingVault?: {
    body: string;
    baseline: string;
  };
}

function serializeLocalCheckpoint(
  doc: Y.Doc,
  fileDoc: Y.Doc,
  pendingVault: LocalCheckpointV2['pendingVault'],
  contentVersion: number,
): string {
  return JSON.stringify({
    version: 2,
    document: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    vaultBaseline: bytesToBase64(Y.encodeStateAsUpdate(fileDoc)),
    contentVersion,
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
        ...(typeof parsed.contentVersion === 'number' ? { contentVersion: parsed.contentVersion } : {}),
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

function checkpointHasHistory(checkpoint: LocalCheckpointV2): boolean {
  const device = new Y.Doc();
  try {
    Y.applyUpdate(device, base64ToBytes(checkpoint.document));
    return hasHistory(device);
  } finally {
    device.destroy();
  }
}

/**
 * Give simultaneous first loads the same immutable baseline, then edit with each
 * peer's own ID. Seeds only a document without history (checked after the async
 * digest), so text already present, e.g. from a live relay room, is adopted.
 * Returns the seed's client ID when it seeded.
 */
async function seedServerSnapshot(
  document: Y.Doc,
  body: string,
  roomId: string,
  version: number,
): Promise<number | null> {
  if (!body) return null;
  const clientId = await seedClientId(roomId, version, body);
  if (hasHistory(document)) return null;
  Y.applyUpdate(document, seedUpdate(clientId, body));
  return clientId;
}

/**
 * Restore a device checkpoint that shares the shared document's history. An
 * independent checkpoint is never merged into the shared note. Its text is
 * returned when it appears in neither the shared note nor the vault, so the
 * caller can keep it as an unshared local copy.
 */
function mergeLocalCheckpoint(
  document: Y.Doc,
  fileDoc: Y.Doc,
  checkpoint: LocalCheckpointV2,
  localBody: string,
  // Null for encrypted live notes: the server refuses their body-only saves.
  serverVersion: number | null,
): { restored: boolean; unsharedBody: string | null } {
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
    // A server without history takes the device's text only if nothing was saved
    // since the checkpoint: a later body-only save is an older app's reset.
    const unsavedSince = serverVersion === null
      || (checkpoint.contentVersion !== undefined && serverVersion <= checkpoint.contentVersion);
    if ((serverVector.size === 0 && unsavedSince) || sharesHistory) {
      Y.applyUpdate(document, Y.encodeStateAsUpdate(device));
      Y.applyUpdate(fileDoc, Y.encodeStateAsUpdate(baseline));
      return { restored: true, unsharedBody: null };
    }
    const deviceBody = device.getText('content').toString();
    const unshared = deviceBody
      && deviceBody !== document.getText('content').toString()
      && !localBody.includes(deviceBody);
    return { restored: false, unsharedBody: unshared ? deviceBody : null };
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

/** Deletes the checkpoint, or with `onlyIf`, only while it still holds that value. */
async function deleteLocalCheckpoint(key: string, onlyIf?: string): Promise<void> {
  const db = await openCheckpointDb();
  if (!db) {
    try {
      if (onlyIf === undefined || window.localStorage?.getItem(key) === onlyIf) window.localStorage?.removeItem(key);
    } catch { /* best effort */ }
    return;
  }
  await new Promise<void>((resolve) => {
    const transaction = db.transaction('checkpoints', 'readwrite');
    const store = transaction.objectStore('checkpoints');
    if (onlyIf === undefined) store.delete(key);
    else {
      const request = store.get(key);
      request.onsuccess = () => { if (request.result === onlyIf) store.delete(key); };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  db.close();
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
// View-only publishers have no live session; expose their state to the status bar.
const publisherSaveStates = new Map<string, ShareSaveState>();
const publisherNotices = new Set<string>();
// Rejected (size/quota) publications retry when the device comes back online.
const rejectedPublications = new Map<string, () => void>();

function retryRejectedPublications(): void {
  for (const retry of [...rejectedPublications.values()]) retry();
}

function forgetRejectedPublication(path: string): void {
  if (rejectedPublications.delete(path) && rejectedPublications.size === 0) {
    window.removeEventListener('online', retryRejectedPublications);
  }
}

function setPublisherState(path: string, state: ShareSaveState): void {
  if (publisherSaveStates.get(path) === state) return;
  publisherSaveStates.set(path, state);
  notifyShareSyncChange();
}

/** One persistent Notice per note until publication succeeds again. */
function noticePublisherOnce(file: TFile, message: string): void {
  if (publisherNotices.has(file.path)) return;
  publisherNotices.add(file.path);
  new Notice(`Colab: "${file.basename}" ${message}`, 0);
}

/** Validation, size, and quota rejections do not heal by retrying the same document. */
function isPermanentSaveFailure(status?: number): boolean {
  return status === 400 || status === 413 || status === 422;
}

/** Completes `Colab: "<note>" …` for a permanent rejection. */
function permanentSaveFailureReason(status?: number): string {
  return status === 413
    ? 'was rejected by the server because it is too large or the storage quota is full. Your vault copy was preserved; shorten the note or free up storage, then edit it to retry.'
    : 'was rejected by the server. Your vault copy was preserved; edit the note to retry.';
}

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
  // A pending backoff retry already reads the latest vault body.
  if (!retry && snapshotRetryDelays.has(file.path) && snapshotTimers.has(file.path)) return;
  const generation = shareSyncGeneration;
  const prev = snapshotTimers.get(file.path);
  if (prev) window.clearTimeout(prev);
  const retryPublish = () => {
    const retryDelay = snapshotRetryDelays.get(file.path) || 1_000;
    snapshotRetryDelays.set(file.path, Math.min(retryDelay * 2, 30_000));
    setPublisherState(file.path, 'offline');
    // About half a minute of consecutive failures: tell the owner once.
    if (retryDelay >= 16_000) {
      noticePublisherOnce(file, 'keeps failing to publish (offline or server unavailable). NoteColab keeps retrying; your vault copy is unchanged.');
    }
    publishSnapshot(app, api, file, shareId, encryptionKey, retryDelay, linkShareId, true);
  };
  snapshotTimers.set(file.path, window.setTimeout(() => { void (async () => {
    snapshotTimers.delete(file.path);
    try {
      const content = await app.vault.read(file);
      if (generation !== shareSyncGeneration) return;
      const { frontmatter, body } = parseFrontmatter(content);
      if (isManualSnapshot(frontmatter)) {
        blockedSnapshotPaths.add(file.path);
        return;
      }
      // Owners publish through their live session, which merges against the
      // vault's acknowledged baseline; diffing here would delete unseen text.
      if (ownsShare(frontmatter)) return;
      if (!hasMatchingShareIdentity(
        frontmatter,
        shareId,
        ['read_only', 'public_edit', 'invited_edit'],
      )) return;
      if (lastPublishedBody.get(file.path) === body) return; // nothing changed since last publish
      const note = await api.getNoteContent(linkShareId);
      if (generation !== shareSyncGeneration) return;
      if (!note) throw new Error('Could not load snapshot version');
      // Remembered, so a later plain report can't seed this body into a plain room (§6.1).
      const pinned = await rememberEncrypted('', encryptionKey, shareId, note);
      if (generation !== shareSyncGeneration) return;
      // An unmarked note shared before 1.24.2 that the server says this account
      // owns is an owner note: mark it so it live-syncs when open instead.
      if (note.ownerUid && note.ownerUid === api.accountUid) {
        await app.fileManager.processFrontMatter(file, (fm: NoteColabFrontmatter) => {
          if (fm.colab_share_id === shareId && fm.colab_owner === undefined) fm.colab_owner = true;
        });
        return;
      }
      const snapshotDoc = new Y.Doc();
      // Encrypted live notes accept only their room-bound checkpoint and are never seeded (§5.1, §7).
      // An encrypted checkpoint counts even if the server reports plain, so it is never re-saved as format 1.
      const restored = note.encryptedCrdt ? await decryptCrdt(note.encryptedCrdt, encryptionKey, shareId) : null;
      const live = note.liveMode === 'e2e' || !!restored?.encrypted || pinned;
      let restoredCrdt = false;
      if (restored && (!live || restored.format === 2)) {
        Y.applyUpdate(snapshotDoc, restored.update);
        restoredCrdt = true;
      }
      if (live && !restoredCrdt) {
        snapshotDoc.destroy();
        blockedSnapshotPaths.add(file.path);
        setPublisherState(file.path, 'error');
        noticePublisherOnce(file, "can't be published: its encrypted live history is missing or damaged. Your vault copy is unchanged; the owner can repair it from a live session.");
        return;
      }
      // Legacy or damaged checkpoints fall back to a fresh encrypted state.
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
        encryptCrdt(Y.encodeStateAsUpdate(snapshotDoc), encryptionKey, shareId, live ? 2 : 1),
      ]);
      snapshotDoc.destroy();
      const latestContent = await app.vault.read(file);
      if (generation !== shareSyncGeneration) return;
      const latest = parseFrontmatter(latestContent);
      if (latest.body !== body || !hasMatchingShareIdentity(
        latest.frontmatter,
        shareId,
        ['read_only', 'public_edit', 'invited_edit'],
      )) return;
      setPublisherState(file.path, 'uploading');
      // A note switched since it was read answers 409 live_e2e_update_required; the retry re-reads it.
      const result = await api.updateSnapshot(linkShareId, {
        encryptedContent: encrypted,
        encryptedCrdt,
        baseVersion: note.contentVersion || 1,
        ...(live ? { crdtFormat: 2 as const } : {}),
      });
      if (generation !== shareSyncGeneration) return;
      if (!result.ok) {
        if (result.status === 403 || result.status === 404 || result.status === 410) {
          blockedSnapshotPaths.add(file.path);
          setPublisherState(file.path, 'error');
          noticePublisherOnce(file, result.status === 410
            ? 'is no longer published because its share link expired. Your vault copy is unchanged; create a new link to publish it again.'
            : result.status === 404
              ? 'is no longer published because the shared note was deleted on the server. Your vault copy is unchanged; share it again to publish it.'
              : 'is no longer published because you can no longer update this share. Your vault copy is unchanged; share it again to publish it.');
          return;
        }
        if (isPermanentSaveFailure(result.status)) {
          snapshotRetryDelays.delete(file.path);
          setPublisherState(file.path, 'error');
          noticePublisherOnce(file, permanentSaveFailureReason(result.status));
          // Quota can be freed elsewhere: recheck slowly and on reconnect. A new
          // edit replaces this timer with an immediate attempt.
          if (rejectedPublications.size === 0) window.addEventListener('online', retryRejectedPublications);
          rejectedPublications.set(file.path, () => {
            forgetRejectedPublication(file.path);
            publishSnapshot(app, api, file, shareId, encryptionKey, 0, linkShareId, true);
          });
          publishSnapshot(app, api, file, shareId, encryptionKey, 300_000, linkShareId, true);
          return;
        }
        retryPublish();
        return;
      }
      snapshotRetryDelays.delete(file.path);
      publisherNotices.delete(file.path);
      forgetRejectedPublication(file.path);
      setPublisherState(file.path, 'saved-server');
      lastPublishedBody.set(file.path, body);
      // Upload any newly-referenced images so they render on the web
      const afterPublish = parseFrontmatter(await app.vault.read(file));
      if (generation !== shareSyncGeneration) return;
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
      if (generation !== shareSyncGeneration) return;
      console.error('Colab publishSnapshot error:', e);
      if (!blockedSnapshotPaths.has(file.path)) retryPublish();
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
  publisherNotices.delete(filePath);
  forgetRejectedPublication(filePath);
  if (publisherSaveStates.delete(filePath)) notifyShareSyncChange();
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

/** The stored body, or null when it cannot be decrypted (so it never matches the vault). */
async function decryptServerBody(encrypted: string | null, encryptionKey: string): Promise<string | null> {
  try {
    return encrypted ? await decrypt(encrypted, encryptionKey) : '';
  } catch {
    return null;
  }
}

function isOwnerFrontmatter(frontmatter: string): boolean {
  return /^colab_owner:\s*true\s*$/m.test(frontmatter);
}

/** Keep text that will not be shared as a separate, untracked "<title> (local copy)" note. */
async function createLocalCopy(app: App, file: TFile, content: string): Promise<TFile> {
  const directory = file.parent?.path ? `${file.parent.path}/` : '';
  const basename = editableCopyBasename(file.basename);
  let path = normalizePath(`${directory}${basename}.md`);
  let counter = 1;
  while (app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(`${directory}${basename} (${counter}).md`);
    counter++;
  }
  return app.vault.create(path, stripColabMetadata(content));
}

/**
 * The server denies this recipient edits, e.g. a view-only collaborator on an
 * invited-edit link. Turn the note into a read-only mirror of the owner's
 * version. Vault text that differs from the server is first kept as an
 * unshared local copy, because the mirror refresh replaces the body.
 * The mirror returns to editing if a later fetch reports `canEdit`.
 */
async function demoteToReadOnlyMirror(
  app: App,
  file: TFile,
  shareId: string,
  serverBody: string | null,
): Promise<void> {
  const content = await app.vault.read(file);
  const { frontmatter, body } = parseFrontmatter(content);
  if (!hasMatchingEditableShareIdentity(frontmatter, shareId) || isOwnerFrontmatter(frontmatter)) return;
  const copy = showsStoredBody(body, serverBody) ? null : await createLocalCopy(app, file, content);
  await app.fileManager.processFrontMatter(file, (fm: NoteColabFrontmatter) => {
    fm.colab_access = 'read_only';
    fm.colab_owner = false;
  });
  new Notice(`Colab: you can view "${file.basename}" but not edit it. It now shows the owner’s version as a read-only copy.`
    + (copy ? ` Your local changes were kept in "${copy.basename}" and won’t be shared.` : ''), 0);
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
  return activeShareSyncs.get(filePath)?.saveState ?? publisherSaveStates.get(filePath) ?? null;
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
  const startApi = api;
  const startingPath = file.path;
  const generation = shareSyncGeneration;
  if (activeShareSyncs.has(startingPath) || startingShareSyncs.has(startingPath)) return;
  if (getShareSyncPathByShareId(shareId)) return;
  startingShareSyncs.set(startingPath, shareId);
  startingSharePaths.set(shareId, startingPath);
  let pendingDoc: Y.Doc | null = null;
  let pendingProvider: LiveProvider | null = null;

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
    const roomOrigin = liveOrigin(settings, origin);
    // Without a note key nothing can be decrypted or joined encrypted; the room ID is then enough.
    const pinId = encryptionKey ? await livePinId(encryptionKey) : shareId;
    // Encrypted mode needs the note key; it is resolved after loading the note.
    let mode: LiveMode = 'plain';
    // An `e2e` note without a decryptable checkpoint waits for history from a peer
    // or this device instead of seeding (§5.1 step 2).
    let awaitingHistory: { storedBody: string; checkpoint: LocalCheckpointV2 | null } | null = null;
    let historyMissing = false;
    // #31's deterministic seed this client added to a plain room (§6.2 step 5).
    let ownSeedId: number | null = null;
    const checkpointKey = localCheckpointKey((app as App & { appId: string }).appId, origin || settings.serverUrl, shareId);

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

    // When the vault text cannot be merged with the shared note, the first mirror
    // shows the shared note. Vault text other than the last stored snapshot is
    // first kept as an unshared local copy.
    let adoptShared: { staleBody: string } | null = null;
    // A body-only (legacy) snapshot is seeded only after the relay's initial
    // sync: a 1.34 peer may already hold this text under its own Yjs history.
    let legacySnapshot: { body: string; checkpoint: LocalCheckpointV2 | null; version: number } | null = null;

    async function keepLocalCopy(content: string, reason: string): Promise<void> {
      const copy = await createLocalCopy(app, file, content);
      new Notice(`Colab: ${reason} It was kept in "${copy.basename}", which is not shared.`, 0);
    }

    /** Align the vault replica with the shared document without rewriting the shared note. */
    async function reconcileVault(
      localBody: string,
      checkpoint: LocalCheckpointV2 | null,
      storedBody: string,
      serverVersion: number | null,
    ): Promise<void> {
      let restored = false;
      if (checkpoint) {
        const merged = mergeLocalCheckpoint(doc, fileDoc, checkpoint, localBody, serverVersion);
        restored = merged.restored;
        if (merged.unsharedBody !== null) {
          await keepLocalCopy(merged.unsharedBody, `this device had a different version of "${file.basename}".`);
        }
      }
      if (restored) {
        acceptFileEdit(localBody);
        return;
      }
      // Without shared history the vault text cannot be merged safely.
      Y.applyUpdate(fileDoc, Y.encodeStateAsUpdate(doc));
      if (localBody !== ytext.toString()) adoptShared = { staleBody: storedBody };
    }

    // Hydrate the shared CRDT from the encrypted REST checkpoint before opening
    // the relay. Every reconnect therefore starts from the same Yjs identities,
    // while edits made to the vault during downtime are applied as a local diff.
    if (api && encryptionKey) {
      const note = await api.getNoteContent(permissionShareId);
      if (generation !== shareSyncGeneration) return;
      if (!note) {
        fileDoc.destroy();
        const meta = await api.getNoteMeta(permissionShareId);
        if (generation !== shareSyncGeneration) return;
        if (meta === 'expired' || meta === 'not_found' || meta === 'forbidden') {
          forgetStartRetry(startingPath);
          new Notice('Colab: could not load the saved note. Your vault copy was preserved.');
          return;
        }
        // Offline, timeout, or a brief server interruption: retry automatically.
        const retryApi = api;
        scheduleStartRetry(file, () => void startShareSync(
          app, settings, file, shareId, retryApi, encryptionKey, origin, linkShareId,
        ));
        return;
      }
      const restored = note.encryptedCrdt ? await decryptCrdt(note.encryptedCrdt, encryptionKey, shareId) : null;
      if (note.encryptedCrdt && !restored) console.warn('Colab: encrypted collaboration checkpoint could not be restored.');
      // Pinned before any permission branch, so a later read granting edit can't start plain (§6.1).
      if (note.liveMode === 'e2e' || restored?.encrypted) pinRoom(settings, roomOrigin, pinId);
      // The link's mode is not this caller's permission; the server decides.
      if (note.canEdit === false && !isOwnerFrontmatter(initialFrontmatter)) {
        fileDoc.destroy();
        await demoteToReadOnlyMirror(app, file, shareId, await decryptServerBody(note.encryptedContent, encryptionKey));
        return;
      }
      contentVersion = note.contentVersion || 1;
      let storedBody = '';
      try {
        storedBody = note.encryptedContent ? await decrypt(note.encryptedContent, encryptionKey) : '';
      } catch (error) {
        console.warn('Colab: encrypted snapshot could not be restored:', error);
      }
      let checkpoint: LocalCheckpointV2 | null = null;
      const latest = latestCheckpoints.get(checkpointKey);
      if (latest?.encryptionKey === encryptionKey) {
        checkpoint = parseLocalCheckpoint(latest.checkpoint);
      } else {
        const storedCheckpoint = await readLocalCheckpoint(checkpointKey);
        if (storedCheckpoint) {
          try {
            checkpoint = parseLocalCheckpoint(await decrypt(storedCheckpoint, encryptionKey));
          } catch {
            // A stale checkpoint encrypted with an old key is harmless.
          }
        }
      }
      // This device's history counts too: it is merged below (§6.1).
      if (checkpoint && carriesLiveMarker(base64ToBytes(checkpoint.document))) pinRoom(settings, roomOrigin, pinId);
      let restoredCrdt = false;
      // An encrypted note's checkpoint must be bound to its room (format 2).
      if (restored && (note.liveMode !== 'e2e' || restored.format === 2)) {
        Y.applyUpdate(doc, restored.update);
        restoredCrdt = true;
      }
      const resolved = resolveLiveMode(note.liveMode, readLiveMarker(doc), isRoomPinned(settings, roomOrigin, pinId));
      if (resolved === 'refuse') {
        fileDoc.destroy();
        forgetStartRetry(startingPath);
        new Notice(`Colab: "${file.basename}" — ${REFUSED_LIVE_MODE}`, 0);
        return;
      }
      mode = resolved;
      if (restoredCrdt) {
        await reconcileVault(parseFrontmatter(initialContent).body, checkpoint, storedBody, contentVersion);
        if (ytext.toString() !== storedBody) initialSnapshotNeeded = true;
        initialized = true;
      } else if (mode === 'e2e') {
        awaitingHistory = { storedBody, checkpoint };
      } else {
        // The version loaded with the body; a save before sync must not count as a reset.
        legacySnapshot = { body: storedBody, checkpoint, version: contentVersion };
        initialSnapshotNeeded = true;
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
          // Unsaved editor typing must reach the vault before the mirror reads it.
          for (const leaf of app.workspace.getLeavesOfType('markdown')) {
            // Leaves of type 'markdown' always host a MarkdownView.
            const view = leaf.view as MarkdownView;
            if (view.file?.path === file.path) await view.save();
          }
          if (disposed) return;
          let identityMismatch = false;
          let remoteBody = '';
          let mirroredVersion: Uint8Array | null = null;
          // Merge local edits present in fileContent, then return the mirrored file.
          const mirror = (fileContent: string): string => {
            if (disposed) return fileContent;
            const { frontmatter, body } = parseFrontmatter(fileContent);
            if (!hasMatchingEditableShareIdentity(frontmatter, shareId)) {
              identityMismatch = true;
              return fileContent;
            }
            if (initialized && !adoptShared) acceptFileEdit(body);
            remoteBody = ytext.toJSON();
            mirroredVersion = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(fileDoc));
            if (remoteBody === body) return fileContent;
            const pendingBaseline = new Y.Doc();
            Y.applyUpdate(pendingBaseline, Y.encodeStateAsUpdate(fileDoc));
            Y.applyUpdate(pendingBaseline, mirroredVersion);
            pendingVault = {
              body: remoteBody,
              baseline: bytesToBase64(Y.encodeStateAsUpdate(pendingBaseline)),
            };
            pendingBaseline.destroy();
            return frontmatter + remoteBody;
          };
          const current = await app.vault.read(file);
          const needsWrite = !disposed && mirror(current) !== current && !identityMismatch;
          let displaced: string | null = null;
          if (needsWrite && adoptShared) {
            // The shared note replaces vault text it could not be merged with.
            // Keep local edits first; a vault merely showing the last stored
            // snapshot is simply brought up to date.
            if (!showsStoredBody(parseFrontmatter(current).body, adoptShared.staleBody)) {
              await keepLocalCopy(current, `your vault version of "${file.basename}" differed from the shared version, which is now shown.`);
            }
            displaced = current;
          }
          let changedMeanwhile = false;
          if (needsWrite && !disposed) {
            // Read, merge, and write atomically so typing that lands while this
            // mirror is pending is merged instead of overwritten.
            await app.vault.process(file, (fileContent) => {
              if (displaced !== null && fileContent !== displaced) {
                // Typing after the copy was made: copy again before replacing.
                changedMeanwhile = true;
                return fileContent;
              }
              const next = mirror(fileContent);
              if (next !== fileContent) void persistLocalCheckpoint();
              return next;
            });
          }
          if (identityMismatch) {
            stopShareSync(app, file.path);
            return;
          }
          if (changedMeanwhile) {
            scheduleFileWrite();
            return;
          }
          if (disposed || !mirroredVersion) return;
          Y.applyUpdate(fileDoc, mirroredVersion);
          pendingVault = undefined;
          adoptShared = null;
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
    // A permanent rejection waits for a new edit instead of retrying the same bytes.
    let saveRejected = false;
    let rejectionNoticeShown = false;
    let independentMergeWarned = false;
    let lastKeptRemote: string | null = null;

    /** Yjs kept both separately edited versions; ask the user to check once. */
    function warnIndependentMerge(): void {
      if (independentMergeWarned) return;
      independentMergeWarned = true;
      new Notice(`Colab: "${file.basename}" was edited separately in two places and the versions were combined. Check for duplicated text; the previous version is available in version history.`, 0);
    }
    let retryDelay = 1_000;
    // A `grant` downgrade stops checkpoint saves until write access returns (§5.4).
    let writesStopped = false;
    let checkpointGeneration = 0;

    /** Takes its place in the note's write order now, before encryption finishes. */
    function queueCheckpointWrite(value: Promise<string>, generation: number): Promise<boolean> {
      const write = (checkpointWrites.get(checkpointKey) ?? Promise.resolve(true)).then(async () => {
        if (generation !== checkpointGeneration) return true;
        const pending = value.then(encrypted => writeLocalCheckpoint(checkpointKey, encrypted));
        const written = await settlesWithin(pending, false);
        // A durable baseline older than the acknowledged one would apply saved
        // edits again after an app restart. Without one, differing vault text
        // is kept as a local copy instead.
        if (!written) {
          await settlesWithin(deleteLocalCheckpoint(checkpointKey), undefined);
          // A stalled write that lands later leaves an older baseline behind,
          // unless a newer checkpoint has replaced it since.
          void Promise.all([pending, value]).then(([landed, stale]) => {
            if (landed) return deleteLocalCheckpoint(checkpointKey, stale);
          }).catch(() => {});
        }
        return written;
      }).catch(() => false);
      checkpointWrites.set(checkpointKey, write);
      void write.then(() => {
        if (checkpointWrites.get(checkpointKey) === write) checkpointWrites.delete(checkpointKey);
      });
      return write;
    }

    async function persistLocalCheckpoint(): Promise<void> {
      // Before initialization completes (e.g. awaiting the relay for a body-only
      // snapshot) the document is incomplete; keep the previous checkpoint.
      // Until the vault shows the shared note, its baseline would misdescribe it.
      if (!encryptionKey || disposed || !initialized || adoptShared) return;
      const generation = ++checkpointGeneration;
      // Capture both states synchronously. fileDoc advances only after a vault
      // write succeeds, so it remains safe if cleanup races a pending write.
      const checkpoint = serializeLocalCheckpoint(doc, fileDoc, pendingVault, contentVersion);
      latestCheckpoints.set(checkpointKey, { encryptionKey, checkpoint });
      const written = await queueCheckpointWrite(encrypt(checkpoint, encryptionKey), generation);
      if (generation !== checkpointGeneration) return;
      if (disposed) return;
      if (!written) {
        if (snapshotDirty) setSaveState('error');
      } else if (!snapshotSaving && snapshotDirty && !saveRejected) {
        setSaveState('saved-device');
      }
    }

    function scheduleSnapshot(delay = 800): void {
      if (!api || !encryptionKey || disposed || !initialized) return;
      snapshotDirty = true;
      if (saveRejected && retryTimer) {
        // A new edit replaces the slow recheck of a rejected document.
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      saveRejected = false;
      setSaveState('uploading');
      void persistLocalCheckpoint();
      // A pending backoff retry uploads the latest document; edits must not shorten it.
      if (retryTimer) return;
      if (snapshotTimer) window.clearTimeout(snapshotTimer);
      snapshotTimer = window.setTimeout(() => {
        snapshotTimer = null;
        void flushSnapshot();
      }, delay);
    }

    /** A save was forbidden: if the server now denies editing, become a mirror. */
    async function demoteIfViewOnly(): Promise<boolean> {
      if (!api || !encryptionKey || isOwnerFrontmatter(initialFrontmatter)) return false;
      const note = await api.getNoteContent(permissionShareId);
      if (disposed || !note) return false;
      if (await pinIfEncrypted(settings, origin ?? '', encryptionKey, shareId, note)) void liveHooks.saveSettings();
      if (disposed || note.canEdit !== false) return false;
      stopShareSync(app, file.path);
      await demoteToReadOnlyMirror(app, file, shareId, await decryptServerBody(note.encryptedContent, encryptionKey));
      return true;
    }

    /** The encrypted provider merges newer checkpoints itself; saves start from the newest merged. */
    function mergedVersion(): number {
      return provider instanceof LiveE2EProvider ? Math.max(contentVersion, provider.contentVersion) : contentVersion;
    }

    function setContentVersion(version: number): void {
      contentVersion = version;
      if (provider instanceof LiveE2EProvider) provider.contentVersion = Math.max(provider.contentVersion, version);
    }

    async function flushSnapshot(): Promise<void> {
      // While the mode is re-resolved, the save waits to use the note's format.
      if (!api || !encryptionKey || disposed || snapshotSaving || !snapshotDirty || writesStopped || switching) return;
      snapshotSaving = true;
      snapshotDirty = false;
      setSaveState('uploading');
      try {
        const live = mode === 'e2e';
        const baseVersion = mergedVersion();
        const [encryptedContent, encryptedCrdt] = await Promise.all([
          encrypt(ytext.toString(), encryptionKey),
          encryptCrdt(Y.encodeStateAsUpdate(doc), encryptionKey, shareId, live ? 2 : 1),
        ]);
        if (disposed) return;
        const result = await api.updateSnapshot(permissionShareId, {
          encryptedContent,
          encryptedCrdt,
          baseVersion,
          ...(live ? { crdtFormat: 2 as const } : {}),
        });
        // A response arriving after teardown must not schedule anything.
        if (disposed) return;
        if (result.ok) {
          setContentVersion(result.contentVersion || baseVersion + 1);
          retryDelay = 1_000;
          rejectionNoticeShown = false;
          void persistLocalCheckpoint();
          setSaveState('saved-server');
        } else if (result.conflict) {
          const restored = result.conflict.encryptedCrdt
            ? await decryptCrdt(result.conflict.encryptedCrdt, encryptionKey, shareId)
            : null;
          if (disposed) return;
          if (!live && restored?.encrypted) {
            // The note was switched to encrypted live mode meanwhile.
            pinRoom(settings, roomOrigin, pinId);
            snapshotDirty = true;
            switchMode();
            return;
          }
          setContentVersion(result.conflict.contentVersion);
          if (result.conflict.encryptedCrdt) {
            if (!restored || (live && restored.format !== 2)) throw new Error('The saved collaboration checkpoint could not be decrypted');
            const update = restored.update;
            const serverBody = result.conflict.encryptedContent
              ? await decrypt(result.conflict.encryptedContent, encryptionKey)
              : null;
            if (disposed) return;
            const baseVector = Y.encodeStateVector(doc);
            Y.applyUpdate(doc, update);
            if (mergedIndependentHistory(doc, baseVector)) warnIndependentMerge();
            // The server already holds this exact document (for example a peer
            // saved the same edit, or our earlier response was lost).
            if (serverBody !== null && documentMatchesSnapshot(doc, update, serverBody)) {
              snapshotDirty = false;
              void persistLocalCheckpoint();
              setSaveState('saved-server');
              return;
            }
          } else if (result.conflict.encryptedContent) {
            // An older app saved a body without Yjs history. The live note is
            // kept unchanged; a differing saved body is kept as a local copy.
            const remote = await decrypt(result.conflict.encryptedContent, encryptionKey);
            if (disposed) return;
            if (remote !== ytext.toString() && remote !== lastKeptRemote) {
              lastKeptRemote = remote;
              await keepLocalCopy(remote, `an older NoteColab app saved a different version of "${file.basename}". The live version is kept.`);
            }
          }
          snapshotDirty = true;
        } else if (result.status === 403 || result.status === 404 || result.status === 410) {
          if (result.status === 403 && (await demoteIfViewOnly() || disposed)) return;
          setSaveState('error');
          new Notice('Colab: this note can no longer be saved. Your local vault copy was preserved.', 0);
          return;
        } else if (isPermanentSaveFailure(result.status)) {
          // Edits made while this request was pending already set snapshotDirty;
          // the rejection applies only to the attempted bytes, so save the newer ones.
          if (!snapshotDirty) {
            snapshotDirty = true;
            if (!rejectionNoticeShown) new Notice(`Colab: "${file.basename}" ${permanentSaveFailureReason(result.status)}`, 0);
            rejectionNoticeShown = true;
            saveRejected = true;
            setSaveState('error');
            // Quota can be freed elsewhere, so check again occasionally.
            retryTimer = window.setTimeout(() => {
              retryTimer = null;
              saveRejected = false;
              void flushSnapshot();
            }, 300_000);
          }
        } else {
          snapshotDirty = true;
          setSaveState('offline');
          // The note became encrypted: re-resolve the mode, then save in its format.
          if (result.code === 'live_e2e_update_required') switchMode();
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
        if (snapshotDirty && !retryTimer && !disposed && !saveRejected) scheduleSnapshot(50);
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
    const params = {
      ...websocketCredentials(settings.apiKey, api?.usesAccountCredentials ?? !origin),
      link: permissionShareId,
      ...(roomToken ? { rt: roomToken } : {}),
    };
    const liveApi = api;
    const checkpointSource: CheckpointSource = {
      async getContentVersion() {
        const meta = await liveApi?.getNoteMeta(permissionShareId);
        return meta && typeof meta === 'object' ? meta.contentVersion ?? 0 : 0;
      },
      async loadCheckpoint() {
        const note = await liveApi?.getNoteContent(permissionShareId);
        if (!note?.encryptedCrdt || !encryptionKey) return null;
        const restored = await decryptCrdt(note.encryptedCrdt, encryptionKey, shareId);
        return restored?.format === 2 ? { update: restored.update, contentVersion: note.contentVersion || 0 } : null;
      },
    };

    // History present before the relay (re)delivers its state. Anything the
    // relay adds on top that is causally unrelated is reported to the user.
    let relayBaseVector = preRelayVector;
    let initialSyncDone = false;
    // The owner's enable flow switches providers itself (§6.2 step 4).
    let enabling = false;
    let switching: Promise<void> | null = null;

    /** A replacement keeps the previous provider's awareness, so presence and cursors survive a switch. */
    async function openProvider(next: LiveMode, awareness?: Awareness): Promise<LiveProvider> {
      const created: LiveProvider = next === 'plain'
        ? new WebsocketProvider(wsUrl + '/ws/yjs', shareId, doc, { params: { ...params, client: liveHooks.client }, ...(awareness ? { awareness } : {}) })
        : new LiveE2EProvider(wsUrl + '/ws/yjs', shareId, doc, {
            liveKey: await deriveLiveKey(encryptionKey!, shareId),
            params: { ...params, client: liveHooks.client },
            awareness,
            checkpoint: checkpointSource,
            contentVersion,
          });
      created.on('status', ({ status }) => {
        if (created !== provider || disposed) return;
        if (status === 'disconnected') relayBaseVector = Y.encodeStateVector(doc);
        if (status === 'disconnected' && snapshotDirty && !saveRejected) setSaveState('offline');
        // Reconnecting retries immediately, including a rejected (e.g. quota) save.
        if (status === 'connected' && snapshotDirty) {
          if (retryTimer) window.clearTimeout(retryTimer);
          retryTimer = null;
          scheduleSnapshot(0);
        }
      });
      created.on('sync', (synced) => {
        if (!synced || created !== provider || disposed) return;
        if (mergedIndependentHistory(doc, relayBaseVector)) warnIndependentMerge();
        if (!initialSyncDone) {
          initialSyncDone = true;
          return onSync();
        }
        if (awaitingHistory) return queueAdoptHistory(true);
      });
      created.on('connection-close', (event) => {
        if (created !== provider || disposed || enabling || !event) return;
        if (event.code === 1012 || (event.code === 1008 && MODE_CLOSE_REASONS.has(event.reason))) {
          // After the provider has finished handling this close.
          queueMicrotask(switchMode);
        } else if (event.code === 1008 && created instanceof LiveE2EProvider) {
          // Revocation is reported by the health check, as for plain rooms.
          created.disconnect();
          if (event.reason !== 'Access revoked') {
            new Notice(`Colab: "${file.basename}" — live editing stopped: ${event.reason || 'the server closed the connection'}. Your vault copy is unchanged.`, 0);
          }
        }
      });
      if (created instanceof LiveE2EProvider) {
        created.on('grant', (canWrite) => {
          if (created !== provider || disposed) return;
          writesStopped = !canWrite;
          if (!canWrite) void demoteIfViewOnly();
          else if (snapshotDirty) scheduleSnapshot(0);
        });
      }
      return created;
    }

    // Pinned since the mode was chosen, e.g. by an import: start again so §6.1 decides.
    if (mode === 'plain' && isRoomPinned(settings, roomOrigin, pinId)) {
      fileDoc.destroy();
      window.setTimeout(() => void startShareSync(app, settings, file, shareId, startApi, encryptionKey, origin, linkShareId), 0);
      return;
    }
    let provider = await openProvider(mode);
    pendingProvider = provider;
    if (generation !== shareSyncGeneration) return;

    /** Replace the provider; the doc, its history and the vault bridge stay. */
    async function replaceProvider(next: LiveMode, staged?: Uint8Array): Promise<void> {
      // The plain room must never see the marker or a staged seed.
      const { awareness } = provider;
      provider.destroy();
      mode = next;
      if (staged) Y.applyUpdate(doc, staged);
      const created = await openProvider(next, awareness);
      if (disposed) {
        created.destroy();
        return;
      }
      provider = created;
      const active = activeShareSyncs.get(file.path);
      if (active) active.provider = created;
      notifyShareSyncChange();
      if (snapshotDirty) scheduleSnapshot(0);
    }

    /** This doc holds only #31's seed of the plain room, with no edits (§6.2 step 5). */
    function holdsOnlyOwnSeed(): boolean {
      const { sv, ds } = Y.snapshot(doc);
      return ownSeedId !== null && sv.size === 1 && sv.has(ownSeedId) && ds.clients.size === 0;
    }

    /** The relay reported another mode (1012 or 1008): re-read the note and re-resolve (§6.1). */
    function switchMode(): void {
      switching ??= (async () => {
        if (!liveApi || !encryptionKey) return;
        provider.disconnect();
        let note: NoteContent | null = null;
        for (let delay = 500; !disposed && !note; delay = Math.min(delay * 2, 30_000)) {
          note = await liveApi.getNoteContent(permissionShareId);
          if (!note && !disposed) await new Promise(resolve => window.setTimeout(resolve, delay));
        }
        if (!note || disposed) return;
        const restored = note.encryptedCrdt ? await decryptCrdt(note.encryptedCrdt, encryptionKey, shareId) : null;
        if (disposed) return;
        if (note.liveMode === 'e2e' || restored?.encrypted) pinRoom(settings, roomOrigin, pinId);
        const next = resolveLiveMode(note.liveMode, readLiveMarker(doc), isRoomPinned(settings, roomOrigin, pinId));
        if (next === 'refuse') {
          new Notice(`Colab: "${file.basename}" — ${REFUSED_LIVE_MODE}`, 0);
          stopShareSync(app, file.path);
        } else if (next === mode) {
          provider.connect();
        } else if (holdsOnlyOwnSeed()) {
          // Drop the unsent seed and load the committed checkpoint instead.
          stopShareSync(app, file.path);
          void startShareSync(app, settings, file, shareId, startApi, encryptionKey, origin, linkShareId);
        } else {
          await replaceProvider(next);
        }
      })().catch((error: unknown) => console.error('Colab: live mode switch failed:', error))
        .finally(() => {
          switching = null;
          if (snapshotDirty && !disposed) scheduleSnapshot(0);
        });
    }

    let adoptQueue = Promise.resolve();
    function queueAdoptHistory(synced: boolean): Promise<void> {
      adoptQueue = adoptQueue.then(() => adoptHistory(synced))
        .catch((error: unknown) => console.error('Colab: encrypted live history could not be adopted:', error));
      return adoptQueue;
    }

    const onHistoryUpdate = () => {
      if (awaitingHistory && hasHistory(doc)) void queueAdoptHistory(false);
    };
    if (awaitingHistory) doc.on('update', onHistoryUpdate);

    /** Initialize from history a peer sent, or this device's checkpoint; never from a seed. */
    async function adoptHistory(synced: boolean): Promise<void> {
      const waiting = awaitingHistory;
      if (!waiting || disposed) return;
      if (!hasHistory(doc) && !(waiting.checkpoint && checkpointHasHistory(waiting.checkpoint))) {
        if (synced && !historyMissing) {
          historyMissing = true;
          notifyShareSyncChange();
          new Notice(`Colab: "${file.basename}" — Encrypted live history is missing or damaged. Your vault copy is unchanged and is not saved until history arrives${isOwnerFrontmatter(initialFrontmatter) ? '; you can run "Repair encrypted live history from saved text"' : ''}.`, 0);
        }
        return;
      }
      const { frontmatter, body } = parseFrontmatter(await app.vault.read(file));
      if (disposed || awaitingHistory !== waiting) return;
      if (!hasMatchingEditableShareIdentity(frontmatter, shareId)) {
        stopShareSync(app, file.path);
        return;
      }
      awaitingHistory = null;
      historyMissing = false;
      doc.off('update', onHistoryUpdate);
      // No older app can have reset an encrypted note, so the version guard does not apply.
      await reconcileVault(body, waiting.checkpoint, waiting.storedBody, null);
      if (disposed) return;
      initialized = true;
      await queueFileWrite();
      if (disposed) return;
      scheduleFileWrite();
      // The adopted history becomes the note's new checkpoint.
      scheduleSnapshot();
      notifyShareSyncChange();
      syncMissingImages(ytext.toJSON());
    }

    /** Owner's explicit reseed after a duplicates warning (§5.1 step 2). */
    async function repair(): Promise<boolean> {
      const waiting = awaitingHistory;
      if (!waiting || !historyMissing || disposed || hasHistory(doc)) return false;
      const seedId = await seedClientId(shareId, contentVersion, waiting.storedBody);
      if (disposed || awaitingHistory !== waiting || hasHistory(doc)) return false;
      // Separate transactions: applying an update makes its transaction remote, so a
      // marker written in it would make Yjs think another client uses this doc's ID.
      if (waiting.storedBody) Y.applyUpdate(doc, seedUpdate(seedId, waiting.storedBody));
      setLiveMarker(doc);
      await queueAdoptHistory(true);
      return true;
    }

    async function enable(): Promise<EnableLiveE2EResult> {
      if (mode === 'e2e') return { status: 'already-e2e' };
      if (!liveApi || !encryptionKey) return { status: 'failed', reason: 'forbidden' };
      // Step 2: the doc holds the plain room's history before staging.
      if (!await waitUntil(() => provider.synced && initialized, 10_000)) return { status: 'failed', reason: 'offline' };
      enabling = true;
      try {
        const result = await enableLiveE2E({
          doc,
          roomId: shareId,
          noteKey: encryptionKey,
          getNote: () => liveApi.getNoteContent(permissionShareId),
          putLiveMode: request => liveApi.setLiveMode(shareId, request),
          waitForRoom: () => waitUntil(() => hasHistory(doc), 5_000),
        });
        if (disposed || result.status === 'failed') return result;
        pinRoom(settings, roomOrigin, pinId);
        if (result.status === 'enabled') {
          setContentVersion(Math.max(contentVersion, result.contentVersion));
          await replaceProvider('e2e', result.update);
        }
        return result;
      } finally {
        enabling = false;
        // Another device enabled it, or the room switched meanwhile.
        if (!disposed && mode === 'plain' && isRoomPinned(settings, roomOrigin, pinId)) switchMode();
      }
    }

    // After initial sync with server, initialize content if needed
    const onSync = async () => {
      if (awaitingHistory) {
        await queueAdoptHistory(true);
        if (!disposed && api && encryptionKey && initialized) uploadNewImages(ytext.toJSON());
        return;
      }
      try {
        const fileContent = await app.vault.read(file);
        if (disposed) return;
        const { frontmatter, body } = parseFrontmatter(fileContent);
        if (!hasMatchingEditableShareIdentity(frontmatter, shareId)) {
          stopShareSync(app, file.path);
          return;
        }
        if (legacySnapshot) {
          const { body: storedBody, checkpoint, version } = legacySnapshot;
          legacySnapshot = null;
          // Adopt whatever the room already holds; seed only an empty room.
          ownSeedId = await seedServerSnapshot(doc, storedBody, shareId, contentVersion);
          if (disposed) return;
          await reconcileVault(body, checkpoint, storedBody, version);
          if (disposed) return;
          initialized = true;
        } else if (!initialized && mode === 'plain' && ytext.length === 0 && body) {
          // No saved checkpoint and an empty room: we're the first peer, push body content.
          // A restored checkpoint is authoritative even when empty (a peer deleted the text).
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
          if (adoptShared) {
            // The pending mirror keeps this text as a local copy.
            scheduleFileWrite();
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

    const stopPinWatch = onRoomPinned((pinnedOrigin, pinnedId) => {
      if (pinnedOrigin !== roomOrigin || pinnedId !== pinId || mode !== 'plain' || disposed) return;
      // The enable flow switches providers itself; until then, nothing more reaches the plain room.
      if (enabling) provider.disconnect();
      else switchMode();
    });
    const cleanupTimers = () => {
      void persistLocalCheckpoint();
      disposed = true;
      stopPinWatch();
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
      live: encryptionKey ? {
        get mode() { return mode; },
        get historyMissing() { return historyMissing; },
        resync() {
          if (!(provider instanceof LiveE2EProvider)) return;
          provider.resync();
          void provider.catchUp();
        },
        repair,
        enable,
      } : undefined,
      shareId,
      filePath: file.path,
      modifyRef,
      cleanupTimers,
      saveState,
    });
    pendingDoc = null;
    pendingProvider = null;
    forgetStartRetry(startingPath);
    notifyShareSyncChange();
    if (mode === 'plain' && isRoomPinned(settings, roomOrigin, pinId)) switchMode();

    // Periodic health check: detect expiry or permission changes
    if (api) {
      const healthApi = api;
      // An owner's link mode only limits other people; the owner keeps write.
      const owner = ownsShare(initialFrontmatter);
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
          } else if (meta.accessMode === 'read_only' && !owner) {
            reason = 'read_only';
          }
          // Remembered like every other read; a plain session switches (§6.1).
          if (typeof meta === 'object' && meta.liveMode === 'e2e') {
            pinRoom(settings, roomOrigin, pinId);
            if (mode === 'plain') switchMode();
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

/** Obsidian regained focus: repair dropped frames in encrypted rooms (§5.2). */
export function resyncShareSyncs(): void {
  for (const state of activeShareSyncs.values()) state.live?.resync();
}

/**
 * Owner action from Manage links (§6.2). Uses the note's live session when one runs;
 * otherwise enables from the saved note, where a live room with content refuses a seed.
 */
export async function enableLiveEncryption(
  settings: ColabSettings,
  api: ApiClient,
  filePath: string,
  shareId: string,
  encryptionKey: string,
  origin?: string,
): Promise<EnableLiveE2EResult> {
  const live = activeShareSyncs.get(filePath)?.live;
  if (live) return live.enable();
  const [roomToken, writeCapability] = await Promise.all([
    deriveRoomToken(encryptionKey, shareId),
    deriveWriteCapability(encryptionKey, shareId),
  ]);
  // The server refuses to enable a note without a room token.
  if (api.usesAccountCredentials) await api.setRoomToken(shareId, roomToken, writeCapability);
  const doc = new Y.Doc();
  try {
    const result = await enableLiveE2E({
      doc,
      roomId: shareId,
      noteKey: encryptionKey,
      getNote: () => api.getNoteContent(shareId),
      putLiveMode: request => api.setLiveMode(shareId, request),
      waitForRoom: async () => false,
    });
    if (result.status !== 'failed') pinRoom(settings, liveOrigin(settings, origin), await livePinId(encryptionKey));
    return result;
  } finally {
    doc.destroy();
  }
}

export function stopShareSync(app: App, filePath: string): void {
  forgetStartRetry(filePath);
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
  const publisherState = publisherSaveStates.get(oldPath);
  if (publisherState) {
    publisherSaveStates.delete(oldPath);
    publisherSaveStates.set(newPath, publisherState);
  }
  if (publisherNotices.delete(oldPath)) publisherNotices.add(newPath);
  const retryDelay = startRetryDelays.get(oldPath);
  if (retryDelay !== undefined) {
    startRetryDelays.delete(oldPath);
    startRetryDelays.set(newPath, retryDelay);
  }
  const pendingStart = startRetryTimers.get(oldPath);
  if (pendingStart) {
    startRetryTimers.delete(oldPath);
    startRetryTimers.set(newPath, pendingStart);
  }
  const rejectedRetry = rejectedPublications.get(oldPath);
  if (rejectedRetry) {
    rejectedPublications.delete(oldPath);
    rejectedPublications.set(newPath, rejectedRetry);
  }
}

/** Plugin unload: stop live sessions and every standalone publisher, including in-flight ones. */
export function destroyAllShareSyncs(app: App): void {
  shareSyncGeneration++;
  for (const path of [...startRetryDelays.keys()]) forgetStartRetry(path);
  for (const [path] of activeShareSyncs) {
    stopShareSync(app, path);
  }
  for (const path of [...snapshotTimers.keys(), ...rejectedPublications.keys()]) cancelSnapshot(path);
}

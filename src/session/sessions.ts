import { Notice, type App, type TFile } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { ColabSettings } from '../types';
import type { ApiClient } from '../api/client';
import { deriveRoomToken, deriveWriteCapability, encrypt, encryptBinary } from '../crypto/crypto';
import { websocketCredentials } from '../api/credentials';
import { downloadMissingAssets } from '../share/assets';
import { findImageEmbeds } from '../share/imageEmbeds';
import { hasMatchingEditableShareIdentity, hasMatchingShareIdentity } from './shareIdentity';

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

interface ShareSyncState {
  doc: Y.Doc;
  provider: WebsocketProvider;
  shareId: string;
  filePath: string;
  modifyRef: any;
  healthInterval?: ReturnType<typeof setInterval>;
  cleanupTimers: () => void;
}

const activeShareSyncs = new Map<string, ShareSyncState>();
const startingShareSyncs = new Map<string, string>();
const startingSharePaths = new Map<string, string>();
let shareSyncGeneration = 0;

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

const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastPublishedBody = new Map<string, string>();

/** Re-encrypt the note body and PATCH the stored snapshot (debounced, body-only). */
export function publishSnapshot(
  app: App,
  api: ApiClient,
  file: TFile,
  shareId: string,
  encryptionKey: string,
  delay = 800,
  linkShareId = shareId,
): void {
  if (!encryptionKey) return;
  const prev = snapshotTimers.get(file.path);
  if (prev) clearTimeout(prev);
  snapshotTimers.set(file.path, setTimeout(async () => {
    snapshotTimers.delete(file.path);
    try {
      const content = await app.vault.read(file);
      const { frontmatter, body } = parseFrontmatter(content);
      if (!hasMatchingShareIdentity(
        frontmatter,
        shareId,
        ['read_only', 'public_edit', 'invited_edit'],
      )) return;
      if (lastPublishedBody.get(file.path) === body) return; // nothing changed since last publish
      const encrypted = await encrypt(body, encryptionKey);
      const latestContent = await app.vault.read(file);
      const latest = parseFrontmatter(latestContent);
      if (latest.body !== body || !hasMatchingShareIdentity(
        latest.frontmatter,
        shareId,
        ['read_only', 'public_edit', 'invited_edit'],
      )) return;
      const ok = await api.updateNote(linkShareId, { encryptedContent: encrypted });
      if (!ok) {
        console.warn(`Colab: failed to publish snapshot for ${shareId}`);
        return;
      }
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
    }
  }, delay));
}

/** Cancel a pending snapshot publish and forget cached state for a file. */
export function cancelSnapshot(filePath: string): void {
  const t = snapshotTimers.get(filePath);
  if (t) clearTimeout(t);
  snapshotTimers.delete(filePath);
  lastPublishedBody.delete(filePath);
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
      const data = await app.vault.readBinary(imgFile as TFile);
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

    // Directional flags to prevent loops:
    // writingToFile = true while we modify the vault file from Yjs
    // writingToYjs = true while we update Yjs from a file change
    let writingToFile = false;
    let writingToYjs = false;
    let disposed = false;

    // Debounced file writer — batches rapid remote Yjs changes into a single file write
    let writeTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleFileWrite() {
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(async () => {
        writeTimer = null;
        if (disposed) return;
        writingToFile = true;
        try {
          const remoteBody = ytext.toString();
          const fileContent = await app.vault.read(file);
          if (disposed) return;
          const { frontmatter, body } = parseFrontmatter(fileContent);
          if (!hasMatchingEditableShareIdentity(frontmatter, shareId)) {
            stopShareSync(app, file.path);
            return;
          }
          if (remoteBody !== body) {
            if (disposed) return;
            await app.vault.modify(file, frontmatter + remoteBody);
          }
          // After writing text, sync any missing images
          if (!disposed && api && encryptionKey) {
            syncMissingImages(remoteBody);
          }
        } catch (e) {
          console.error('Share sync yjs→file error:', e);
        } finally {
          writingToFile = false;
        }
      }, 50);
    }

    // Download images referenced in synced text that are missing from the vault
    let imageSyncTimer: ReturnType<typeof setTimeout> | null = null;
    function syncMissingImages(body: string) {
      if (imageSyncTimer) clearTimeout(imageSyncTimer);
      imageSyncTimer = setTimeout(async () => {
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
      }, 500);
    }

    // Upload images referenced in text that aren't yet on the server
    const uploadedImages = new Set<string>(); // track already-uploaded filenames this session
    let imageUploadTimer: ReturnType<typeof setTimeout> | null = null;
    function uploadNewImages(body: string) {
      if (imageUploadTimer) clearTimeout(imageUploadTimer);
      imageUploadTimer = setTimeout(async () => {
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
            console.log(`Share sync: uploaded image ${imgName}`);
          } catch (e) {
            console.warn(`Share sync: failed to upload image ${imgName}:`, e);
          }
        }
      }, 500);
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

    const wsUrl = (origin || settings.serverUrl).replace(/^http/, 'ws');
    const provider = new WebsocketProvider(wsUrl + '/ws/yjs', shareId, doc, {
      params: {
        ...websocketCredentials(settings.apiKey, api?.usesAccountCredentials ?? !origin),
        link: permissionShareId,
        ...(roomToken ? { rt: roomToken } : {}),
      },
    });
    pendingProvider = provider;

    // After initial sync with server, initialize content if needed
    const onSync = async (synced: boolean) => {
      provider.off('sync', onSync);
      if (!synced) return;

      writingToFile = true;
      writingToYjs = true;
      try {
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
          ytext.insert(0, body);
        } else if (ytext.length > 0) {
          // Server has content — update local body, preserve frontmatter
          const remote = ytext.toString();
          if (remote !== body) {
            if (disposed) return;
            await app.vault.modify(file, frontmatter + remote);
          }
        }
      } catch (e) {
        console.error('Share sync initial sync error:', e);
      } finally {
        writingToFile = false;
        writingToYjs = false;
      }

      // Sync any missing images after initial content sync
      if (!disposed && api && encryptionKey) {
        syncMissingImages(ytext.toString());
        uploadNewImages(ytext.toString());
      }
    };
    provider.on('sync', onSync);

    // Remote Yjs changes → schedule file write
    ytext.observe(() => {
      if (writingToYjs) return; // ignore our own Yjs changes
      scheduleFileWrite();
    });

    // Local file changes → update Yjs body only (diff-based, frontmatter excluded)
    const modifyRef = app.vault.on('modify', async (changed) => {
      if (changed.path !== file.path || writingToFile || disposed) return;
      writingToYjs = true;
      try {
        const fileContent = await app.vault.read(changed as TFile);
        if (disposed) return;
        const { frontmatter, body } = parseFrontmatter(fileContent);
        if (!hasMatchingEditableShareIdentity(frontmatter, shareId)) {
          stopShareSync(app, file.path);
          return;
        }
        const current = ytext.toString();
        if (body !== current) {
          // Diff: find common prefix and suffix, only modify the changed portion
          let s = 0;
          while (s < current.length && s < body.length && current[s] === body[s]) s++;
          let eo = current.length, en = body.length;
          while (eo > s && en > s && current[eo - 1] === body[en - 1]) { eo--; en--; }
          if (disposed) return;
          doc.transact(() => {
            if (eo > s) ytext.delete(s, eo - s);
            if (en > s) ytext.insert(s, body.slice(s, en));
          });
        }
        // Upload any new images referenced in the local content
        if (!disposed && api && encryptionKey) {
          uploadNewImages(body);
        }
        // Persist the snapshot too, so edits survive even when no web peer is
        // connected to bridge Yjs → server (the relay holds no durable state).
        if (!disposed && api && encryptionKey) {
          publishSnapshot(app, api, file, shareId, encryptionKey, 800, permissionShareId);
        }
      } catch (e) {
        console.error('Share sync file→yjs error:', e);
      } finally {
        writingToYjs = false;
      }
    });

    const cleanupTimers = () => {
      disposed = true;
      if (writeTimer) clearTimeout(writeTimer);
      if (imageSyncTimer) clearTimeout(imageSyncTimer);
      if (imageUploadTimer) clearTimeout(imageUploadTimer);
      writeTimer = null;
      imageSyncTimer = null;
      imageUploadTimer = null;
    };
    activeShareSyncs.set(file.path, {
      doc,
      provider,
      shareId,
      filePath: file.path,
      modifyRef,
      cleanupTimers,
    });
    pendingDoc = null;
    pendingProvider = null;

    // Periodic health check: detect expiry or permission changes
    if (api) {
      const healthApi = api;
      let consecutiveFailures = 0;
      let lastFailureReason: string | null = null;
      const FAILURE_THRESHOLD = 3; // require 3 consecutive same-reason failures before acting

      const healthInterval = setInterval(async () => {
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
              await app.fileManager.processFrontMatter(file, (frontmatter) => {
                frontmatter.colab_access = 'read_only';
              });
            }
            stopShareSync(app, file.path);
          }
        } catch {
          // Unexpected error — don't break sync
        }
      }, 30_000);
      const state = activeShareSyncs.get(file.path);
      if (state) state.healthInterval = healthInterval;
    }

    provider.on('status', ({ status }: { status: string }) => {
      if (status === 'connected') {
        console.log(`Share sync connected: ${shareId}`);
      }
    });
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
  if (state.healthInterval) clearInterval(state.healthInterval);
  state.cleanupTimers();
  app.vault.offref(state.modifyRef);
  state.provider.destroy();
  state.doc.destroy();
  activeShareSyncs.delete(filePath);
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
}

export function destroyAllShareSyncs(app: App): void {
  shareSyncGeneration++;
  for (const [path] of activeShareSyncs) {
    stopShareSync(app, path);
  }
}

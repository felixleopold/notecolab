import { Notice, TFile, normalizePath, type App } from 'obsidian';
import type { ApiClient } from '../api/client';
import { decrypt } from '../crypto/crypto';
import { isOfficialServerAlias, type ColabSettings } from '../types';
import { ForeignHostModal } from '../ui/ForeignHostModal';
import { downloadMissingAssetsWithResult } from './assets';
import { noteColabFrontmatter } from './frontmatter';
import { parseFolderManifest, type FolderManifest } from './folderManifest';
import { findImageEmbeds } from './imageEmbeds';
import { sanitizeFilename, withFilenameCounter } from './sharedNoteFilename';

export interface FolderImportOptions {
  settings: ColabSettings;
  saveSettings?: () => Promise<void>;
  targetParent?: string;
  targetRoot?: string;
  onProgress?: (completed: number, total: number, path: string) => void;
  shouldContinue?: () => boolean;
}

export interface LoadedFolderShare {
  manifest: FolderManifest;
  manifestUrl: string;
  api: ApiClient;
}

export interface FolderImportResult {
  rootPath: string;
  imported: number;
  skipped: number;
  failed: { path: string; message: string }[];
  cancelled: boolean;
  completedPaths: string[];
}

function linkParts(link: string): { origin: string; shareId: string; encryptionKey: string } {
  const url = new URL(link);
  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts.length !== 2 || pathParts[0] !== 's' || !pathParts[1] || !url.hash.slice(1)) {
    throw new Error('Invalid folder share link');
  }
  return { origin: url.origin, shareId: pathParts[1], encryptionKey: url.hash.slice(1) };
}

async function apiForOrigin(
  app: App,
  api: ApiClient,
  origin: string,
  options: FolderImportOptions,
): Promise<ApiClient | null> {
  let configuredOrigin: string;
  try {
    configuredOrigin = new URL(options.settings.serverUrl).origin;
  } catch {
    configuredOrigin = options.settings.serverUrl;
  }
  if (origin === configuredOrigin || isOfficialServerAlias(origin, configuredOrigin)) return api;
  if (options.settings.trustedShareHosts?.includes(origin)) return api.withBaseUrl(origin);

  const decision = await new Promise<'once' | 'always' | 'cancel'>((resolve) => {
    new ForeignHostModal(app, origin, configuredOrigin, resolve).open();
  });
  if (decision === 'cancel') return null;
  if (decision === 'always') {
    options.settings.trustedShareHosts = [...(options.settings.trustedShareHosts || []), origin];
    await options.saveSettings?.();
  }
  return api.withBaseUrl(origin);
}

/** Download and decrypt only the folder index. Call this before showing import consent. */
export async function loadFolderShare(
  app: App,
  api: ApiClient,
  manifestUrl: string,
  options: FolderImportOptions,
): Promise<LoadedFolderShare | null> {
  const { origin, shareId, encryptionKey } = linkParts(manifestUrl);
  const importApi = await apiForOrigin(app, api, origin, options);
  if (!importApi) return null;
  const note = await importApi.getNoteContent(shareId);
  if (!note) throw new Error('Folder share not found or expired');
  let plaintext: string;
  try {
    plaintext = await decrypt(note.encryptedContent, encryptionKey);
  } catch {
    throw new Error('Could not decrypt the folder index');
  }
  return {
    manifest: parseFolderManifest(plaintext, origin),
    manifestUrl,
    api: importApi,
  };
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = normalizePath(path).split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}

function safeFolderName(name: string): string {
  return sanitizeFilename(name).replace(/\.md$/i, '') || 'Shared folder';
}

function availablePath(app: App, intendedPath: string): string {
  if (!app.vault.getAbstractFileByPath(intendedPath)) return intendedPath;
  const directoryEnd = intendedPath.lastIndexOf('/');
  const directory = directoryEnd >= 0 ? intendedPath.slice(0, directoryEnd + 1) : '';
  const basename = intendedPath.slice(directoryEnd + 1, -3);
  let counter = 1;
  let candidate: string;
  do {
    candidate = `${directory}${withFilenameCounter(basename, counter)}.md`;
    counter++;
  } while (app.vault.getAbstractFileByPath(candidate));
  return candidate;
}

function existingShare(app: App, roomId: string, linkId: string, origin: string): TFile | undefined {
  return app.vault.getMarkdownFiles().find((file) => {
    const fm = noteColabFrontmatter(app.metadataCache.getFileCache(file)?.frontmatter);
    if (!fm?.colab_link || (fm.colab_share_id !== roomId && fm.colab_link_id !== linkId)) return false;
    try {
      const savedOrigin = new URL(fm.colab_link).origin;
      return savedOrigin === origin || isOfficialServerAlias(savedOrigin, origin);
    } catch { return false; }
  });
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator >= 0 ? path.slice(0, separator) : '';
}

/** Import every indexed note after the caller has shown the decrypted preview and obtained consent. */
export async function importFolderShare(
  app: App,
  loaded: LoadedFolderShare,
  options: FolderImportOptions,
): Promise<FolderImportResult> {
  const shouldContinue = options.shouldContinue || (() => true);
  const parent = normalizePath(options.targetParent || 'Shared Folders');
  const rootPath = options.targetRoot
    ? normalizePath(options.targetRoot)
    : normalizePath(`${parent}/${safeFolderName(loaded.manifest.name)}`);
  await ensureFolder(app, rootPath);
  let imported = 0;
  let skipped = 0;
  const failed: FolderImportResult['failed'] = [];
  const completedPaths: string[] = [];

  for (let index = 0; index < loaded.manifest.entries.length; index++) {
    const entry = loaded.manifest.entries[index];
    options.onProgress?.(index, loaded.manifest.entries.length, entry.path);
    if (!shouldContinue()) return { rootPath, imported, skipped, failed, cancelled: true, completedPaths };
    try {
      const { origin, shareId, encryptionKey } = linkParts(entry.shareUrl);
      const note = await loaded.api.getNoteContent(shareId);
      if (!note) throw new Error('Note not found or expired');
      const roomId = note.roomId || shareId;
      const existing = existingShare(app, roomId, shareId, origin);
      if (existing) {
        const existingBody = await app.vault.read(existing);
        const assets = await downloadMissingAssetsWithResult(
          app,
          loaded.api,
          shareId,
          encryptionKey,
          findImageEmbeds(existingBody),
          parentPath(existing.path),
          existing.path,
          shouldContinue,
        );
        if (assets.cancelled) {
          return { rootPath, imported, skipped, failed, cancelled: true, completedPaths };
        }
        if (assets.failed > 0) throw new Error(`${assets.failed} referenced image${assets.failed === 1 ? '' : 's'} could not be downloaded`);
        skipped++;
        completedPaths.push(entry.path);
        continue;
      }

      const body = await decrypt(note.encryptedContent, encryptionKey);
      const intendedPath = normalizePath(`${rootPath}/${entry.path}`);
      const directory = parentPath(intendedPath);
      await ensureFolder(app, directory);
      const finalPath = availablePath(app, intendedPath);
      const frontmatter = [
        '---',
        `colab_share_id: ${JSON.stringify(roomId)}`,
        `colab_link_id: ${JSON.stringify(shareId)}`,
        `colab_link: ${JSON.stringify(entry.shareUrl)}`,
        `colab_access: ${JSON.stringify(note.accessMode)}`,
        `colab_encryption_key: ${JSON.stringify(encryptionKey)}`,
        'colab_owner: false',
        ...(note.expiresAt ? [`colab_expires: ${JSON.stringify(note.expiresAt)}`] : []),
        '---',
        '',
      ].join('\n');
      await app.vault.create(finalPath, `${frontmatter}\n${body}`);
      const assets = await downloadMissingAssetsWithResult(
        app,
        loaded.api,
        shareId,
        encryptionKey,
        findImageEmbeds(body),
        directory,
        finalPath,
        shouldContinue,
      );
      if (assets.cancelled) {
        return { rootPath, imported, skipped, failed, cancelled: true, completedPaths };
      }
      if (assets.failed > 0) throw new Error(`${assets.failed} referenced image${assets.failed === 1 ? '' : 's'} could not be downloaded`);
      imported++;
      completedPaths.push(entry.path);
    } catch (error) {
      failed.push({ path: entry.path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  options.onProgress?.(loaded.manifest.entries.length, loaded.manifest.entries.length, '');
  if (failed.length) new Notice(`NoteColab: imported ${imported}, ${failed.length} failed. Run the import again to resume.`);
  return { rootPath, imported, skipped, failed, cancelled: false, completedPaths };
}

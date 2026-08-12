import { Notice, normalizePath, TFile, type App } from 'obsidian';
import type { ApiClient } from '../api/client';
import { isOfficialServerAlias, type ColabSettings } from '../types';
import { decrypt } from '../crypto/crypto';
import { downloadMissingAssets } from './assets';
import { findImageEmbeds } from './imageEmbeds';
import { ForeignHostModal } from '../ui/ForeignHostModal';
import { sanitizeFilename, sharedNoteBasename, withFilenameCounter } from './sharedNoteFilename';
import { existingImportNotice } from './duplicateImport';
import { noteColabFrontmatter } from './frontmatter';

/**
 * Origin embedded in a share link when it differs from the configured server,
 * else '' (same server, or an unparseable value). A share link carries its own
 * host, so cross-server import/collab resolves the API + relay base from here
 * rather than always using `settings.serverUrl`. (issue #8)
 */
export function foreignOrigin(link: string | undefined, serverUrl: string): string {
  if (!link) return '';
  try {
    const linkOrigin = new URL(link).origin;
    const configured = new URL(serverUrl).origin;
    return linkOrigin === configured || isOfficialServerAlias(linkOrigin, configured) ? '' : linkOrigin;
  } catch {
    return '';
  }
}

/** Options that let import gate a foreign origin behind an explicit trust prompt. */
export interface ImportOptions {
  settings?: ColabSettings;
  saveSettings?: () => Promise<void>;
}

/**
 * Resolve which API client to import with. When the link's origin differs from
 * the configured server, prompt for trust (unless already allow-listed) before
 * returning a client scoped to that foreign origin. Returns null if the user
 * declines. (issue #8)
 */
async function resolveImportApi(
  app: App,
  api: ApiClient,
  shareUrl: string,
  opts: ImportOptions | undefined
): Promise<ApiClient | null> {
  const settings = opts?.settings;
  if (!settings) return api; // no settings to compare against — behave as before

  const origin = foreignOrigin(shareUrl, settings.serverUrl);
  if (!origin) return api; // same server as configured

  const configuredOrigin = (() => {
    try { return new URL(settings.serverUrl).origin; } catch { return settings.serverUrl; }
  })();

  if (settings.trustedShareHosts?.includes(origin)) {
    return api.withBaseUrl(origin);
  }

  const decision = await new Promise<'once' | 'always' | 'cancel'>((resolve) => {
    new ForeignHostModal(app, origin, configuredOrigin, resolve).open();
  });

  if (decision === 'cancel') {
    new Notice('Import cancelled');
    return null;
  }
  if (decision === 'always' && opts?.saveSettings) {
    settings.trustedShareHosts = [...(settings.trustedShareHosts || []), origin];
    await opts.saveSettings();
  }
  return api.withBaseUrl(origin);
}

export async function importNote(
  app: App,
  api: ApiClient,
  shareUrl: string,
  opts?: ImportOptions
): Promise<boolean> {
  try {
    // Parse the URL: https://notecolab.com/s/{shareId}#{key}
    const url = new URL(shareUrl);
    const pathParts = url.pathname.split('/');
    const shareId = pathParts[pathParts.length - 1];
    const encryptionKey = url.hash.slice(1);

    if (!shareId || !encryptionKey) {
      new Notice('Invalid share link');
      return false;
    }

    // A link may originate from a different server than the one configured. If
    // so, confirm trust and resolve the API base to the link's own origin so
    // the read/collab requests reach the server that actually holds the note.
    const importApi = await resolveImportApi(app, api, shareUrl, opts);
    if (!importApi) return false; // user declined the foreign host
    api = importApi;

    const note = await api.getNoteContent(shareId);
    if (!note) {
      new Notice('Note not found or has expired');
      return false;
    }

    // Check if a file with this share already exists in the vault
    // Compare against both the canonical note share_id (roomId) and the link share_id
    const canonicalId = note.roomId || shareId;
    const existingFile = app.vault.getMarkdownFiles().find((f) => {
      const cache = app.metadataCache.getFileCache(f);
      const fmId = noteColabFrontmatter(cache?.frontmatter)?.colab_share_id;
      return fmId === canonicalId || fmId === shareId;
    });

    if (existingFile) {
      // Open the existing file instead of creating a duplicate
      const existingFm = noteColabFrontmatter(app.metadataCache.getFileCache(existingFile)?.frontmatter);
      await app.workspace.getLeaf(false).openFile(existingFile);
      new Notice(existingImportNotice(existingFile.basename, existingFm, {
        linkShareId: shareId,
        accessMode: note.accessMode,
      }));
      return true;
    }

    // Decrypt
    let content: string;
    try {
      content = await decrypt(note.encryptedContent, encryptionKey);
    } catch {
      new Notice('Failed to decrypt — the link may be corrupted');
      return false;
    }

    // Create a new file in the vault. The title comes from the sharer, so
    // sanitize it to a bare filename — `normalizePath` does not resolve `..`, so
    // a title like `../../evil` would otherwise write outside 'Shared Notes'.
    let rawTitle = note.title;
    if (note.encryptedTitle) {
      try {
        rawTitle = await decrypt(note.encryptedTitle, encryptionKey);
      } catch {
        // A malformed title must not prevent importing otherwise valid content.
      }
    }
    rawTitle ||= `Shared Note ${shareId}`;
    const title = sanitizeFilename(rawTitle) || `Shared Note ${shareId}`;
    const isForeign = !!opts?.settings
      && !!foreignOrigin(shareUrl, opts.settings.serverUrl);
    const isOwner = !isForeign
      && !!note.ownerUid
      && !!opts?.settings?.uid
      && note.ownerUid === opts.settings.uid;
    const contactName = !isForeign && note.ownerUid
      ? opts?.settings?.contacts.find((contact) => contact.uid === note.ownerUid)?.name
      : undefined;
    const ownerLabel = contactName || note.ownerUid || undefined;
    const basename = isOwner ? title : sharedNoteBasename(title, ownerLabel);
    const folderPath = 'Shared Notes';

    // Ensure folder exists
    if (!app.vault.getAbstractFileByPath(folderPath)) {
      await app.vault.createFolder(folderPath);
    }

    const filePath = normalizePath(`${folderPath}/${basename}.md`);

    // Avoid overwriting existing files
    let finalPath = filePath;
    let counter = 1;
    while (app.vault.getAbstractFileByPath(finalPath)) {
      finalPath = normalizePath(`${folderPath}/${withFilenameCounter(basename, counter)}.md`);
      counter++;
    }

    // Add frontmatter with share metadata, then body content
    // Use roomId (canonical note share_id) for Yjs sync, not the link share_id from the URL
    const canonicalShareId = note.roomId || shareId;
    const fmLines = [
      '---',
      `colab_share_id: ${canonicalShareId}`,
      `colab_link_id: ${shareId}`,
      `colab_link: ${shareUrl}`,
      `colab_access: ${note.accessMode}`,
      `colab_encryption_key: ${encryptionKey}`,
      `colab_owner: ${isOwner}`,
    ];
    if (note.expiresAt) fmLines.push(`colab_expires: ${note.expiresAt}`);
    fmLines.push('---');
    const frontmatter = fmLines.join('\n') + '\n\n';

    await app.vault.create(finalPath, frontmatter + content);

    // Download and save embedded images (shows a progress notice while fetching)
    const imageFilenames = findImageEmbeds(content);
    await downloadMissingAssets(app, api, shareId, encryptionKey, imageFilenames, folderPath, finalPath);

    // Open the new file
    const newFile = app.vault.getAbstractFileByPath(finalPath);
    if (newFile instanceof TFile) {
      await app.workspace.getLeaf(false).openFile(newFile);
    }

    const importedBasename = finalPath.slice(folderPath.length + 1, -3);
    new Notice(`Imported "${importedBasename}" into ${folderPath}/`);
    return true;
  } catch (e) {
    new Notice('Failed to import note: ' + (e as Error).message);
    return false;
  }
}

import { Notice, TFile, type App } from 'obsidian';
import type { ApiClient } from '../api/client';
import type { ColabSettings, ShareResult } from '../types';
import { deriveRoomToken, deriveWriteCapability, encrypt, generateKey, encryptBinary } from '../crypto/crypto';
import { encryptKeyForRecipient } from '../crypto/keyExchange';
import { DirectoryKeyChangedError } from '../crypto/identityTrust';
import { parseFrontmatter, stopShareSync } from '../session/sessions';
import { findImageEmbeds } from './imageEmbeds';
import type { NoteColabFrontmatter } from './frontmatter';

/** Get the MIME type for common image extensions */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  };
  return types[ext] || 'application/octet-stream';
}

/**
 * Find image files referenced by baked CodeSuite output blocks. Those figures
 * are stored as plain filenames inside the ```codesuite-output JSON (not as
 * ![[..]] embeds), so findImageEmbeds misses them — collect them here so they're
 * uploaded alongside normal embeds and show up in the shared note's web viewer.
 */
function findCodeSuiteOutputImages(text: string): string[] {
  const files: string[] = [];
  const fenceRe = /```codesuite-output[^\n]*\n([\s\S]*?)\n```/g;
  let match;
  while ((match = fenceRe.exec(text)) !== null) {
    try {
      const data: unknown = JSON.parse(match[1].trim());
      if (typeof data === 'object' && data !== null && 'figures' in data && Array.isArray(data.figures)) {
        for (const fig of data.figures as unknown[]) {
          if (typeof fig === 'object' && fig !== null && 'kind' in fig && fig.kind === 'image'
            && 'file' in fig && typeof fig.file === 'string') files.push(fig.file);
        }
      }
    } catch {
      // Malformed baked block — nothing to upload for it.
    }
  }
  return [...new Set(files)];
}

/** Resolve an image filename to a TFile in the vault */
function resolveImageFile(app: App, filename: string, contextFile: TFile): TFile | null {
  // Try exact path first
  const exact = app.vault.getAbstractFileByPath(filename);
  if (exact instanceof TFile) return exact;

  // Use Obsidian's link resolution (handles attachments folder, relative paths)
  const resolved = app.metadataCache.getFirstLinkpathDest(filename, contextFile.path);
  return resolved || null;
}

export async function shareNote(
  app: App,
  api: ApiClient,
  settings: ColabSettings,
  file: TFile,
  options: {
    accessMode: 'public_edit' | 'invited_edit' | 'read_only';
    expiresIn?: number;
    showHelp?: boolean;
    collaborators?: string[];
    theme?: 'auto' | 'light' | 'dark';
    showHeader?: boolean;
    showControls?: boolean;
    showChrome?: boolean;
  }
): Promise<ShareResult | null> {
  try {
    const content = await app.vault.read(file);
    const { frontmatter, body } = parseFrontmatter(content);
    if (/^colab_share_id:\s*\S+/m.test(frontmatter)) {
      new Notice('This note is already shared. Use "Manage shared links" to resend it or add collaborators.');
      return null;
    }

    const encryptionKey = await generateKey();
    const encryptedContent = await encrypt(body, encryptionKey);
    const encryptedTitle = await encrypt(file.basename, encryptionKey);
    const pendingShares: { recipientUid: string; encryptedKey: string; nonce: string }[] = [];
    const validCollaborators: string[] = [];
    const skippedCollaborators: string[] = [];

    if (options.collaborators?.length) {
      if (!settings.secretKey) {
        skippedCollaborators.push(...options.collaborators);
      } else {
        for (const collabUid of options.collaborators) {
          try {
            const info = await api.getPublicKey(collabUid);
            if (!info?.publicKey) {
              skippedCollaborators.push(collabUid);
              continue;
            }
            const { encryptedKey: ek, nonce } = encryptKeyForRecipient(
              encryptionKey,
              info.publicKey,
              settings.secretKey
            );
            pendingShares.push({ recipientUid: collabUid, encryptedKey: ek, nonce });
            validCollaborators.push(collabUid);
          } catch (e) {
            console.warn(`Failed to encrypt key for collaborator ${collabUid}:`, e);
            if (e instanceof DirectoryKeyChangedError) {
              new Notice(`${e.message}. Verify it with the recipient, then reset its pin in Note Colab settings.`, 15_000);
            } else {
              skippedCollaborators.push(collabUid);
            }
          }
        }
      }
    }

    const result = await api.shareNote({
      encryptedTitle,
      encryptedContent,
      accessMode: options.accessMode,
      expiresIn: options.expiresIn,
      // Public/read-only recipients need direct delivery, not a note-wide
      // collaborator grant. Invite-only uses the collaborator table as its
      // authorization boundary.
      collaborators: options.accessMode === 'invited_edit' ? validCollaborators : [],
    });
    const [roomToken, writeToken] = await Promise.all([
      deriveRoomToken(encryptionKey, result.shareId),
      deriveWriteCapability(encryptionKey, result.shareId),
    ]);
    await api.setRoomToken(result.shareId, roomToken, writeToken);

    // Upload embedded images (normal ![[..]] embeds + baked CodeSuite figures)
    const imageFilenames = [...new Set([...findImageEmbeds(body), ...findCodeSuiteOutputImages(body)])];
    for (const imgName of imageFilenames) {
      const imgFile = resolveImageFile(app, imgName, file);
      if (!imgFile) continue;

      try {
        const imgData = await app.vault.readBinary(imgFile);
        const encryptedImg = await encryptBinary(imgData, encryptionKey);
        const mimeType = getMimeType(imgName);
        await api.uploadImage(result.shareId, imgName, encryptedImg, mimeType);
      } catch (e) {
        console.warn(`Failed to upload image ${imgName}:`, e);
      }
    }

    // Encode reader-presentation options into the share URL query string.
    const params = new URLSearchParams();
    if (options.showHelp) params.set('help', '1');
    if (options.theme && options.theme !== 'auto') params.set('theme', options.theme);
    if (options.showHeader) params.set('header', '1');
    if (options.showControls) params.set('controls', '1');
    if (options.showChrome) params.set('chrome', '1');
    const query = params.toString();
    const shareUrl = `${settings.serverUrl}/s/${result.shareId}${query ? `?${query}` : ''}#${encryptionKey}`;

    // Store share info in frontmatter
    await app.fileManager.processFrontMatter(file, (fm: NoteColabFrontmatter) => {
      fm.colab_share_id = result.shareId;
      fm.colab_link_id = result.shareId;
      fm.colab_link = shareUrl;
      fm.colab_access = options.accessMode;
      fm.colab_encryption_key = encryptionKey;
      fm.colab_owner = true;
      if (result.expiresAt) {
        fm.colab_expires = result.expiresAt;
      }
    });

    // Copy to clipboard (skip for invited_edit — invite link is copied separately)
    if (options.accessMode !== 'invited_edit') {
      await navigator.clipboard.writeText(shareUrl);
      new Notice(`Share link copied to clipboard!\n${shareUrl}`);
    }

    if (pendingShares.length > 0) {
      const delivered = await api.createPendingShares(result.shareId, pendingShares, encryptedTitle);
      if (delivered) {
        const noun = pendingShares.length === 1 ? 'recipient' : 'recipients';
        new Notice(`Delivered to ${pendingShares.length} ${noun} in Obsidian`);
      } else {
        new Notice('The web share was created, but direct Obsidian delivery failed');
      }
    }

    if (skippedCollaborators.length > 0) {
      new Notice(`Skipped recipients with no public key - ask them to enable Note Colab first: ${skippedCollaborators.join(', ')}`);
    }

    return {
      shareId: result.shareId,
      shareUrl,
      expiresAt: result.expiresAt,
    };
  } catch (e) {
    // The server rejects with 413 either when a single note exceeds the payload
    // cap or when the upload would push the account over its storage quota.
    // Prefer the server's message (it explains which, and offers an upgrade).
    const err = e as { status?: number; json?: { error?: string; code?: string } };
    if (err?.status === 413) {
      new Notice('Failed to share note: ' + (err.json?.error || 'it is too large or your storage is full. Check Plan & storage in Note Colab settings.'));
    } else {
      new Notice('Failed to share note: ' + (e as Error).message);
    }
    return null;
  }
}

export async function revokeShare(
  app: App,
  api: ApiClient,
  file: TFile
): Promise<boolean> {
  try {
    let shareId = '';
    await app.fileManager.processFrontMatter(file, (fm: NoteColabFrontmatter) => {
      shareId = fm.colab_share_id || '';
    });

    if (!shareId) {
      new Notice('This note is not shared');
      return false;
    }

    const success = await api.deleteNote(shareId);
    if (!success) {
      new Notice('Failed to revoke share');
      return false;
    }

    // Stop any active sync for this file
    stopShareSync(app, file.path);

    // Remove frontmatter
    await app.fileManager.processFrontMatter(file, (fm: NoteColabFrontmatter) => {
      delete fm.colab_share_id;
      delete fm.colab_link_id;
      delete fm.colab_link;
      delete fm.colab_access;
      delete fm.colab_encryption_key;
      delete fm.colab_owner;
      delete fm.colab_expires;
      delete fm.colab_session;
    });

    new Notice('Share revoked successfully');
    return true;
  } catch (e) {
    new Notice('Failed to revoke share: ' + (e as Error).message);
    return false;
  }
}

export async function copyShareLink(
  app: App,
  file: TFile
): Promise<void> {
  let link = '';
  await app.fileManager.processFrontMatter(file, (fm: NoteColabFrontmatter) => {
    link = fm.colab_link || '';
  });

  if (!link) {
    new Notice('This note is not shared. Use "Share note" first.');
    return;
  }

  await navigator.clipboard.writeText(link);
  new Notice('Share link copied to clipboard!');
}

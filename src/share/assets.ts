import { Notice, normalizePath, type App } from 'obsidian';
import type { ApiClient } from '../api/client';
import { decryptBinary } from '../crypto/crypto';

/**
 * Reduce a share-supplied embed name to a plain filename we can safely write.
 * `normalizePath` does NOT resolve `..`, so a name like `../../evil.png` would
 * otherwise escape the target folder — take the last path segment only and
 * reject anything that isn't a real filename. (security audit #5)
 */
function safeAssetName(name: string): string | null {
  const base = (name.split(/[\\/]/).pop() || '').trim();
  if (!base || base === '.' || base === '..' || base.includes('\0') || base.length > 255) {
    return null;
  }
  return base;
}

/**
 * Download and decrypt any referenced image assets that are missing from the
 * vault, writing them into `targetFolder`.
 *
 * Shows a live progress notice while fetching so the user can see assets being
 * downloaded, then a short summary — part of making sharing transparent
 * (issue #5). No-ops silently when every asset is already present locally.
 *
 * @returns the number of assets successfully written to the vault.
 */
export async function downloadMissingAssets(
  app: App,
  api: ApiClient,
  shareId: string,
  encryptionKey: string,
  imageNames: string[],
  targetFolder: string,
  contextPath: string,
  shouldContinue: () => boolean = () => true,
): Promise<number> {
  if (!shouldContinue()) return 0;
  // Only fetch assets we don't already have somewhere in the vault.
  const missing = imageNames.filter(
    (name) => !app.metadataCache.getFirstLinkpathDest(name, contextPath)
  );
  if (missing.length === 0) return 0;

  const notice = new Notice('', 0);
  const render = (done: number) =>
    notice.setMessage(`NoteColab: downloading assets… ${done}/${missing.length}`);
  render(0);

  let saved = 0;
  let failed = 0;
  let aborted = false;
  for (let i = 0; i < missing.length; i++) {
    if (!shouldContinue()) {
      aborted = true;
      break;
    }
    const imgName = missing[i];
    const safeName = safeAssetName(imgName);
    if (!safeName) {
      failed++;
      console.warn(`NoteColab: skipping unsafe asset name ${JSON.stringify(imgName)}`);
      render(i + 1);
      continue;
    }
    try {
      const imgData = await api.getImage(shareId, imgName);
      if (!shouldContinue()) {
        aborted = true;
        break;
      }
      if (imgData) {
        const decrypted = await decryptBinary(imgData.encryptedData, encryptionKey);
        if (!shouldContinue()) {
          aborted = true;
          break;
        }
        const imgPath = normalizePath(targetFolder ? `${targetFolder}/${safeName}` : safeName);

        // Ensure the parent directory exists.
        const imgDir = imgPath.substring(0, imgPath.lastIndexOf('/'));
        if (imgDir && !app.vault.getAbstractFileByPath(imgDir)) {
          await app.vault.createFolder(imgDir);
          if (!shouldContinue()) {
            aborted = true;
            break;
          }
        }

        // Re-check existence — a concurrent sync may have written it already.
        if (shouldContinue() && !app.vault.getAbstractFileByPath(imgPath)) {
          await app.vault.createBinary(imgPath, decrypted);
        }
        saved++;
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
      console.warn(`NoteColab: failed to download asset ${imgName}:`, e);
    }
    render(i + 1);
  }

  notice.hide();
  if (aborted) return saved;
  const noun = (n: number) => `${n} asset${n === 1 ? '' : 's'}`;
  new Notice(
    failed > 0
      ? `NoteColab: downloaded ${noun(saved)}, ${failed} failed`
      : `NoteColab: downloaded ${noun(saved)}`
  );
  return saved;
}

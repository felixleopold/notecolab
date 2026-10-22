export const FOLDER_MANIFEST_KIND = 'notecolab-folder';
export const FOLDER_MANIFEST_VERSION = 1;

export interface FolderManifestEntry {
  path: string;
  shareUrl: string;
}

export interface FolderManifest {
  kind: typeof FOLDER_MANIFEST_KIND;
  version: typeof FOLDER_MANIFEST_VERSION;
  name: string;
  entries: FolderManifestEntry[];
  publishedAt: string;
}

export const MAX_FOLDER_FILES = 2_000;
const MAX_PATH_LENGTH = 1_024;

function safeRelativeMarkdownPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (value.startsWith('/') || value.includes('\\') || !value.toLowerCase().endsWith('.md')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\0'));
}

function safeShareUrl(value: unknown, manifestOrigin: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const pathParts = url.pathname.split('/').filter(Boolean);
    return url.origin === manifestOrigin
      && pathParts.length === 2
      && pathParts[0] === 's'
      && !!pathParts[1]
      && !!url.hash.slice(1);
  } catch {
    return false;
  }
}

/** Parse untrusted, decrypted folder-index content and enforce its filesystem/origin boundary. */
export function parseFolderManifest(value: string, manifestOrigin: string): FolderManifest {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid folder index');

  const candidate = parsed as Partial<FolderManifest>;
  if (candidate.kind !== FOLDER_MANIFEST_KIND || candidate.version !== FOLDER_MANIFEST_VERSION) {
    throw new Error('Unsupported folder index');
  }
  if (typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 255) {
    throw new Error('Invalid folder name');
  }
  if (!Array.isArray(candidate.entries) || candidate.entries.length > MAX_FOLDER_FILES) {
    throw new Error('Invalid folder entries');
  }

  const seen = new Set<string>();
  const entries = candidate.entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid folder entry');
    const item = entry as Partial<FolderManifestEntry>;
    if (!safeRelativeMarkdownPath(item.path) || !safeShareUrl(item.shareUrl, manifestOrigin)) {
      throw new Error('Unsafe folder entry');
    }
    const normalized = item.path.split('/').join('/');
    if (seen.has(normalized)) throw new Error('Duplicate folder path');
    seen.add(normalized);
    return { path: normalized, shareUrl: item.shareUrl };
  });

  return {
    kind: FOLDER_MANIFEST_KIND,
    version: FOLDER_MANIFEST_VERSION,
    name: candidate.name.trim(),
    entries,
    publishedAt: typeof candidate.publishedAt === 'string' ? candidate.publishedAt : '',
  };
}

export function serializeFolderManifest(
  name: string,
  entries: FolderManifestEntry[],
  publishedAt = new Date().toISOString(),
): string {
  return JSON.stringify({
    kind: FOLDER_MANIFEST_KIND,
    version: FOLDER_MANIFEST_VERSION,
    name,
    entries: [...entries].sort((a, b) => a.path.localeCompare(b.path)),
    publishedAt,
  } satisfies FolderManifest);
}

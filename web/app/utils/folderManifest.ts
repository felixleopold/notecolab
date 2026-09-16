export interface FolderManifestEntry {
  path: string
  shareUrl: string
}

export interface FolderManifest {
  kind: 'notecolab-folder'
  version: 1
  name: string
  entries: FolderManifestEntry[]
}

function safeEntry(value: unknown, origin: string): value is FolderManifestEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<FolderManifestEntry>
  if (typeof entry.path !== 'string' || !entry.path.toLowerCase().endsWith('.md')) return false
  if (entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..')) return false
  if (typeof entry.shareUrl !== 'string') return false
  try {
    const url = new URL(entry.shareUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    return url.origin === origin && parts.length === 2 && parts[0] === 's' && !!parts[1] && !!url.hash.slice(1)
  } catch {
    return false
  }
}

export function parseFolderManifest(content: string, origin: string): FolderManifest | null {
  try {
    const value = JSON.parse(content) as Partial<FolderManifest>
    if (typeof value !== 'object' || value === null) return null
    if (value.kind !== 'notecolab-folder' || value.version !== 1) return null
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255) throw new Error('Invalid folder name')
    if (!Array.isArray(value.entries) || value.entries.length > 2_000) throw new Error('Invalid folder entries')
    if (!value.entries.every(entry => safeEntry(entry, origin))) throw new Error('Unsafe folder entry')
    if (new Set(value.entries.map(entry => entry.path)).size !== value.entries.length) throw new Error('Duplicate folder path')
    return { kind: 'notecolab-folder', version: 1, name: value.name.trim(), entries: value.entries }
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

interface RecentNote {
  shareId: string
  title: string
  accessMode: string
  expiresAt: string | null
  url: string
  lastOpened: number
}

const STORAGE_KEY = 'notecolab-recent'
// Note decryption keys are session-scoped only: localStorage persists across
// restarts and is readable by anything with disk access, so the #key fragment
// must never land there. sessionStorage dies with the tab — an acceptable
// trade: recents reopen keyless after that and need the original link.
const SESSION_KEYS_KEY = 'notecolab-session-note-keys'
const MAX_ENTRIES = 10

function readSessionKeys(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEYS_KEY) || '{}')
  } catch {
    return {}
  }
}

/** Remember a note's #key fragment for this browser session only. */
export function rememberNoteKey(shareId: string, key: string) {
  if (!key) return
  const keys = readSessionKeys()
  keys[shareId] = key
  sessionStorage.setItem(SESSION_KEYS_KEY, JSON.stringify(keys))
}

export function getSessionNoteKey(shareId: string): string | null {
  return readSessionKeys()[shareId] || null
}

function splitFragment(url: string): { base: string; fragment: string } {
  const i = url.indexOf('#')
  return i === -1
    ? { base: url, fragment: '' }
    : { base: url.slice(0, i), fragment: url.slice(i + 1) }
}

/** Re-attach the session key (when we still have it) so the link opens decryptable. */
function hydrate(entries: RecentNote[]): RecentNote[] {
  return entries.map((e) => {
    const key = getSessionNoteKey(e.shareId)
    return key ? { ...e, url: `${splitFragment(e.url).base}#${key}` } : e
  })
}

function readFromStorage(): RecentNote[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const entries: RecentNote[] = JSON.parse(raw)
    // Prune expired entries
    const now = Date.now()
    const pruned = entries.filter(
      (e) => !e.expiresAt || new Date(e.expiresAt).getTime() > now
    )
    // Migrate legacy entries that stored the full URL including the #key
    // fragment: move the key to sessionStorage and persist the stripped URL.
    let migrated = pruned.length !== entries.length
    for (const e of pruned) {
      const { base, fragment } = splitFragment(e.url)
      if (fragment) {
        rememberNoteKey(e.shareId, fragment)
        e.url = base
        migrated = true
      }
    }
    if (migrated) writeToStorage(pruned)
    return pruned
  } catch {
    return []
  }
}

function writeToStorage(entries: RecentNote[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

/**
 * Look up a recent note by title (for wiki-link navigation) and return a URL
 * with the session key re-attached when available.
 */
export function findRecentNoteUrlByTitle(title: string): string | null {
  const match = hydrate(readFromStorage()).find(
    (e) => e.title.toLowerCase() === title.toLowerCase()
  )
  return match ? match.url : null
}

export function useRecentNotes() {
  const recentNotes = ref<RecentNote[]>([])

  function load() {
    if (import.meta.server) return
    recentNotes.value = hydrate(readFromStorage())
  }

  function addRecentNote(note: Omit<RecentNote, 'lastOpened'>) {
    if (import.meta.server) return
    const { base, fragment } = splitFragment(note.url)
    if (fragment) rememberNoteKey(note.shareId, fragment)
    const entries = readFromStorage()
    // Remove existing entry for this shareId
    const filtered = entries.filter((e) => e.shareId !== note.shareId)
    // Add new entry at the front (key-free URL only)
    filtered.unshift({ ...note, url: base, lastOpened: Date.now() })
    // Trim to max
    const trimmed = filtered.slice(0, MAX_ENTRIES)
    writeToStorage(trimmed)
    recentNotes.value = hydrate(trimmed)
  }

  function clearHistory() {
    if (import.meta.server) return
    localStorage.removeItem(STORAGE_KEY)
    sessionStorage.removeItem(SESSION_KEYS_KEY)
    recentNotes.value = []
  }

  function getTimeRemaining(expiresAt: string | null): string {
    if (!expiresAt) return 'No expiry'
    const diff = new Date(expiresAt).getTime() - Date.now()
    if (diff <= 0) return 'Expired'
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
    if (hours >= 24) {
      const days = Math.floor(hours / 24)
      return `${days}d ${hours % 24}h left`
    }
    if (hours > 0) return `${hours}h ${minutes}m left`
    return `${minutes}m left`
  }

  return { recentNotes, load, addRecentNote, clearHistory, getTimeRemaining }
}

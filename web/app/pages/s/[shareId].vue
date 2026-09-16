<template>
  <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
    <!-- Loading state -->
    <div v-if="loading" class="flex items-center justify-center h-full" style="background-color: var(--nc-bg);">
      <div class="text-center px-4">
        <div class="w-10 h-10 border-2 border-obsidian-accent border-t-transparent rounded-full animate-spin mx-auto mb-5" />
        <p class="text-sm font-medium" style="color: var(--nc-muted);">Decrypting note...</p>
      </div>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="flex items-center justify-center h-full" style="background-color: var(--nc-bg);">
      <div class="text-center max-w-md px-4">
        <div class="w-16 h-16 rounded-2xl mx-auto mb-5 flex items-center justify-center" style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.15);">
          <svg class="w-8 h-8" style="color: #ef4444;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
        </div>
        <h2 class="text-xl font-semibold mb-2" style="color: var(--nc-text);">{{ error }}</h2>
        <p class="text-sm mb-6" style="color: var(--nc-muted);">{{ errorDetail }}</p>
        <NuxtLink
          to="/"
          class="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg transition-all duration-200 hover:-translate-y-0.5"
          style="background: rgba(127, 109, 242, 0.1); color: #c4b5fd; border: 1px solid rgba(127, 109, 242, 0.2);"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
          </svg>
          Back to home
        </NuxtLink>
      </div>
    </div>

    <FolderReader v-else-if="folderManifest" :manifest="folderManifest" />

    <div v-else class="flex min-h-0 flex-1 flex-col">
      <div
        v-if="canEdit && hasRecoverableRevision"
        class="flex items-center justify-end px-3 py-2 border-b"
        style="background: var(--nc-surface); border-color: var(--nc-border);"
      >
        <button
          class="text-xs px-3 py-1.5 rounded-md"
          style="color: var(--nc-muted); border: 1px solid var(--nc-border);"
          :disabled="recoveringRevision"
          @click="recoverPreviousRevision"
        >
          {{ recoveringRevision ? 'Recovering…' : 'Recover previous version' }}
        </button>
      </div>

      <NoteEditor
        ref="editorRef"
        v-model:mode="viewMode"
        :content="decryptedContent"
        :read-only="!canEdit || !collaborationText"
        :collaboration-text="collaborationText"
        :collaboration-awareness="canEdit ? collaborationAwareness : null"
        :connection-status="connectionStatus"
        :sync-error="syncError || deviceSaveWarning"
        :presence="presence"
        :obsidian-uri="obsidianUri"
        :note-title="noteTitle"
        :access-mode="accessMode"
        :expires-at="expiresAt"
        :share-id="shareId"
        :encryption-key="encryptionKey"
        :write-capability="writeCapability"
        :auto-open-help="route.query.help === '1'"
        :theme="resolvedTheme"
        :show-mode-switcher="showControls"
        :show-chrome="showChrome"
        @update:content="onContentUpdate"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { decrypt, deriveRoomToken, deriveWriteCapability, encrypt } from '~/utils/crypto'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import { trackPresence, type PresenceRoster } from '~/utils/presence'
import { buildSharePreview } from '~/utils/sharePreview'
import { initializeCollaborationDocument, refreshReadOnlySnapshot } from '~/utils/checkpointMerge'
import { parseFolderManifest, type FolderManifest } from '~/utils/folderManifest'

const route = useRoute()
const api = useApi()
const { addRecentNote } = useRecentNotes()

const loading = ref(true)
const error = ref<string | null>(null)
const errorDetail = ref('')
const decryptedContent = ref('')
const canEdit = ref(false)
const viewMode = ref<'source' | 'split' | 'rendered'>('rendered')
const connectionStatus = ref<'connected' | 'syncing' | 'disconnected' | null>(null)
const syncError = ref<string | null>(null)
const deviceSaveWarning = ref<string | null>(null)
const presence = shallowRef<PresenceRoster | null>(null)
const collaborationAwareness = shallowRef<Awareness | null>(null)
let stopPresence: (() => void) | null = null
const editorRef = ref()
const noteTitle = ref('')
const accessMode = ref('')
const expiresAt = ref('')
const hasRecoverableRevision = ref(false)
const recoveringRevision = ref(false)
const folderManifest = shallowRef<FolderManifest | null>(null)
const apiOrigin = new URL(api.baseUrl).origin

const shareId = computed(() => route.params.shareId as string)
const encryptionKey = ref('')

// --- Reader presentation config (URL-driven) ---
// A plain read-only link opens as a clean, distraction-free reading view. The
// query string lets the sharer dial pieces back in:
//   ?theme=light|dark   force a colour theme (default: reader's system preference)
//   ?view=reading|source|split  initial editor mode
//   ?controls=1         show the Source/Split/Reading mode switcher
//   ?chrome=1           show the info banner + connection/peer/view-only badges
//   ?header=1           show the top NoteColab app bar
// Editable notes keep the editor controls and status, but shared links default
// to the same focused, header-free shell as read-only notes.
function readQuery(name: string): string | undefined {
  const v = route.query[name]
  return Array.isArray(v) ? v[0] ?? undefined : (v ?? undefined)
}
function parseBool(name: string, def: boolean): boolean {
  const v = readQuery(name)
  if (v === undefined) return def
  const s = String(v).toLowerCase()
  if (['1', 'true', 'yes', 'on', ''].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return def
}

const systemPrefersDark = ref(true)
if (import.meta.client) {
  systemPrefersDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
}
const themeParam = computed(() => {
  const s = String(readQuery('theme') ?? '').toLowerCase()
  return s === 'light' || s === 'dark' ? (s as 'light' | 'dark') : null
})
const resolvedTheme = computed<'light' | 'dark'>(() =>
  themeParam.value ?? (systemPrefersDark.value ? 'dark' : 'light')
)

const showControls = computed(() => parseBool('controls', canEdit.value))
const showChrome = computed(() => parseBool('chrome', canEdit.value))
const showHeader = computed(() => parseBool('header', false))

const initialView = (() => {
  const s = String(readQuery('view') ?? '').toLowerCase()
  if (s === 'source') return 'source' as const
  if (s === 'split') return 'split' as const
  if (s === 'reading' || s === 'rendered' || s === 'read') return 'rendered' as const
  return null
})()

useHead({
  htmlAttrs: {
    class: computed(() => {
      const cls: string[] = []
      if (resolvedTheme.value === 'light') cls.push('nc-light')
      if (!showHeader.value) cls.push('nc-noheader')
      return cls.join(' ')
    }),
  },
})

// --- Link-preview metadata (server-rendered) ---
// Crawlers (Telegram, WhatsApp, Slack, iMessage, ...) don't run JS, so the
// preview tags must be in the initial server HTML. URL fragments are unavailable
// server-side, so encrypted titles intentionally render as a generic card.
const { data: previewMeta } = await useAsyncData(
  `note-preview-${shareId.value}`,
  async () => {
    try {
      const res = await $fetch<{ title?: string | null, access_mode?: string | null }>(
        `${api.baseUrl}/api/v1/notes/${encodeURIComponent(shareId.value)}/meta`,
      )
      return {
        title: res?.title?.trim() || null,
        accessMode: res?.access_mode || null,
      }
    } catch {
      return { title: null, accessMode: null }
    }
  },
)

const preview = computed(() => buildSharePreview(previewMeta.value || {}))

useSeoMeta({
  title: () => preview.value.title,
  ogTitle: () => preview.value.title,
  description: () => preview.value.description,
  ogDescription: () => preview.value.description,
  ogType: 'article',
  ogSiteName: 'NoteColab',
  twitterCard: 'summary_large_image',
  twitterTitle: () => preview.value.title,
  twitterDescription: () => preview.value.description,
})

// The encrypted title can only be recovered in the browser because its key is
// in the URL fragment. Keep server-rendered metadata generic, then update the
// tab locally once decryption succeeds.
useHead({
  title: () => noteTitle.value.trim() || preview.value.title,
})

defineOgImageComponent('NoteCard', {
  title: preview.value.imageTitle,
  description: preview.value.description,
  accessLabel: preview.value.accessLabel,
}, { width: 1200, height: 630 })

// Build deep link for Obsidian import — only for editable notes
// (read-only notes cannot be meaningfully imported: Obsidian makes all local
// files editable, but changes would be silently rejected by the server)
const obsidianUri = computed(() => {
  if (!shareId.value || !encryptionKey.value || !canEdit.value) return ''
  const shareUrl = `${api.baseUrl}/s/${shareId.value}#${encryptionKey.value}`
  return `obsidian://colab-import?url=${encodeURIComponent(shareUrl)}`
})

let yjsDoc: Y.Doc | null = null
let wsProvider: WebsocketProvider | null = null
let ytext: Y.Text | null = null
let encKey = ''
let noteShareId = ''
let roomId = ''
let contentVersion = 1
let initialEncryptedCrdt: string | null = null
let initialSnapshotNeeded = false
const writeCapability = ref('')
const collaborationText = shallowRef<Y.Text | null>(null)
let isSaving = false
let saveDirty = false
let saveRetryDelay = 1_000
let healthCheckInterval: ReturnType<typeof setInterval> | null = null

// Debounced save
let saveTimeout: ReturnType<typeof setTimeout> | null = null

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

function checkpointKey() {
  return `notecolab:crdt:v1:${api.baseUrl}:${roomId}`
}

function openCheckpointDb(): Promise<IDBDatabase | null> {
  if (!import.meta.client || typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const request = indexedDB.open('notecolab-sync-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('checkpoints')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

async function readLocalCheckpoint(): Promise<string | null> {
  const db = await openCheckpointDb()
  if (!db) {
    try { return localStorage.getItem(checkpointKey()) } catch { return null }
  }
  return new Promise<string | null>((resolve) => {
    const request = db.transaction('checkpoints').objectStore('checkpoints').get(checkpointKey())
    request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null)
    request.onerror = () => resolve(null)
  }).finally(() => db.close())
}

async function writeLocalCheckpoint(value: string): Promise<boolean> {
  const db = await openCheckpointDb()
  if (!db) {
    try {
      localStorage.setItem(checkpointKey(), value)
      return localStorage.getItem(checkpointKey()) === value
    } catch {
      return false
    }
  }
  const written = await new Promise<boolean>((resolve) => {
    const transaction = db.transaction('checkpoints', 'readwrite')
    transaction.objectStore('checkpoints').put(value, checkpointKey())
    transaction.oncomplete = () => resolve(true)
    transaction.onerror = () => resolve(false)
    transaction.onabort = () => resolve(false)
  })
  db.close()
  return written
}

async function deleteLocalCheckpoint(): Promise<void> {
  const db = await openCheckpointDb()
  if (!db) {
    try { localStorage.removeItem(checkpointKey()) } catch { /* best effort */ }
    return
  }
  await new Promise<void>((resolve) => {
    const transaction = db.transaction('checkpoints', 'readwrite')
    transaction.objectStore('checkpoints').delete(checkpointKey())
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
    transaction.onabort = () => resolve()
  })
  db.close()
}

let localCheckpointGeneration = 0
let checkpointWriteQueue = Promise.resolve(true)

function queueLocalCheckpoint(value: string, generation: number): Promise<boolean> {
  checkpointWriteQueue = checkpointWriteQueue.then(() => {
    if (generation !== localCheckpointGeneration) return true
    return writeLocalCheckpoint(value)
  })
  return checkpointWriteQueue
}

async function persistLocalCheckpoint() {
  if (!canEdit.value || !yjsDoc || !encKey || !import.meta.client) return
  const generation = ++localCheckpointGeneration
  const encrypted = await encrypt(bytesToBase64(Y.encodeStateAsUpdate(yjsDoc)), encKey)
  if (generation !== localCheckpointGeneration) return
  const written = await queueLocalCheckpoint(encrypted, generation)
  if (generation !== localCheckpointGeneration) return
  deviceSaveWarning.value = written
    ? null
    : 'This browser could not save an offline recovery copy. Keep this tab open until the server save succeeds.'
}

async function saveNow() {
  if (!encKey || !noteShareId || !yjsDoc || isSaving || syncError.value || !saveDirty) return
  isSaving = true
  saveDirty = false
  try {
    const [encrypted, encryptedCrdt] = await Promise.all([
      encrypt(ytext?.toString() ?? decryptedContent.value, encKey),
      encrypt(bytesToBase64(Y.encodeStateAsUpdate(yjsDoc)), encKey),
    ])
    const result = await api.updateNote(
      noteShareId,
      { encryptedContent: encrypted, encryptedCrdt, baseVersion: contentVersion },
      writeCapability.value,
    )
    if (result.ok) {
      contentVersion = result.contentVersion ?? contentVersion + 1
      saveRetryDelay = 1_000
      // Edits can arrive while this HTTP request is pending. Checkpoint the
      // current document, never the older snapshot that was just acknowledged.
      void persistLocalCheckpoint()
    } else if (result.conflict) {
      contentVersion = result.conflict.contentVersion
      if (result.conflict.encryptedCrdt) {
        const update = await decrypt(result.conflict.encryptedCrdt, encKey)
        Y.applyUpdate(yjsDoc, base64ToBytes(update))
      } else if (result.conflict.encryptedContent) {
        const remote = await decrypt(result.conflict.encryptedContent, encKey)
        const local = ytext?.toString() ?? decryptedContent.value
        if (remote !== local && ytext) {
          ytext.delete(0, ytext.length)
          ytext.insert(0, `${local}\n\n<<<<<<< NoteColab recovered remote snapshot\n${remote}\n>>>>>>>`)
        }
      }
      saveDirty = true
    } else {
      const title = noteTitle.value || 'This note'
      if (result.status === 410) {
        handleSyncBroken(`"${title}" — link expired. Your changes are no longer being saved.`)
      } else if (result.status === 403) {
        handleSyncBroken(`"${title}" — now read-only. Your changes are no longer being saved.`)
      } else if (result.status === 404) {
        handleSyncBroken(`"${title}" — deleted by owner. Your changes are no longer being saved.`)
      } else {
        saveDirty = true
        if (saveTimeout) clearTimeout(saveTimeout)
        saveTimeout = setTimeout(saveNow, saveRetryDelay)
        saveRetryDelay = Math.min(saveRetryDelay * 2, 30_000)
      }
    }
  } catch {
    saveDirty = true
    if (saveTimeout) clearTimeout(saveTimeout)
    saveTimeout = setTimeout(saveNow, saveRetryDelay)
    saveRetryDelay = Math.min(saveRetryDelay * 2, 30_000)
  } finally {
    isSaving = false
    if (saveDirty && !saveTimeout && !syncError.value) scheduleSave(50)
  }
}

function handleSyncBroken(message: string) {
  syncError.value = message
  canEdit.value = false
  // Stop Yjs sync since it's no longer valid
  if (wsProvider) {
    stopPresence?.()
    stopPresence = null
    wsProvider.destroy()
    wsProvider = null
  }
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval)
    healthCheckInterval = null
  }
}

function scheduleSave(delay = 500) {
  saveDirty = true
  void persistLocalCheckpoint()
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    saveTimeout = null
    void saveNow()
  }, delay)
}

function onContentUpdate(newContent: string) {
  decryptedContent.value = newContent
}

async function loadNote() {
  try {
    // Extract key from URL fragment
    if (import.meta.client) {
      encryptionKey.value = window.location.hash.slice(1)
    }
    encKey = encryptionKey.value
    noteShareId = shareId.value

    if (!encKey) {
      error.value = 'Missing decryption key'
      errorDetail.value = 'The share link is incomplete — the encryption key should be in the URL fragment.'
      loading.value = false
      return
    }

    // Fetch note content
    const { data: note, status } = await api.getNoteContent(shareId.value)
    if (!note) {
      if (status === 403) {
        error.value = 'Access denied'
        errorDetail.value = 'This note is invite-only. You need to be added as a collaborator by the note owner. Log in with your UID to access notes shared with you.'
      } else if (status === 410) {
        error.value = 'Note expired'
        errorDetail.value = 'This share link has expired.'
      } else {
        error.value = 'Note not found'
        errorDetail.value = 'This note may have expired or been deleted by the owner.'
      }
      loading.value = false
      return
    }

    canEdit.value = note.canEdit
    viewMode.value = initialView ?? (note.canEdit ? 'split' : 'rendered')
    if (note.encryptedTitle) {
      try {
        noteTitle.value = await decrypt(note.encryptedTitle, encKey)
      } catch {
        noteTitle.value = note.title || 'Encrypted note'
      }
    } else {
      noteTitle.value = note.title || 'Encrypted note'
    }
    accessMode.value = note.accessMode
    expiresAt.value = note.expiresAt || ''
    roomId = note.roomId || shareId.value
    contentVersion = note.contentVersion || 1
    initialEncryptedCrdt = note.encryptedCrdt
    initialSnapshotNeeded = !note.encryptedCrdt
    writeCapability.value = await deriveWriteCapability(encKey, roomId)

    // Decrypt content
    try {
      decryptedContent.value = await decrypt(note.encryptedContent, encKey)
    } catch {
      error.value = 'Decryption failed'
      errorDetail.value = 'The encryption key in the URL may be incorrect or corrupted.'
      loading.value = false
      return
    }

    try {
      folderManifest.value = parseFolderManifest(decryptedContent.value, apiOrigin)
    } catch {
      error.value = 'Invalid folder index'
      errorDetail.value = 'This encrypted folder index contains invalid or unsafe file links.'
      loading.value = false
      return
    }

    loading.value = false

    // Save to recent notes for "jump back in" on homepage
    if (import.meta.client) {
      addRecentNote({
        shareId: shareId.value,
        title: noteTitle.value,
        accessMode: accessMode.value,
        expiresAt: expiresAt.value || null,
        url: window.location.href,
      })
    }

    // Folder indexes are immutable readers. Never bind their manifest JSON to a live editor.
    if (folderManifest.value) return

    // Set up Yjs collab for live sync (both editable and read-only)
    await setupYjsCollab()
    if (canEdit.value) {
      const history = await api.getNoteHistory(noteShareId)
      hasRecoverableRevision.value = !!history?.revisions.some((revision) => revision.encryptedContent)
    }

    // Periodic health check: detect expiry or permission changes
    if (canEdit.value) {
      startHealthCheck()
    }
  } catch (e) {
    error.value = 'Failed to load note'
    errorDetail.value = 'An unexpected error occurred. Please try again.'
    loading.value = false
  }
}

async function recoverPreviousRevision() {
  if (!canEdit.value || recoveringRevision.value || !encKey) return
  recoveringRevision.value = true
  try {
    const history = await api.getNoteHistory(noteShareId)
    const revision = history?.revisions.find((candidate) => candidate.encryptedContent)
    if (!revision?.encryptedContent) {
      hasRecoverableRevision.value = false
      return
    }
    const recovered = await decrypt(revision.encryptedContent, encKey)
    if (!window.confirm('Replace the current note with the previous encrypted version? The current version remains recoverable after the new save.')) return
    if (ytext) {
      ytext.doc?.transact(() => {
        ytext!.delete(0, ytext!.length)
        if (recovered) ytext!.insert(0, recovered)
      })
    } else {
      decryptedContent.value = recovered
      scheduleSave(0)
    }
  } finally {
    recoveringRevision.value = false
  }
}

async function setupYjsCollab() {
  yjsDoc = new Y.Doc()
  ytext = yjsDoc.getText('content')
  const storedBody = decryptedContent.value

  let serverUpdate: Uint8Array | null = null
  if (initialEncryptedCrdt) {
    try {
      serverUpdate = base64ToBytes(await decrypt(initialEncryptedCrdt, encKey))
    } catch {
      serverUpdate = null
    }
  }
  let deviceUpdate: Uint8Array | null = null
  if (canEdit.value && import.meta.client) {
    const localCheckpoint = await readLocalCheckpoint()
    if (localCheckpoint) {
      try {
        deviceUpdate = base64ToBytes(await decrypt(localCheckpoint, encKey))
      } catch {
        await deleteLocalCheckpoint()
      }
    }
  }
  const initialized = await initializeCollaborationDocument(yjsDoc, {
    body: decryptedContent.value,
    roomId,
    version: contentVersion,
    serverUpdate,
    deviceUpdate,
    editable: canEdit.value,
  })
  if (initialized.invalidDeviceCheckpoint) await deleteLocalCheckpoint()
  if (!initialized.restoredServerCrdt) initialSnapshotNeeded = true
  if (ytext.toString() !== storedBody) initialSnapshotNeeded = true
  decryptedContent.value = ytext.toString()

  // Connect WebSocket FIRST, then initialize after sync to prevent content duplication
  const preRelayVector = Y.encodeStateVector(yjsDoc)
  const preRelayBody = ytext.toString()
  const wsUrl = api.baseUrl.replace(/^http/, 'ws')
  const apiKey = api.getApiKey()
  const roomToken = encKey ? await deriveRoomToken(encKey, roomId) : ''
  wsProvider = new WebsocketProvider(wsUrl + '/ws/yjs', roomId, yjsDoc, {
    params: {
      ...(apiKey ? { token: apiKey } : {}),
      link: shareId.value,
      ...(roomToken ? { rt: roomToken } : {}),
    },
  })

  if (canEdit.value) {
    collaborationAwareness.value = wsProvider.awareness
    const storedName = localStorage.getItem('notecolab-display-name')?.trim().slice(0, 40)
    const color = ['#397b63', '#9361a8', '#386db0', '#a56a24', '#ad526a', '#397f8b'][wsProvider.awareness.clientID % 6]
    const publishCursorIdentity = (name: string) => {
      wsProvider?.awareness.setLocalStateField('user', {
        name: name || 'Participant',
        color,
        colorLight: `${color}33`,
      })
    }
    publishCursorIdentity(storedName || 'Participant')
    void api.getMe().then((profile) => {
      if (profile?.displayName) publishCursorIdentity(profile.displayName.trim().slice(0, 40))
    })
  }

  wsProvider.on('status', ({ status }: { status: string }) => {
    connectionStatus.value = status === 'connecting' ? 'syncing' : status === 'connected' ? 'connected' : 'disconnected'
  })

  stopPresence = trackPresence(wsProvider, (roster) => { presence.value = roster })

  // After initial sync, initialize Y.Text only if the remote doc was empty
  const onSync = (synced: boolean) => {
    if (!synced) return
    wsProvider!.off('sync', onSync)
    const relayOnly = new Y.Doc()
    Y.applyUpdate(relayOnly, Y.encodeStateAsUpdate(yjsDoc!, preRelayVector))
    const relayBody = relayOnly.getText('content').toString()
    relayOnly.destroy()
    const mergedBody = ytext!.toString()
    const duplicatedBaseline = !!preRelayBody && mergedBody === preRelayBody + preRelayBody
    const independentlySeeded = duplicatedBaseline || relayBody && (
      mergedBody === preRelayBody + relayBody
      || mergedBody === relayBody + preRelayBody
    )
    if (independentlySeeded) {
      const recoveredRelayBody = relayBody || preRelayBody
      const recovered = !preRelayBody
        ? recoveredRelayBody
        : preRelayBody === recoveredRelayBody
          ? preRelayBody
          : `${preRelayBody}\n\n<<<<<<< NoteColab recovered live room\n${recoveredRelayBody}\n>>>>>>>`
      yjsDoc!.transact(() => {
        ytext!.delete(0, ytext!.length)
        if (recovered) ytext!.insert(0, recovered)
      })
      initialSnapshotNeeded = true
    }
    if (ytext!.length > 0) {
      const remote = ytext!.toString()
      if (remote !== decryptedContent.value) {
        decryptedContent.value = remote
      }
    }
    if (canEdit.value || ytext!.length > 0) collaborationText.value = ytext
    if (canEdit.value && (initialSnapshotNeeded || ytext!.toString() !== preRelayBody)) scheduleSave()
  }
  wsProvider.on('sync', onSync)

  // Sync Yjs text changes (from remote peers) to editor content
  ytext.observe(() => {
    const newContent = ytext!.toString()
    if (!collaborationText.value && newContent) collaborationText.value = ytext
    if (newContent !== decryptedContent.value) {
      decryptedContent.value = newContent
    }
    if (canEdit.value) scheduleSave()
  })
}

function startHealthCheck() {
  healthCheckInterval = setInterval(async () => {
    if (syncError.value) return
    try {
      const { data: meta, status } = await api.getNoteMeta(shareId.value)
      const title = noteTitle.value || 'This note'
      if (status === 410) {
        handleSyncBroken(`"${title}" — link expired. Your changes are no longer being saved.`)
      } else if (status === 404) {
        handleSyncBroken(`"${title}" — deleted by owner. Your changes are no longer being saved.`)
      } else if (meta && meta.access_mode === 'read_only' && canEdit.value) {
        handleSyncBroken(`"${title}" — now read-only. Your changes are no longer being saved.`)
      }
    } catch {
      // Network error — don't break sync for transient failures
    }
  }, 30_000)
}

function cleanup() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval)
    healthCheckInterval = null
  }
  if (saveTimeout) {
    clearTimeout(saveTimeout)
    saveTimeout = null
  }
  if (canEdit.value) {
    void persistLocalCheckpoint()
    // Fire an immediate save before disconnecting
    saveNow()
  }
  if (wsProvider) {
    stopPresence?.()
    stopPresence = null
    wsProvider.destroy()
    wsProvider = null
  }
  if (yjsDoc) {
    yjsDoc.destroy()
    yjsDoc = null
  }
  collaborationText.value = null
  collaborationAwareness.value = null
  ytext = null
}

// Re-fetch content from server when returning to the tab (handles changes made while tab was hidden)
async function onVisibilityChange() {
  if (document.visibilityState !== 'visible' || !encKey || !noteShareId) return
  if (saveDirty) scheduleSave(0)
  try {
    const { data: note } = await api.getNoteContent(noteShareId)
    if (!note) return
    const content = await decrypt(note.encryptedContent, encKey)
    if (note.contentVersion > contentVersion && !canEdit.value) {
      let update: Uint8Array | null = null
      if (note.encryptedCrdt) {
        try {
          update = base64ToBytes(await decrypt(note.encryptedCrdt, encKey))
        } catch {
          update = null
        }
      }
      // Treat the newer REST snapshot as authoritative. Using the provider as
      // the transaction origin prevents this local reader refresh from being
      // relayed as an edit.
      if (yjsDoc) refreshReadOnlySnapshot(yjsDoc, content, update, wsProvider)
      decryptedContent.value = ytext?.toString() ?? content
      contentVersion = note.contentVersion
    } else if (note.contentVersion > contentVersion && yjsDoc && note.encryptedCrdt) {
      const update = await decrypt(note.encryptedCrdt, encKey)
      Y.applyUpdate(yjsDoc, base64ToBytes(update))
      contentVersion = note.contentVersion
    } else if (content !== decryptedContent.value && !ytext) {
      decryptedContent.value = content
    }
  } catch {}
}

let schemeQuery: MediaQueryList | null = null
function onSchemeChange(e: MediaQueryListEvent) {
  systemPrefersDark.value = e.matches
}

function onOnline() {
  if (saveDirty) scheduleSave(0)
  wsProvider?.connect()
}

onMounted(() => {
  loadNote()

  if (import.meta.client) {
    window.addEventListener('beforeunload', cleanup)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)
    schemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    systemPrefersDark.value = schemeQuery.matches
    schemeQuery.addEventListener('change', onSchemeChange)
  }
})

onBeforeUnmount(() => {
  if (import.meta.client) {
    window.removeEventListener('beforeunload', cleanup)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('online', onOnline)
    schemeQuery?.removeEventListener('change', onSchemeChange)
  }
  cleanup()
})
</script>

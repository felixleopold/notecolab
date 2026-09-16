<template>
  <div class="flex-1 min-h-0">
    <!-- Loading state -->
    <div v-if="loading" class="flex items-center justify-center h-full">
      <div class="text-center">
        <div class="w-8 h-8 border-2 border-obsidian-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p class="text-obsidian-muted">Connecting to live session...</p>
      </div>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="flex items-center justify-center h-full">
      <div class="text-center max-w-md">
        <svg class="w-16 h-16 text-obsidian-muted mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/>
        </svg>
        <h2 class="text-xl font-semibold mb-2">{{ error }}</h2>
        <p class="text-obsidian-muted mb-4">{{ errorDetail }}</p>
        <NuxtLink to="/" class="text-obsidian-accent hover:underline">← Back to home</NuxtLink>
      </div>
    </div>

    <!-- Editor -->
    <NoteEditor
      v-else
      v-model:mode="viewMode"
      :content="content"
      :read-only="!collaborationText"
      :collaboration-text="collaborationText"
      :connection-status="connectionStatus"
      :presence="presence"
      :obsidian-uri="obsidianUri"
      @update:content="onContentUpdate"
    />
  </div>
</template>

<script setup lang="ts">
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { trackPresence, type PresenceRoster } from '~/utils/presence'
import { deriveRoomToken } from '~/utils/crypto'

const route = useRoute()
const api = useApi()

const loading = ref(true)
const error = ref<string | null>(null)
const errorDetail = ref('')
const content = ref('')
const viewMode = ref<'source' | 'split' | 'rendered'>('source')
const connectionStatus = ref<'connected' | 'syncing' | 'disconnected' | null>('disconnected')
const presence = shallowRef<PresenceRoster | null>(null)
let stopPresence: (() => void) | null = null

const roomId = computed(() => route.params.roomId as string)
const encryptionKey = ref('')

const obsidianUri = computed(() => {
  if (!roomId.value || !encryptionKey.value) return ''
  const liveUrl = `${api.baseUrl}/live/${roomId.value}#${encryptionKey.value}`
  return `obsidian://colab-import?url=${encodeURIComponent(liveUrl)}`
})

const collaborationText = shallowRef<Y.Text | null>(null)
let yjsDoc: Y.Doc | null = null
let wsProvider: WebsocketProvider | null = null

function onContentUpdate(newContent: string) {
  content.value = newContent
}

async function joinSession() {
  try {
    if (import.meta.client) {
      encryptionKey.value = window.location.hash.slice(1)
    }

    // Verify session exists
    const session = await api.getSession(roomId.value)
    if (!session) {
      error.value = 'Session not found'
      errorDetail.value = 'This live session may have ended or the link is invalid.'
      loading.value = false
      return
    }

    // Connect via Yjs WebSocket
    yjsDoc = new Y.Doc()
    const ytext = yjsDoc.getText('content')
    collaborationText.value = ytext

    const wsUrl = api.baseUrl.replace(/^http/, 'ws')
    const apiKey = api.getApiKey()
    const roomToken = encryptionKey.value ? await deriveRoomToken(encryptionKey.value, roomId.value) : ''
    wsProvider = new WebsocketProvider(wsUrl + '/ws/yjs', roomId.value, yjsDoc, {
      params: {
        ...(apiKey ? { token: apiKey } : {}),
        link: roomId.value,
        ...(roomToken ? { rt: roomToken } : {}),
      },
    })

    wsProvider.on('status', ({ status }: { status: string }) => {
      connectionStatus.value = status === 'connecting' ? 'syncing' : status === 'connected' ? 'connected' : 'disconnected'
      if (status === 'connected') {
        loading.value = false
      }
    })

    stopPresence = trackPresence(wsProvider, (roster) => { presence.value = roster })

    ytext.observe(() => {
      content.value = ytext.toString()
    })

    // Timeout fallback
    setTimeout(() => {
      if (loading.value) {
        loading.value = false
      }
    }, 3000)

  } catch (e) {
    error.value = 'Connection failed'
    errorDetail.value = 'Could not connect to the live session. Please try again.'
    loading.value = false
  }
}

onMounted(() => {
  joinSession()
})

onBeforeUnmount(() => {
  stopPresence?.()
  if (wsProvider) wsProvider.destroy()
  if (yjsDoc) yjsDoc.destroy()
})
</script>

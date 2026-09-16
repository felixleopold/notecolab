<template>
  <section class="rounded-xl p-4 border mb-6" style="background: #262626; border-color: #363636;">
    <h2 class="font-semibold">Account access</h2>
    <p class="text-xs mt-1" style="color: #999;">Provider sign-in and browser sessions do not replace your plugin identity key.</p>

    <div v-if="!vaultKeyPresent && hasPassword" class="mt-4 p-3 rounded-lg border" style="background: #332b16; border-color: #6b5a22; color: #fde68a;">
      <strong class="text-sm">Encrypted notes are locked</strong>
      <p class="text-xs mt-1">OAuth authenticated your account, but your Note Colab password is still required to derive the vault key on this device.</p>
      <form class="flex gap-2 mt-3" @submit.prevent="unlockVault">
        <input v-model="password" type="password" placeholder="Note Colab password" class="flex-1 min-w-0 px-3 py-2 rounded-lg text-sm" style="background: #1e1e1e; border: 1px solid #55491f; color: #dcddde;" />
        <button class="px-3 py-2 rounded-lg text-sm font-medium" style="background: #6b5a22; color: #fff;">Unlock</button>
      </form>
      <p v-if="unlockError" class="text-xs mt-2">{{ unlockError }}</p>
    </div>

    <div v-if="providers.length" class="mt-5">
      <h3 class="text-sm font-medium">Linked providers</h3>
      <div class="grid sm:grid-cols-2 gap-2 mt-2">
        <div v-for="provider in providers" :key="provider.id" class="flex items-center justify-between gap-3 p-3 rounded-lg border" style="border-color: #3f3f46; background: #202020;">
          <span class="text-sm">{{ provider.name }}</span>
          <button class="text-xs underline" style="color: #c4b5fd;" @click="linked.includes(provider.id) ? unlink(provider) : link(provider)">{{ linked.includes(provider.id) ? 'Unlink' : 'Link' }}</button>
        </div>
      </div>
    </div>
    <p v-else-if="!loading" class="text-xs mt-4" style="color: #777;">Google and GitHub sign-in are not configured on this server.</p>

    <details v-if="sessions.length" class="mt-5">
      <summary class="text-sm cursor-pointer">Active browser sessions ({{ sessions.length }})</summary>
      <div class="space-y-2 mt-2">
        <div v-for="session in sessions" :key="session.id" class="flex items-center justify-between gap-3 p-3 rounded-lg border" style="border-color: #3f3f46; background: #202020;">
          <div><strong class="text-sm">{{ session.clientLabel || 'Browser session' }}<span v-if="session.current"> · Current</span></strong><p class="text-xs mt-1" style="color: #777;">Last used {{ new Date(session.lastUsedAt).toLocaleString() }}</p></div>
          <button class="text-xs underline" style="color: #f87171;" @click="revoke(session)">Revoke</button>
        </div>
      </div>
    </details>
    <p v-if="error" class="text-xs mt-3" style="color: #f87171;">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { deriveVaultKey } from '~/utils/crypto'
import { beginOAuth, discoverOAuth, type OAuthProvider } from '~/utils/oauth'

interface BrowserSession { id: string; clientLabel: string | null; lastUsedAt: string; current: boolean }

defineProps<{ hasPassword: boolean }>()
const emit = defineEmits<{ unlocked: [] }>()
const config = useRuntimeConfig()
const providers = ref<OAuthProvider[]>([])
const linked = ref<string[]>([])
const sessions = ref<BrowserSession[]>([])
const loading = ref(true)
const error = ref('')
const password = ref('')
const unlockError = ref('')
const vaultKeyPresent = ref(false)

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem('notecolab-api-key') || ''}` }
}

async function accountFetch(path: string, options: RequestInit = {}) {
  return fetch(`${config.public.apiUrl}/api/v1/auth${path}`, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } })
}

async function load() {
  vaultKeyPresent.value = !!sessionStorage.getItem('notecolab-vault-key')
  try {
    const [discovery, identitiesResponse, sessionsResponse] = await Promise.all([
      discoverOAuth(), accountFetch('/identities'), accountFetch('/sessions'),
    ])
    providers.value = discovery.providers
    if (identitiesResponse.ok) linked.value = ((await identitiesResponse.json()) as { providers: { provider: string }[] }).providers.map((item) => item.provider)
    if (sessionsResponse.ok) sessions.value = ((await sessionsResponse.json()) as { sessions: BrowserSession[] }).sessions
  } finally {
    loading.value = false
  }
}

async function link(provider: OAuthProvider) {
  error.value = ''
  const result = await beginOAuth({ provider: provider.id, intent: 'link', returnTo: '/dashboard' })
  if (!result.ok) error.value = result.error
}

async function unlink(provider: OAuthProvider) {
  if (!window.confirm(`Remove ${provider.name} as a sign-in method?`)) return
  const response = await accountFetch(`/identities/${provider.id}`, { method: 'DELETE' })
  if (response.ok) linked.value = linked.value.filter((id) => id !== provider.id)
  else error.value = ((await response.json().catch(() => ({}))) as { error?: string }).error || 'Could not unlink provider'
}

async function revoke(session: BrowserSession) {
  const response = await accountFetch(`/sessions/${session.id}`, { method: 'DELETE' })
  if (!response.ok) return
  if (session.current) {
    localStorage.removeItem('notecolab-api-key')
    localStorage.removeItem('notecolab-uid')
    localStorage.removeItem('notecolab-display-name')
    sessionStorage.removeItem('notecolab-vault-key')
    window.location.href = '/login'
    return
  }
  sessions.value = sessions.value.filter((item) => item.id !== session.id)
}

async function unlockVault() {
  unlockError.value = ''
  const response = await accountFetch('/unlock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password.value }),
  })
  const body = await response.json().catch(() => ({})) as { vaultSalt?: string; error?: string }
  if (!response.ok || !body.vaultSalt) {
    unlockError.value = body.error || 'Could not unlock encrypted notes'
    return
  }
  sessionStorage.setItem('notecolab-vault-key', await deriveVaultKey(password.value, body.vaultSalt))
  password.value = ''
  vaultKeyPresent.value = true
  emit('unlocked')
}

onMounted(load)
</script>

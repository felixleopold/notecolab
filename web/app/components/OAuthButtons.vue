<template>
  <div v-if="loading" class="text-sm text-center" style="color: #777;">Checking sign-in options…</div>
  <div v-else-if="providers.length" class="space-y-3">
    <div class="flex items-center gap-3"><span class="h-px flex-1" style="background: #363636;" /><span class="text-xs" style="color: #777;">or continue with</span><span class="h-px flex-1" style="background: #363636;" /></div>
    <div v-if="registrationMode === 'invite'" class="space-y-1.5">
      <label class="block text-xs font-medium" style="color: #999;">Server invite code, only needed for a new account</label>
      <input v-model="inviteCode" type="password" class="w-full px-3 py-2.5 rounded-lg text-sm outline-none" style="background: #1e1e1e; border: 1px solid #363636; color: #dcddde;" />
    </div>
    <button v-for="provider in providers" :key="provider.id" type="button" class="w-full py-2.5 rounded-lg text-sm font-medium border" style="background: #202020; border-color: #454545; color: #e8e9ea;" :disabled="!!activeProvider" @click="start(provider)">
      {{ activeProvider === provider.id ? `Opening ${provider.name}…` : `Continue with ${provider.name}` }}
    </button>
    <p v-if="registrationMode === 'closed'" class="text-xs" style="color: #777;">Provider sign-in works for linked accounts. This server does not allow new self-registered accounts.</p>
    <p class="text-xs leading-relaxed" style="color: #777;">Sign in to your account. Opening encrypted notes still requires your Note Colab password.</p>
  </div>
  <p v-else-if="showUnavailable" class="text-xs text-center" style="color: #777;">Google and GitHub sign-in are not configured on this server.</p>
</template>

<script setup lang="ts">
import { beginOAuth, discoverOAuth, type OAuthProvider } from '~/utils/oauth'

const props = withDefaults(defineProps<{ returnTo?: string; showUnavailable?: boolean }>(), {
  returnTo: '/dashboard',
  showUnavailable: false,
})
const emit = defineEmits<{ error: [message: string] }>()
const providers = ref<OAuthProvider[]>([])
const registrationMode = ref<'open' | 'invite' | 'closed'>('open')
const inviteCode = ref('')
const loading = ref(true)
const activeProvider = ref('')

onMounted(async () => {
  try {
    const discovery = await discoverOAuth()
    providers.value = discovery.providers
    registrationMode.value = discovery.registrationMode
  } catch {
    providers.value = []
  } finally {
    loading.value = false
  }
})

async function start(provider: OAuthProvider) {
  activeProvider.value = provider.id
  const result = await beginOAuth({
    provider: provider.id,
    intent: 'login',
    returnTo: props.returnTo,
    inviteCode: inviteCode.value,
  })
  if (!result.ok) {
    activeProvider.value = ''
    emit('error', result.error)
  }
}
</script>

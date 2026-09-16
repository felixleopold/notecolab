<template>
  <div class="flex-1 min-h-0 overflow-y-auto flex items-center justify-center" style="background-color: #1e1e1e; color: #dcddde;">
    <div class="w-full max-w-md mx-auto px-4 py-16">
      <div class="rounded-2xl p-6 border" style="background: #262626; border-color: #363636;">
        <h2 class="text-2xl font-bold mb-2 text-center">Login</h2>
        <p class="text-sm text-center mb-6" style="color: #999;">
          Sign in with your UID and password to access your dashboard.
        </p>

        <div v-if="error" class="mb-4 p-3 rounded-lg text-sm" style="background: #3b1c1c; color: #f87171; border: 1px solid #5c2626;">
          {{ error }}
        </div>

        <form @submit.prevent="handleLogin" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1.5" style="color: #999;">User UID</label>
            <input
              v-model="uid"
              type="text"
              placeholder="Your UID from the plugin settings"
              class="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-colors"
              style="background: #1e1e1e; border: 1px solid #363636; color: #dcddde;"
              :disabled="loading"
            />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1.5" style="color: #999;">Password</label>
            <input
              v-model="password"
              type="password"
              placeholder="Your password"
              class="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-colors"
              style="background: #1e1e1e; border: 1px solid #363636; color: #dcddde;"
              :disabled="loading"
            />
          </div>
          <button
            type="submit"
            class="w-full py-2.5 rounded-lg font-medium text-sm transition-all duration-200 text-white"
            :class="loading ? 'opacity-50 cursor-not-allowed' : 'hover:-translate-y-0.5'"
            style="background: var(--obsidian-accent, #7f6df2);"
            :disabled="loading"
          >
            {{ loading ? 'Signing in...' : 'Sign in' }}
          </button>
        </form>

        <OAuthButtons return-to="/dashboard" @error="error = $event" />

        <div class="mt-6 pt-4 text-center text-xs" style="border-top: 1px solid #363636; color: #666;">
          <p>To set a password, open the Obsidian plugin settings:</p>
          <code class="text-obsidian-accent">Settings → NoteColab → Web dashboard</code>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { deriveVaultKey } from '~/utils/crypto'
import { completeOAuth } from '~/utils/oauth'

const router = useRouter();
const route = useRoute();
const { login, isLoggedIn, setVaultKey } = useApi();

const uid = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

onMounted(async () => {
  if (route.query.oauth) {
    loading.value = true;
    const result = await completeOAuth();
    loading.value = false;
    if ('error' in result) {
      error.value = result.error;
      return;
    }
    await router.replace(result.returnTo || '/dashboard');
    return;
  }
  if (isLoggedIn()) {
    router.push('/dashboard');
  }
});

async function handleLogin() {
  error.value = '';
  if (!uid.value || !password.value) {
    error.value = 'Please enter both UID and password.';
    return;
  }
  loading.value = true;
  try {
    const result = await login(uid.value, password.value);
    if (result.ok) {
      // Derive and store vault key for note decryption
      if (result.vaultSalt) {
        try {
          const vk = await deriveVaultKey(password.value, result.vaultSalt);
          setVaultKey(vk);
        } catch (e) {
          console.warn('Failed to derive vault key:', e);
        }
      }
      router.push('/dashboard');
    } else {
      error.value = result.error || 'Login failed. Check your credentials.';
    }
  } catch {
    error.value = 'Network error. Please try again.';
  } finally {
    loading.value = false;
  }
}
</script>

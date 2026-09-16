<template>
  <div class="flex-1 min-h-0 flex items-center justify-center" style="background-color: #1e1e1e;">
    <!-- Loading -->
    <div v-if="loading" class="text-center px-4">
      <div class="w-10 h-10 border-2 border-obsidian-accent border-t-transparent rounded-full animate-spin mx-auto mb-5" />
      <p class="text-sm font-medium" style="color: #999;">Loading invite...</p>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="text-center max-w-md px-6">
      <div class="w-16 h-16 rounded-2xl mx-auto mb-5 flex items-center justify-center" style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.15);">
        <svg class="w-8 h-8" style="color: #ef4444;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
      </div>
      <h2 class="text-xl font-semibold mb-2" style="color: #e8e9ea;">{{ error }}</h2>
      <p class="text-sm mb-6" style="color: #999;">{{ errorDetail }}</p>
      <NuxtLink
        to="/"
        class="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg transition-all duration-200 hover:-translate-y-0.5"
        style="background: rgba(127, 109, 242, 0.1); color: #c4b5fd; border: 1px solid rgba(127, 109, 242, 0.2);"
      >
        Back to home
      </NuxtLink>
    </div>

    <!-- Invite card -->
    <div v-else class="max-w-lg w-full mx-4">
      <div class="rounded-2xl overflow-hidden" style="background: #262626; border: 1px solid #363636;">
        <!-- Header -->
        <div class="px-8 pt-8 pb-6 text-center" style="border-bottom: 1px solid #363636;">
          <div class="w-16 h-16 rounded-2xl mx-auto mb-5 flex items-center justify-center" style="background: rgba(127, 109, 242, 0.1); border: 1px solid rgba(127, 109, 242, 0.2);">
            <svg class="w-8 h-8" style="color: #c4b5fd;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM3 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 9.374 21c-2.331 0-4.512-.645-6.374-1.766Z" />
            </svg>
          </div>
          <h1 class="text-2xl font-bold mb-2" style="color: #e8e9ea;">You've been invited</h1>
          <p class="text-sm" style="color: #999;">to collaborate on a shared note</p>
        </div>

        <!-- Note info -->
        <div class="px-8 py-6">
          <div class="flex items-center gap-3 mb-4 p-4 rounded-xl" style="background: #1e1e1e; border: 1px solid #363636;">
            <div class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style="background: rgba(127, 109, 242, 0.1);">
              <svg class="w-5 h-5" style="color: #c4b5fd;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
            </div>
            <div class="min-w-0">
              <p class="font-semibold truncate" style="color: #e8e9ea;">{{ invite.title }}</p>
              <p class="text-xs" style="color: #999;">Shared with you</p>
            </div>
          </div>

          <p class="text-sm mb-6 text-center" style="color: #999;">
            Import this note into Obsidian to start collaborating. REST-stored note material is client-encrypted; live Yjs text is visible to the relay.
          </p>

          <!-- Open in Obsidian button -->
          <a
            :href="obsidianUri"
            class="flex items-center justify-center gap-3 w-full py-3.5 rounded-xl font-medium text-white transition-all duration-200 hover:-translate-y-0.5"
            style="background: linear-gradient(135deg, #7f6df2, #9b8afb); box-shadow: 0 4px 16px rgba(127, 109, 242, 0.3);"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
            Open in Obsidian
          </a>

          <p class="text-xs text-center mt-4" style="color: #666;">
            Requires the NoteColab plugin installed in Obsidian
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { decrypt } from '~/utils/crypto';

const route = useRoute();
const config = useRuntimeConfig();

const token = route.params.token as string;
const loading = ref(true);
const error = ref('');
const errorDetail = ref('');
const invite = ref({ title: '', shareId: '' });

// The encryption key is in the URL fragment — never sent to server
const encryptionKey = ref('');

onMounted(async () => {
  // Extract encryption key from fragment
  encryptionKey.value = window.location.hash.slice(1);

  try {
    // The public lookup returns no sender identity and no plaintext title — the
    // title is only readable with the key from the URL fragment. (issue #19)
    const res = await $fetch<{
      encryptedTitle: string | null;
      shareId: string;
    }>(`${config.public.apiUrl}/api/v1/notes/invite/${encodeURIComponent(token)}`);

    let title = 'Encrypted note';
    if (res.encryptedTitle && encryptionKey.value) {
      try {
        title = await decrypt(res.encryptedTitle, encryptionKey.value);
      } catch {
        title = 'Encrypted note';
      }
    }
    invite.value = { shareId: res.shareId, title };
  } catch (e: any) {
    const status = e?.response?.status || e?.status;
    if (status === 404) {
      error.value = 'Invite not found';
      errorDetail.value = 'This invite link may be invalid or has been deleted.';
    } else if (status === 410) {
      const retired = (e?.response?._data?.code || e?.data?.code) === 'invite_token_retired';
      error.value = retired ? 'Invite link retired' : 'Invite expired';
      errorDetail.value = retired
        ? 'This link uses an older, less secure format that is no longer accepted. Ask the sender for a new link.'
        : 'This invite link has expired or has already been used.';
    } else if (status === 429) {
      error.value = 'Too many requests';
      errorDetail.value = 'Too many invite lookups from your network. Please wait a minute and try again.';
    } else {
      error.value = 'Something went wrong';
      errorDetail.value = 'Could not load invite details. Please try again.';
    }
  } finally {
    loading.value = false;
  }
});

const obsidianUri = computed(() => {
  if (!invite.value.shareId || !encryptionKey.value) return '#';
  // Build the share URL that the plugin will use to import
  const shareUrl = `${config.public.apiUrl}/s/${invite.value.shareId}#${encryptionKey.value}`;
  return `obsidian://colab-import?url=${encodeURIComponent(shareUrl)}&invite=${encodeURIComponent(token)}`;
});
</script>

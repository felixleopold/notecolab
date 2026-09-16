<template>
  <div class="flex-1 min-h-0 overflow-y-auto" style="background-color: #1e1e1e; color: #dcddde;">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <!-- Header -->
      <div class="flex items-center justify-between mb-8">
        <div>
          <h1 class="text-2xl font-bold">Dashboard</h1>
          <p class="text-sm mt-1" style="color: #999;">
            Logged in as <code class="text-obsidian-accent text-xs">{{ userUid?.substring(0, 12) }}...</code>
            <button type="button" class="ml-2 text-xs underline" @click="copyUserId">Copy full User ID</button>
          </p>
        </div>
        <div class="flex items-center gap-3">
          <button
            @click="showPasswordModal = true"
            class="px-4 py-2 rounded-lg text-sm font-medium transition-all border"
            style="background: #262626; border-color: #363636; color: #dcddde;"
          >
            {{ hasPassword ? 'Change Password' : 'Set Password' }}
          </button>
          <button
            @click="handleLogout"
            class="px-4 py-2 rounded-lg text-sm font-medium transition-all border"
            style="background: #3b1c1c; border-color: #5c2626; color: #f87171;"
          >
            Logout
          </button>
        </div>
      </div>

      <AccountAccess :has-password="hasPassword" @unlocked="loadData" />

      <!-- Plan & storage -->
      <div v-if="billing" class="rounded-xl p-4 border mb-6" style="background: #262626; border-color: #363636;">
        <div v-if="isOutOfSpace && upgradePlans.length" class="mb-4 p-3 rounded-lg border" style="background: #3b1c1c; border-color: #7f1d1d; color: #fecaca;">
          <p class="font-semibold">You’re out of storage.</p>
          <p class="text-xs mt-1">New notes and uploads are paused. Choose a larger plan or delete shared notes to continue.</p>
        </div>
        <div v-if="upgradePlans.length && !hasPassword" class="mb-4 p-3 rounded-lg border" style="background: #332b16; border-color: #6b5a22; color: #fde68a;">
          <p class="font-semibold">Protect this account before paying.</p>
          <p class="text-xs mt-1">Strongly recommended: set a password and save your full User ID. Without both, a plugin reset or lost device can permanently strand the account, its notes, and its paid storage.</p>
          <button type="button" class="text-xs mt-2 underline" @click="showPasswordModal = true">Set password</button>
        </div>
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium" style="color: #e8e9ea;">{{ planLabel }}</span>
              <span v-if="currentPlan && !currentPlan.isDefault" class="px-2 py-0.5 rounded-full text-xs" style="background: #2a1c3b; color: #c4b5fd;">{{ currentPlan.name.toUpperCase() }}</span>
            </div>
            <p class="text-xs mt-1" style="color: #999;">{{ usageText }}</p>
          </div>
        </div>
        <div v-if="billing.storage && !billing.storage.unlimited" class="mt-3 h-1.5 rounded-full overflow-hidden" style="background: #1e1e1e;">
          <div class="h-full rounded-full" :style="{ width: Math.min(100, billing.storage.usagePercent) + '%', background: usageColor }"></div>
        </div>
        <div v-if="upgradePlans.length" class="grid gap-2 mt-4 sm:grid-cols-3">
          <div v-for="plan in upgradePlans" :key="plan.id" class="rounded-lg border p-3" style="border-color: #3f3f46; background: #202020;">
            <div class="flex items-start justify-between gap-2">
              <strong class="text-sm" style="color: #e8e9ea;">{{ plan.name }}</strong>
              <span class="text-xs whitespace-nowrap" style="color: #c4b5fd;">{{ plan.priceLabel }}</span>
            </div>
            <p v-if="plan.description" class="text-xs mt-2" style="color: #aaa;">{{ plan.description }}</p>
            <p class="text-xs mt-1" style="color: #777;">{{ formatPlanStorage(plan.quotaBytes) }}</p>
            <button
              @click="handleUpgrade(plan.id)"
              :disabled="!!upgradingPlanId"
              class="w-full mt-3 px-3 py-2 rounded-lg text-sm font-medium text-white cursor-pointer disabled:opacity-60"
              style="background: var(--obsidian-accent, #7f6df2);"
            >
              {{ upgradingPlanId === plan.id ? 'Opening…' : `Choose ${plan.name}` }}
            </button>
          </div>
        </div>
        <p v-if="upgradeError" class="text-xs mt-2" style="color: #f87171;">{{ upgradeError }}</p>
        <p v-else-if="currentPlan?.isDefault && !billing.checkoutAvailable" class="text-xs mt-2" style="color: #777;">
          Paid upgrades are unavailable on this server. You can free up space or run your own — see the project README.
        </p>
        <p v-if="showsUnlimitedPlan" class="text-xs mt-2" style="color: #777;">
          * Unlimited storage is available as long as the NoteColab server has sufficient storage capacity.
        </p>
      </div>

      <!-- Tabs -->
      <div class="flex gap-1 mb-6 p-1 rounded-lg" style="background: #262626;">
        <button
          @click="activeTab = 'my-notes'"
          class="flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors"
          :style="activeTab === 'my-notes' ? 'background: #363636; color: #dcddde;' : 'color: #999;'"
        >
          My Notes ({{ myNotes.length }})
        </button>
        <button
          @click="activeTab = 'shared-with-me'"
          class="flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors"
          :style="activeTab === 'shared-with-me' ? 'background: #363636; color: #dcddde;' : 'color: #999;'"
        >
          Shared with Me ({{ sharedNotes.length }})
          <span v-if="pendingCount > 0" class="ml-1 px-1.5 py-0.5 rounded-full text-xs text-white" style="background: #7f6df2;">{{ pendingCount }} pending</span>
        </button>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="text-center py-12" style="color: #999;">
        Loading...
      </div>

      <!-- My Notes -->
      <div v-else-if="activeTab === 'my-notes'">
        <div v-if="myNotes.length === 0" class="text-center py-12 rounded-2xl border" style="background: #262626; border-color: #363636; color: #999;">
          <p>No shared notes yet.</p>
          <p class="text-sm mt-1">Share a note from the Obsidian plugin to see it here.</p>
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="note in myNotes"
            :key="note.noteShareId"
            class="rounded-xl p-4 border transition-colors hover:border-obsidian-accent/30"
            style="background: #262626; border-color: #363636;"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0 flex-1">
                <h3 class="font-medium truncate" style="color: #e8e9ea;">
                  {{ note.title || 'Encrypted note' }}
                </h3>
                <div class="flex flex-wrap items-center gap-2 mt-1.5 text-xs" style="color: #999;">
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full" :style="modeStyle(note.links?.[0]?.accessMode)">
                    {{ modeLabel(note.links?.[0]?.accessMode) }}
                  </span>
                  <span v-if="note.links?.some((l: any) => l.expired)" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full" style="background: rgba(239, 68, 68, 0.15); color: #f87171;">
                    Expired
                  </span>
                  <span>{{ note.links?.length || 0 }} link{{ (note.links?.length || 0) !== 1 ? 's' : '' }}</span>
                  <span>&middot;</span>
                  <span>Updated {{ timeAgo(note.updatedAt) }}</span>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button
                  v-if="note.links?.[0]"
                  @click="openNote(note.noteShareId)"
                  class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors text-white cursor-pointer"
                  style="background: var(--obsidian-accent, #7f6df2);"
                >
                  Open
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Shared with Me -->
      <div v-else-if="activeTab === 'shared-with-me'">
        <div v-if="sharedLoadError" class="text-center py-12 rounded-2xl border" style="background: #2a1d1d; border-color: #5c2626; color: #f87171;">
          <p>Could not load shared notes.</p>
          <button
            @click="loadData"
            class="mt-3 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors text-white cursor-pointer"
            style="background: #7f1d1d;"
          >
            Retry
          </button>
        </div>
        <div v-else-if="sharedNotes.length === 0 && pendingShares.length === 0" class="text-center py-12 rounded-2xl border" style="background: #262626; border-color: #363636; color: #999;">
          <p>No notes shared with you yet.</p>
          <p class="text-sm mt-1">Ask someone to add your UID as a collaborator on their notes.</p>
        </div>
        <div v-else class="space-y-3">
          <div v-if="pendingShares.length > 0" class="mb-2">
            <h2 class="text-sm font-semibold mb-2" style="color: #e8e9ea;">Pending invitations</h2>
            <div class="space-y-3">
              <div
                v-for="share in pendingShares"
                :key="share.id"
                class="rounded-xl p-4 border"
                style="background: #262626; border-color: #363636;"
              >
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0 flex-1">
                    <h3 class="font-medium truncate" style="color: #e8e9ea;">
                      {{ share.title || 'Encrypted note' }}
                    </h3>
                    <div class="flex flex-wrap items-center gap-2 mt-1.5 text-xs" style="color: #999;">
                      <span>From {{ share.senderName || `${share.senderUid?.substring(0, 8)}...` }}</span>
                      <span>&middot;</span>
                      <span>{{ timeAgo(share.createdAt) }}</span>
                    </div>
                    <p class="text-xs mt-2" style="color: #777;">
                      Accept and import this invitation in Obsidian so the encrypted note key can be unwrapped locally.
                    </p>
                  </div>
                  <button
                    @click="dismissPendingShare(share.id)"
                    class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
                    style="background: #3b1c1c; color: #f87171;"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          </div>
          <h2 v-if="sharedNotes.length > 0" class="text-sm font-semibold mb-2" style="color: #e8e9ea;">Shared notes</h2>
          <div
            v-for="note in sharedNotes"
            :key="note.shareId"
            class="rounded-xl p-4 border transition-colors hover:border-obsidian-accent/30"
            style="background: #262626; border-color: #363636;"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0 flex-1">
                <h3 class="font-medium truncate" style="color: #e8e9ea;">
                  {{ note.title || 'Encrypted note' }}
                </h3>
                <div class="flex flex-wrap items-center gap-2 mt-1.5 text-xs" style="color: #999;">
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full" :style="modeStyle(note.accessMode)">
                    {{ modeLabel(note.accessMode) }}
                  </span>
                  <span v-if="note.canEdit" class="text-green-400">Can edit</span>
                  <span v-else class="text-yellow-400">View only</span>
                  <span>&middot;</span>
                  <span>From {{ note.ownerUid?.substring(0, 8) }}...</span>
                  <span>&middot;</span>
                  <span>Updated {{ timeAgo(note.updatedAt) }}</span>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button
                  @click="openNote(note.shareId)"
                  class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors text-white cursor-pointer"
                  style="background: var(--obsidian-accent, #7f6df2);"
                >
                  Open
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Password Modal -->
      <div v-if="showPasswordModal" class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.6);">
        <div class="w-full max-w-sm mx-4 rounded-2xl p-6 border" style="background: #262626; border-color: #363636;">
          <h3 class="text-lg font-bold mb-4">{{ hasPassword ? 'Change Password' : 'Set Password' }}</h3>
          <div v-if="pwError" class="mb-3 p-2 rounded-lg text-sm" style="background: #3b1c1c; color: #f87171;">{{ pwError }}</div>
          <div v-if="pwSuccess" class="mb-3 p-2 rounded-lg text-sm" style="background: #1c3b1c; color: #4ade80;">Password updated!</div>
          <form @submit.prevent="handleSetPassword" class="space-y-3">
            <input
              v-model="newPassword"
              type="password"
              placeholder="New password (min 8 chars)"
              class="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
              style="background: #1e1e1e; border: 1px solid #363636; color: #dcddde;"
            />
            <input
              v-model="confirmPassword"
              type="password"
              placeholder="Confirm password"
              class="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
              style="background: #1e1e1e; border: 1px solid #363636; color: #dcddde;"
            />
            <div class="flex gap-2">
              <button
                type="button"
                @click="showPasswordModal = false"
                class="flex-1 py-2 rounded-lg text-sm font-medium border"
                style="background: #1e1e1e; border-color: #363636; color: #999;"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="flex-1 py-2 rounded-lg text-sm font-medium text-white"
                style="background: var(--obsidian-accent, #7f6df2);"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { decrypt, decryptVaultKey, deriveVaultKey } from '~/utils/crypto'

const router = useRouter();
const { isLoggedIn, getUid, getMyNotes, getSharedWithMe, getPendingShares, getMe, setPassword, logout, getVaultKeys, getVaultKey, setVaultKey, fetchWithAuth, getBillingInfo, createCheckout } = useApi();

const userUid = ref('');
const activeTab = ref('my-notes');
const loading = ref(true);
const myNotes = ref<any[]>([]);
const sharedNotes = ref<any[]>([]);
const pendingShares = ref<any[]>([]);
const pendingCount = ref(0);
const sharedLoadError = ref(false);
const hasPassword = ref(false);

interface BillingPlan {
  id: string;
  name: string;
  description: string | null;
  quotaBytes: number;
  priceLabel: string | null;
  checkoutAvailable: boolean;
  isDefault: boolean;
}

const billing = ref<any>(null);
const upgradingPlanId = ref('');
const upgradeError = ref('');

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const planLabel = computed(() => {
  if (!billing.value) return '';
  return `Plan: ${currentPlan.value?.name || billing.value.plan || 'Unknown'}`;
});

const currentPlan = computed(() => billing.value?.plans?.[billing.value?.plan]);
const upgradePlans = computed(() => {
  const storage = billing.value?.storage;
  if (!storage) return [];
  return (Object.values(billing.value?.plans || {}) as BillingPlan[])
    .filter((plan) => plan.checkoutAvailable && plan.id !== billing.value?.plan
      && (plan.quotaBytes <= 0 || (!storage.unlimited && plan.quotaBytes > storage.limitBytes)))
    .sort((a, b) => (a.quotaBytes <= 0 ? Number.POSITIVE_INFINITY : a.quotaBytes)
      - (b.quotaBytes <= 0 ? Number.POSITIVE_INFINITY : b.quotaBytes));
});

const usageText = computed(() => {
  const s = billing.value?.storage;
  if (!s) return '';
  if (s.unlimited) return `${fmtBytes(s.usedBytes)} used — unlimited storage`;
  let t = `${fmtBytes(s.usedBytes)} of ${fmtBytes(s.limitBytes)} (${s.usagePercent}%)`;
  if (!currentPlan.value?.isDefault && billing.value.planExpiresAt) {
    t += ` · ${currentPlan.value?.name || 'Plan'} until ${new Date(billing.value.planExpiresAt).toLocaleDateString()}`;
  }
  return t;
});

const isOutOfSpace = computed(() => !!billing.value?.storage && !billing.value.storage.unlimited && billing.value.storage.usagePercent >= 100);
const showsUnlimitedPlan = computed(() => (currentPlan.value?.quotaBytes ?? 1) <= 0
  || upgradePlans.value.some((plan) => plan.quotaBytes <= 0));

function formatPlanStorage(bytes: number): string {
  return bytes <= 0 ? 'Unlimited storage*' : `${fmtBytes(bytes)} storage`;
}

const usageColor = computed(() => {
  const pct = billing.value?.storage?.usagePercent || 0;
  return pct >= 95 ? '#f87171' : pct >= 80 ? '#fb923c' : '#7f6df2';
});

async function copyUserId() {
  await navigator.clipboard.writeText(userUid.value);
}

async function handleUpgrade(planId: string) {
  if (!hasPassword.value) {
    const proceed = window.confirm(
      'No account recovery password is set. You can continue, but a plugin reset or lost device may permanently strand the subscription and stored notes. Strongly consider setting a password and saving your User ID first. Continue anyway?',
    );
    if (!proceed) {
      showPasswordModal.value = true;
      return;
    }
  }
  upgradingPlanId.value = planId;
  upgradeError.value = '';
  const res = await createCheckout(planId);
  if (res.url) {
    window.location.href = res.url;
  } else {
    upgradeError.value = res.error || 'Could not start checkout';
    upgradingPlanId.value = '';
  }
}

const showPasswordModal = ref(false);
const newPassword = ref('');
const confirmPassword = ref('');
const pwError = ref('');
const pwSuccess = ref(false);

// Vault key map: noteShareId → encrypted key
const vaultKeyMap = ref<Map<string, string>>(new Map());

interface TitledNote {
  title?: string | null;
  encryptedTitle?: string | null;
}

interface DashboardNote extends TitledNote {
  noteShareId: string;
}

interface SharedDashboardNote extends TitledNote {
  shareId: string;
}

onMounted(async () => {
  if (!isLoggedIn()) {
    router.push('/login');
    return;
  }
  userUid.value = getUid() || '';
  await loadData();
});

async function loadData() {
  loading.value = true;
  try {
    const [notes, shared, pending, me, vaultKeys, billingInfo] = await Promise.all([
      getMyNotes(),
      getSharedWithMe(),
      getPendingShares(),
      getMe(),
      getVaultKeys(),
      getBillingInfo(),
    ]);
    myNotes.value = notes;
    sharedLoadError.value = shared === null;
    sharedNotes.value = shared || [];
    pendingShares.value = pending;
    pendingCount.value = pending.length;
    hasPassword.value = me?.hasPassword || false;
    billing.value = billingInfo;

    // Build vault key map
    const map = new Map<string, string>();
    for (const vk of vaultKeys) {
      map.set(vk.note_share_id, vk.encrypted_key);
    }
    vaultKeyMap.value = map;

    const vaultKey = getVaultKey();
    if (vaultKey) {
      const decryptNoteTitle = async (note: TitledNote, keyId: string) => {
        if (!note.encryptedTitle) return note.title || 'Encrypted note';
        const wrappedKey = map.get(keyId);
        if (!wrappedKey) return note.title || 'Encrypted note';
        try {
          const noteKey = await decryptVaultKey(wrappedKey, vaultKey);
          return await decrypt(note.encryptedTitle, noteKey);
        } catch {
          return note.title || 'Encrypted note';
        }
      };

      myNotes.value = await Promise.all((myNotes.value as DashboardNote[]).map(async (note) => ({
        ...note,
        title: await decryptNoteTitle(note, note.noteShareId),
      })));
      sharedNotes.value = await Promise.all((sharedNotes.value as SharedDashboardNote[]).map(async (note) => ({
        ...note,
        title: await decryptNoteTitle(note, note.shareId),
      })));
    }

    pendingShares.value = pendingShares.value.map((share) => ({
      ...share,
      title: 'Encrypted note',
    }));
  } finally {
    loading.value = false;
  }
}

async function openNote(shareId: string) {
  const vaultKey = getVaultKey();
  const encryptedKey = vaultKeyMap.value.get(shareId);

  if (vaultKey && encryptedKey) {
    try {
      const noteKey = await decryptVaultKey(encryptedKey, vaultKey);
      // Use window.location for hash-based navigation (router.push may not preserve hash correctly)
      window.location.href = `/s/${shareId}#${noteKey}`;
      return;
    } catch (e) {
      console.warn('Failed to decrypt vault key:', e);
    }
  }

  // Fallback: open without key (will show "Missing decryption key" error)
  window.location.href = `/s/${shareId}`;
}

async function dismissPendingShare(id: number) {
  const res = await fetchWithAuth(`/api/v1/notes/pending-shares/${id}/dismiss`, { method: 'POST' });
  if (res.ok) {
    pendingShares.value = pendingShares.value.filter((share) => share.id !== id);
    pendingCount.value = pendingShares.value.length;
  }
}

async function handleLogout() {
  await logout();
  router.push('/');
}

async function handleSetPassword() {
  pwError.value = '';
  pwSuccess.value = false;
  if (newPassword.value.length < 8) {
    pwError.value = 'Password must be at least 8 characters.';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    pwError.value = 'Passwords do not match.';
    return;
  }

  // Get old vault key to re-encrypt existing vault keys
  const oldVaultKey = getVaultKey();

  const result = await setPassword(newPassword.value);
  if (result.ok && result.vaultSalt) {
    // Derive new vault key and update sessionStorage
    try {
      const newVaultKey = await deriveVaultKey(newPassword.value, result.vaultSalt);
      setVaultKey(newVaultKey);

      // Re-encrypt existing vault keys if we had an old vault key
      if (oldVaultKey && vaultKeyMap.value.size > 0) {
        const { encrypt } = await import('~/utils/crypto');
        const reEncrypted: { noteShareId: string; encryptedKey: string }[] = [];
        for (const [shareId, encKey] of vaultKeyMap.value) {
          try {
            const plainKey = await decryptVaultKey(encKey, oldVaultKey);
            const newEncKey = await encrypt(plainKey, newVaultKey);
            reEncrypted.push({ noteShareId: shareId, encryptedKey: newEncKey });
          } catch {
            // Skip keys that can't be decrypted
          }
        }
        if (reEncrypted.length > 0) {
          await fetchWithAuth('/api/v1/auth/vault-keys', {
            method: 'POST',
            body: JSON.stringify({ keys: reEncrypted }),
          });
          // Update local map
          const map = new Map<string, string>();
          for (const k of reEncrypted) {
            map.set(k.noteShareId, k.encryptedKey);
          }
          vaultKeyMap.value = map;
        }
      }
    } catch (e) {
      console.warn('Failed to re-derive vault key:', e);
    }

    pwSuccess.value = true;
    hasPassword.value = true;
    newPassword.value = '';
    confirmPassword.value = '';
    setTimeout(() => { showPasswordModal.value = false; pwSuccess.value = false; }, 1500);
  } else if (result.ok) {
    pwSuccess.value = true;
    hasPassword.value = true;
    newPassword.value = '';
    confirmPassword.value = '';
    setTimeout(() => { showPasswordModal.value = false; pwSuccess.value = false; }, 1500);
  } else {
    pwError.value = 'Failed to set password. Please try again.';
  }
}

function modeLabel(mode: string) {
  switch (mode) {
    case 'public_edit': return 'Editable link';
    case 'invited_edit': return 'Invited collaborators';
    case 'read_only': return 'View-only link';
    default: return mode || 'Unknown';
  }
}

function modeStyle(mode: string) {
  switch (mode) {
    case 'public_edit': return 'background: #1c3b1c; color: #4ade80;';
    case 'invited_edit': return 'background: #1c2a3b; color: #60a5fa;';
    case 'read_only': return 'background: #3b3b1c; color: #facc15;';
    default: return 'background: #363636; color: #999;';
  }
}

function timeAgo(dateStr: string) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
</script>

<template>
  <main class="pw-admin">
    <header class="topbar">
      <div class="topbar-inner">
        <NuxtLink to="/" class="wordmark">NOTECOLAB :: ADMIN</NuxtLink>
        <div class="system-state"><span class="status-square" :class="{ online: authenticated }" /> {{ authenticated ? 'connected' : 'locked' }}</div>
      </div>
    </header>

    <div v-if="!authenticated" class="auth-wrap">
      <section class="panel auth-panel">
        <div class="panel-head"><div><span class="eyebrow">PRIVATE ACCESS</span><h1>Administration</h1></div></div>
        <form class="panel-body auth-form" @submit.prevent="connect">
          <label for="admin-secret">ADMIN_SECRET</label>
          <input id="admin-secret" v-model="secret" type="password" autocomplete="current-password" autofocus>
          <p class="help">The secret stays in this browser and is sent only as a Bearer token to your NoteColab API.</p>
          <p v-if="error" class="message critical">{{ error }}</p>
          <button class="button primary" :disabled="loading">{{ loading ? '[connecting]' : '[connect]' }}</button>
        </form>
      </section>
    </div>

    <div v-else class="container">
      <section class="page-intro">
        <div><span class="eyebrow">CONTROL PLANE</span><h1>Service overview</h1><p>Users, storage allocation, and commercial plans.</p></div>
        <div class="actions"><button class="button" :disabled="loading" @click="loadAll">[refresh]</button><button class="button" @click="disconnect">[lock]</button></div>
      </section>

      <p v-if="error" class="message critical">{{ error }}</p>
      <p v-if="notice" class="message positive">{{ notice }}</p>

      <section class="metrics" aria-label="Service metrics">
        <article><span>USERS</span><strong>{{ stats?.users ?? '—' }}</strong></article>
        <article><span>NOTES</span><strong>{{ stats?.notes ?? '—' }}</strong></article>
        <article><span>DATA STORED</span><strong>{{ formatMb(stats?.storage.totalDataBytes) }}</strong></article>
        <article><span>STALE / 1Y</span><strong>{{ stats?.expiry.staleOver1Year ?? '—' }}</strong></article>
      </section>

      <section class="section-block">
        <div class="section-heading"><div><span class="eyebrow">01 / USERS</span><h2>Account management</h2></div><button class="button primary" @click="provisionUser">[+ provision user]</button></div>
        <div v-if="newCredentials" class="credentials">
          <div><span>NEW UID</span><code>{{ newCredentials.uid }}</code></div>
          <div><span>API KEY — SHOWN ONCE</span><code>{{ newCredentials.apiKey }}</code></div>
          <button class="button" @click="copyCredentials">[copy credentials]</button>
        </div>
        <div class="panel table-panel">
          <div class="table-wrap">
            <table>
              <thead><tr><th>IDENTITY</th><th>PLAN</th><th>USAGE</th><th>NOTES</th><th>CREATED</th><th>LAST SEEN</th><th>ACTIONS</th></tr></thead>
              <tbody>
                <tr v-for="user in users" :key="user.uid">
                  <td data-label="IDENTITY"><strong>{{ user.displayName || 'Anonymous' }}</strong><code>{{ user.uid }}</code></td>
                  <td data-label="PLAN">
                    <select v-model="user.plan"><option v-for="plan in plans" :key="plan.id" :value="plan.id">{{ plan.name }}</option></select>
                    <small v-if="user.planExpiresAt">until {{ formatDate(user.planExpiresAt) }}</small>
                  </td>
                  <td data-label="USAGE"><span>{{ formatMb(user.storage.totalBytes) }}</span><div class="usage"><i :style="{ width: usageWidth(user) }" /></div></td>
                  <td data-label="NOTES" class="numeric">{{ user.noteCount }}</td>
                  <td data-label="CREATED">{{ formatDate(user.createdAt) }}</td>
                  <td data-label="LAST SEEN">{{ user.lastSeenAt ? formatDateTime(user.lastSeenAt) : '—' }}</td>
                  <td data-label="ACTIONS"><div class="row-actions"><button class="button compact" @click="saveUserPlan(user)">[save]</button><button class="button compact danger" @click="deleteUser(user)">[delete]</button></div></td>
                </tr>
                <tr v-if="users.length === 0"><td colspan="7" class="empty">No users.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="section-block">
        <div class="section-heading"><div><span class="eyebrow">02 / PLANS</span><h2>Billing model</h2><p>Plan changes apply to quota checks immediately. Checkout requires BILLING_ENABLED=true.</p></div><button class="button primary" @click="startNewPlan">[+ add plan]</button></div>
        <div class="plan-grid">
          <form v-for="plan in editablePlans" :key="plan.id" class="panel plan-card" @submit.prevent="savePlan(plan)">
            <div class="panel-head"><div><span class="eyebrow">{{ plan.isDefault ? 'DEFAULT' : plan.active ? 'ACTIVE' : 'INACTIVE' }}</span><h3>{{ plan.name || 'New plan' }}</h3></div><code>{{ plan.id || 'new' }}</code></div>
            <div class="panel-body form-grid">
              <label>PLAN ID<input v-model="plan.id" :disabled="!plan.isNew" required pattern="[a-z0-9][a-z0-9_-]{0,31}"></label>
              <label>DISPLAY NAME<input v-model="plan.name" required maxlength="80"></label>
              <label class="wide">DESCRIPTION<input v-model="plan.description" maxlength="240" placeholder="Benefits shown to users"></label>
              <label>STORAGE MB<input v-model.number="plan.storageMb" type="number" min="0" step="1" required><small>Use 0 for unlimited.</small></label>
              <label>NAMED COLLABORATORS<input v-model.number="plan.collaboratorLimit" type="number" min="0" step="1" required><small>Distinct recipients across the owner's notes; 0 is unlimited.</small></label>
              <label>PRICE LABEL<input v-model="plan.priceLabel" placeholder="€5 / year"></label>
              <label>TERM IN DAYS<input v-model.number="plan.durationDays" type="number" min="1" step="1" placeholder="Permanent"></label>
              <label>SORT ORDER<input v-model.number="plan.sortOrder" type="number" step="1"></label>
              <label class="wide">CHECKOUT URL<input v-model="plan.checkoutUrl" type="url" placeholder="https://buy.stripe.com/..."></label>
              <label class="wide">STRIPE PAYMENT LINK ID<input v-model="plan.stripePaymentLinkId" placeholder="plink_..."><small>Or set Payment Link metadata <code>plan_id={{ plan.id || 'your_plan' }}</code>.</small></label>
              <label class="check"><input v-model="plan.active" type="checkbox"> Offered publicly</label>
              <label class="check"><input v-model="plan.isDefault" type="checkbox"> Default / fallback plan</label>
            </div>
            <div class="card-actions"><button type="submit" class="button primary">[save plan]</button><button v-if="!plan.isNew" type="button" class="button danger" @click="deletePlan(plan)">[delete]</button><button v-else type="button" class="button" @click="cancelNewPlan(plan)">[cancel]</button></div>
          </form>
        </div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
definePageMeta({ layout: false });

interface Plan { id: string; name: string; description: string | null; quotaBytes: number; collaboratorLimit: number; priceLabel: string | null; durationDays: number | null; checkoutUrl: string | null; stripePaymentLinkId: string | null; active: boolean; isDefault: boolean; sortOrder: number; isNew?: boolean }
interface EditablePlan extends Plan { storageMb: number }
interface AdminUser { uid: string; displayName: string | null; createdAt: string; lastSeenAt: string | null; plan: string; planExpiresAt: string | null; noteCount: number; storage: { totalBytes: number } }
interface Stats { users: number; notes: number; storage: { totalDataBytes: number }; expiry: { staleOver1Year: number } }

const config = useRuntimeConfig();
const secret = ref('');
const authenticated = ref(false);
const loading = ref(false);
const error = ref('');
const notice = ref('');
const users = ref<AdminUser[]>([]);
const plans = ref<Plan[]>([]);
const editablePlans = ref<EditablePlan[]>([]);
const stats = ref<Stats | null>(null);
const newCredentials = ref<{ uid: string; apiKey: string } | null>(null);

async function adminFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.public.apiUrl}/api/v1/admin${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.value}`, ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

async function connect() {
  loading.value = true; error.value = '';
  try { await loadAll(); sessionStorage.setItem('notecolab-admin-secret', secret.value); authenticated.value = true; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not connect'; }
  finally { loading.value = false; }
}

async function loadAll() {
  loading.value = true; error.value = '';
  try {
    const [statsResult, usersResult, plansResult] = await Promise.all([
      adminFetch<Stats>('/stats'), adminFetch<{ users: AdminUser[] }>('/users'), adminFetch<{ plans: Plan[] }>('/plans'),
    ]);
    stats.value = statsResult; users.value = usersResult.users; plans.value = plansResult.plans;
    editablePlans.value = plansResult.plans.map((plan) => ({ ...plan, storageMb: plan.quotaBytes / (1024 * 1024) }));
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not load admin data'; throw cause; }
  finally { loading.value = false; }
}

function disconnect() { sessionStorage.removeItem('notecolab-admin-secret'); secret.value = ''; authenticated.value = false; }
function flash(message: string) { notice.value = message; error.value = ''; window.setTimeout(() => { notice.value = ''; }, 4000); }
function formatMb(bytes?: number) { if (bytes === undefined) return '—'; const mb = bytes / (1024 * 1024); return `${mb < 10 && mb !== 0 ? mb.toFixed(2) : mb.toFixed(1)} MB`; }
function formatDate(value: string) { return new Date(value).toLocaleDateString(); }
function formatDateTime(value: string) { return new Date(value.endsWith('Z') ? value : `${value}Z`).toLocaleString(); }
function usageWidth(user: AdminUser) { const plan = plans.value.find((item) => item.id === user.plan); if (!plan || plan.quotaBytes <= 0) return '0%'; return `${Math.min(100, user.storage.totalBytes / plan.quotaBytes * 100)}%`; }

async function provisionUser() { try { newCredentials.value = await adminFetch('/users', { method: 'POST', body: '{}' }); await loadAll(); flash('User provisioned. Save the credentials now.'); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Provisioning failed'; } }
async function copyCredentials() { if (!newCredentials.value) return; await navigator.clipboard.writeText(`UID: ${newCredentials.value.uid}\nAPI key: ${newCredentials.value.apiKey}`); flash('Credentials copied.'); }
async function saveUserPlan(user: AdminUser) { try { const plan = plans.value.find((item) => item.id === user.plan); await adminFetch(`/users/${encodeURIComponent(user.uid)}/plan`, { method: 'POST', body: JSON.stringify({ plan: user.plan, durationDays: plan?.durationDays ?? null }) }); await loadAll(); flash(`Updated ${user.uid}.`); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Update failed'; } }
async function deleteUser(user: AdminUser) { if (!confirm(`Delete ${user.displayName || user.uid} and all owned data? This cannot be undone.`)) return; try { await adminFetch(`/users/${encodeURIComponent(user.uid)}`, { method: 'DELETE' }); await loadAll(); flash('User and owned data deleted.'); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Delete failed'; } }

function startNewPlan() { if (editablePlans.value.some((plan) => plan.isNew)) return; editablePlans.value.push({ id: '', name: '', description: null, quotaBytes: 0, collaboratorLimit: 0, storageMb: 0, priceLabel: null, durationDays: null, checkoutUrl: null, stripePaymentLinkId: null, active: true, isDefault: false, sortOrder: (plans.value.at(-1)?.sortOrder ?? 0) + 10, isNew: true }); }
function cancelNewPlan(plan: EditablePlan) { editablePlans.value = editablePlans.value.filter((item) => item !== plan); }
async function savePlan(plan: EditablePlan) { try { const method = plan.isNew ? 'POST' : 'PUT'; const path = plan.isNew ? '/plans' : `/plans/${encodeURIComponent(plan.id)}`; const { isNew: _isNew, storageMb, ...fields } = plan; const payload = { ...fields, quotaBytes: Math.round(storageMb * 1024 * 1024), priceLabel: plan.priceLabel || null, durationDays: plan.durationDays || null, checkoutUrl: plan.checkoutUrl || null, stripePaymentLinkId: plan.stripePaymentLinkId || null }; await adminFetch(path, { method, body: JSON.stringify(payload) }); await loadAll(); flash(`Saved ${plan.name}.`); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Save failed'; } }
async function deletePlan(plan: Plan) { if (!confirm(`Delete plan ${plan.name}?`)) return; try { await adminFetch(`/plans/${encodeURIComponent(plan.id)}`, { method: 'DELETE' }); await loadAll(); flash(`Deleted ${plan.name}.`); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Delete failed'; } }

onMounted(async () => { secret.value = sessionStorage.getItem('notecolab-admin-secret') || ''; if (secret.value) { try { await loadAll(); authenticated.value = true; } catch { sessionStorage.removeItem('notecolab-admin-secret'); } } });
</script>

<style scoped>
.pw-admin { height: 100vh; min-height: 0; overflow-y: auto; color-scheme: light; background: var(--pw-canvas); color: var(--pw-ink); font: 14px/1.5 ui-monospace, "SFMono-Regular", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace; }
* { box-sizing: border-box; }
.topbar { border-bottom: 1px solid var(--pw-ink); }
.topbar-inner, .container { width: min(1320px, calc(100% - 48px)); margin: 0 auto; }
.topbar-inner { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.wordmark { color: var(--pw-ink); text-decoration: none; font-weight: 750; letter-spacing: .04em; }
.system-state { color: var(--pw-secondary); font-size: 12px; text-transform: uppercase; }
.status-square { display: inline-block; width: 9px; height: 9px; background: var(--pw-muted); margin-right: 6px; }
.status-square.online { background: var(--pw-accent); }
.container { padding: 48px 0 80px; }
.auth-wrap { min-height: calc(100vh - 65px); display: grid; place-items: center; padding: 24px; }
.auth-panel { width: min(480px, 100%); }
.page-intro, .section-heading { display: flex; justify-content: space-between; align-items: end; gap: 24px; }
.page-intro { margin-bottom: 32px; }
h1, h2, h3, p { margin: 0; }
h1 { font-size: clamp(28px, 4vw, 40px); line-height: 1.1; margin-top: 5px; }
h2 { font-size: 20px; margin-top: 4px; }
h3 { font-size: 17px; margin-top: 4px; }
.page-intro p, .section-heading p { color: var(--pw-secondary); margin-top: 8px; }
.eyebrow, label, .metrics span, .credentials span { color: var(--pw-secondary); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.actions, .row-actions, .card-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.button { min-height: 44px; border: 1px solid var(--pw-ink); border-radius: 0; background: var(--pw-canvas); color: var(--pw-ink); padding: 9px 14px; font: inherit; cursor: pointer; }
.button:hover { background: var(--pw-wash); }
.button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--pw-ink); outline-offset: 2px; }
.button.primary { background: var(--pw-ink); color: var(--pw-canvas); }
.button.primary:hover { background: var(--pw-accent); border-color: var(--pw-accent); }
.button.danger { color: var(--pw-critical); border-color: var(--pw-critical); }
.button.compact { min-height: 36px; padding: 6px 9px; font-size: 12px; }
.button:disabled { opacity: .42; cursor: wait; }
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--pw-ink); }
.metrics article { padding: 20px; border-right: 1px solid var(--pw-rule); }
.metrics article:last-child { border: 0; }
.metrics strong { display: block; margin-top: 10px; font-size: 24px; font-variant-numeric: tabular-nums; }
.section-block { margin-top: 64px; }
.section-heading { margin-bottom: 20px; }
.panel { border: 1px solid var(--pw-ink); }
.panel-head { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--pw-ink); }
.panel-body { padding: 22px; }
.message { padding: 12px 16px; margin: 16px 0; border: 1px solid; }
.message.critical { color: var(--pw-critical); background: var(--pw-critical-wash); border-color: var(--pw-critical); }
.message.positive { color: var(--pw-accent); background: var(--pw-accent-wash); border-color: var(--pw-accent); }
.auth-form { display: grid; gap: 14px; }
input, select { width: 100%; min-height: 44px; border: 1px solid var(--pw-ink); border-radius: 0; background: var(--pw-canvas); color: var(--pw-ink); padding: 9px 10px; font: inherit; }
input[type="checkbox"] { width: 18px; min-height: 18px; height: 18px; accent-color: var(--pw-ink); }
.help, small { display: block; color: var(--pw-secondary); font-size: 12px; text-transform: none; letter-spacing: 0; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; min-width: 980px; }
th { padding: 12px 14px; color: var(--pw-secondary); font-size: 11px; letter-spacing: .08em; text-align: left; border-bottom: 1px solid var(--pw-ink); }
td { padding: 14px; border-bottom: 1px solid var(--pw-rule); vertical-align: middle; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: var(--pw-wash); }
tbody tr:last-child td { border-bottom: 0; }
td code { display: block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; color: var(--pw-secondary); font-size: 11px; }
td select { min-width: 130px; min-height: 36px; padding: 6px 8px; }
.numeric { text-align: right; }
.usage { width: 120px; height: 6px; background: var(--pw-track); margin-top: 6px; }
.usage i { display: block; height: 100%; background: var(--pw-accent); }
.empty { padding: 40px; color: var(--pw-secondary); text-align: center; }
.credentials { border: 2px solid var(--pw-accent); background: var(--pw-accent-wash); padding: 18px; margin-bottom: 20px; display: grid; gap: 10px; }
.credentials code { display: block; overflow-wrap: anywhere; margin-top: 3px; }
.plan-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.plan-card { display: flex; flex-direction: column; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; flex: 1; }
.form-grid label { display: block; }
.form-grid input { margin-top: 6px; }
.form-grid .wide { grid-column: 1 / -1; }
.form-grid .check { display: flex; align-items: center; gap: 10px; min-height: 44px; color: var(--pw-ink); }
.form-grid .check input { margin: 0; }
.card-actions { padding: 0 22px 22px; }
@media (max-width: 820px) { .metrics, .plan-grid { grid-template-columns: 1fr 1fr; } .metrics article:nth-child(2) { border-right: 0; } .metrics article:nth-child(-n+2) { border-bottom: 1px solid var(--pw-rule); } .page-intro, .section-heading { align-items: flex-start; flex-direction: column; } }
@media (max-width: 700px) { table { min-width: 0; } thead { display: none; } tbody, tr, td { display: block; width: 100%; } tbody tr { padding: 10px 14px; border-bottom: 1px solid var(--pw-ink); } tbody tr:last-child { border-bottom: 0; } td { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--pw-rule); text-align: left !important; } td::before { content: attr(data-label); color: var(--pw-secondary); font-size: 11px; letter-spacing: .08em; } td:last-child { border-bottom: 0; } td code { max-width: 100%; } td select, .usage { width: 100%; } .empty { display: block; } .empty::before { content: none; } }
@media (max-width: 560px) { .topbar-inner, .container { width: min(100% - 24px, 1320px); } .container { padding-top: 32px; } .metrics, .plan-grid, .form-grid { grid-template-columns: 1fr; } .metrics article { border-right: 0; border-bottom: 1px solid var(--pw-rule); } .metrics article:nth-child(3) { border-bottom: 1px solid var(--pw-rule); } .form-grid .wide { grid-column: auto; } .topbar-inner { align-items: flex-start; flex-direction: column; justify-content: center; padding: 12px 0; } }
</style>

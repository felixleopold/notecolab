<template>
  <div class="marketing-scroll">
    <section class="marketing-page-hero"><div class="marketing-container marketing-narrow"><p class="marketing-kicker">Status</p><h1>Current service health.</h1><p class="marketing-lede">{{ statusIntroduction }}</p></div></section>
    <div class="marketing-container marketing-narrow marketing-page-content">
      <div class="marketing-status-card">
        <span :class="['marketing-status-indicator', statusClass]" aria-hidden="true" />
        <div>
          <h2>{{ statusHeading }}</h2>
          <p>{{ statusDetail }}</p>
          <button class="marketing-button" style="margin-top: 20px" :disabled="pending" @click="refresh">{{ pending ? 'Checking…' : 'Check again' }}</button>
        </div>
      </div>
      <section v-if="officialHostedService" class="prose-section"><h2>Recent scheduled checks</h2><p v-if="!history">Historical observations are not available yet. No uptime percentage is inferred.</p><template v-else><p>Last observation: {{ new Date(history.updatedAt).toLocaleString() }}. {{ historyStale ? 'These observations are stale.' : 'Checks are scheduled every 10 minutes.' }}</p><p>{{ healthyChecks }} of {{ history.observations.length }} recorded checks found both the website and API healthy over the available history (up to 30 days).</p><p>Scheduled jobs can run late or be missed. Missing periods are unknown, not successful checks. These observations do not measure continuous uptime or verify note synchronization.</p></template><p><a href="https://github.com/felixleopold/notecolab/actions/workflows/uptime.yml">Inspect public checks</a> · <a href="https://raw.githubusercontent.com/felixleopold/notecolab/status/history.json">Download observations</a></p></section>
      <section v-else class="prose-section"><h2>Historical checks</h2><p>This server does not publish uptime history through Note Colab. The official hosted-service observations describe notecolab.com only, so they are not shown here.</p></section>
      <section class="prose-section"><h2>What this page reports</h2><p>This is a current readiness check, not a historical uptime report or availability guarantee. A healthy result means the public API process can answer and access its database at the moment of the check. It does not test every sharing, browser, billing, or WebSocket path.</p><p>If a share is not working while this check is healthy, see the <NuxtLink to="/help">troubleshooting guide</NuxtLink> or report the problem on <a href="https://github.com/felixleopold/notecolab/issues">GitHub</a>.</p></section>
    </div>
    <MarketingFooter />
  </div>
</template>

<script setup lang="ts">
interface ReadinessResponse { status: 'ok' | 'unavailable' }

interface StatusHistory { updatedAt: string; observations: { at: string; checks: { service: string; ok: boolean }[] }[] }
const history = ref<StatusHistory | null>(null)
const historyStale = computed(() => !history.value || Date.now() - Date.parse(history.value.updatedAt) > 30 * 60 * 1000)
const healthyChecks = computed(() => history.value?.observations.filter((entry) => entry.checks.length === 2 && entry.checks.every((check) => check.ok)).length ?? 0)
const config = useRuntimeConfig()
const pending = ref(true)
const readiness = ref<ReadinessResponse | null>(null)
const requestFailed = ref(false)
const officialHostedService = (() => {
  try {
    return new URL(config.public.apiUrl).origin === 'https://notecolab.com'
  } catch {
    return false
  }
})()
const serviceName = officialHostedService ? 'Hosted service' : 'This server'
const statusIntroduction = officialHostedService
  ? 'Current readiness and public scheduled observations for the hosted service.'
  : 'Current readiness for this Note Colab server.'

const statusClass = computed(() => readiness.value?.status === 'ok' ? 'ok' : requestFailed.value || readiness.value?.status === 'unavailable' ? 'error' : '')
const statusHeading = computed(() => pending.value ? `Checking ${serviceName.toLowerCase()}…` : readiness.value?.status === 'ok' ? `${serviceName} is ready` : `${serviceName} is not ready`)
const statusDetail = computed(() => pending.value
  ? 'Requesting the current readiness state.'
  : readiness.value?.status === 'ok'
    ? 'The API is responding and its database readiness check passed.'
    : 'The readiness check failed or could not be reached. Try again in a moment.')

async function refresh() {
  pending.value = true
  requestFailed.value = false
  try {
    readiness.value = await $fetch<ReadinessResponse>(`${config.public.apiUrl}/api/v1/ready`)
  } catch {
    readiness.value = null
    requestFailed.value = true
  } finally {
    pending.value = false
  }
}

onMounted(async () => {
  await refresh()
  if (!officialHostedService) return
  try {
    const response = await $fetch<StatusHistory>('https://raw.githubusercontent.com/felixleopold/notecolab/status/history.json', { timeout: 10000 })
    if (Array.isArray(response.observations) && Number.isFinite(Date.parse(response.updatedAt))) history.value = response
  } catch { /* Unpublished or unavailable history stays explicitly unknown. */ }
})
useHead({ title: 'Status | Note Colab', meta: [{ name: 'description', content: 'Current readiness of this Note Colab service.' }] })
</script>

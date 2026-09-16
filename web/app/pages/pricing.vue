<template>
  <div class="marketing-scroll">
    <section class="marketing-page-hero"><div class="marketing-container marketing-narrow"><p class="marketing-kicker">Pricing</p><h1>Space for your notes and your people.</h1><p class="marketing-lede">Small notes. Small prices. Start free, then pay yearly for the space you need.</p></div></section>
    <div class="marketing-container marketing-page-content">
      <div v-if="pending" class="marketing-status-card"><span class="marketing-status-indicator" /><div><h2>Loading plans…</h2><p>Checking available plans.</p></div></div>
      <div v-else-if="error || !planInfo" class="marketing-status-card"><span class="marketing-status-indicator error" /><div><h2>Plans are temporarily unavailable</h2><p>The plan configuration could not be loaded. Check again later or view plan information inside the Note Colab plugin.</p></div></div>
      <template v-else>
        <div class="marketing-plan-grid">
          <article v-for="plan in plans" :key="plan.id" class="marketing-plan-card">
            <h2>{{ plan.name }}</h2>
            <p class="marketing-plan-description">{{ plan.description || (plan.isDefault ? 'For trying note sharing with a small group.' : 'More room for your shared notes and images.') }}</p>
            <p class="marketing-plan-price">{{ plan.priceLabel || (plan.isDefault ? '€0' : 'Price not available') }}</p>
            <p class="marketing-plan-period">{{ plan.isDefault ? 'No payment required' : plan.durationDays === 365 ? 'One yearly payment. No per-person fee.' : plan.durationDays ? `${plan.durationDays} days per paid period` : 'See checkout for the paid period' }}</p>
            <NuxtLink v-if="plan.checkoutAvailable" to="/dashboard" class="marketing-button marketing-button-primary">Choose {{ plan.name }}</NuxtLink>
            <a v-else-if="plan.isDefault" :href="installUrl" class="marketing-button">Start free</a>
            <span v-else class="marketing-button plan-unavailable">Upgrades not currently available</span>
            <ul class="marketing-plan-features">
              <li><strong>{{ formatStorage(plan.quotaBytes) }}</strong> for notes and images</li>
              <li v-if="plan.collaboratorLimit !== undefined"><strong>{{ collaboratorLabel(plan.collaboratorLimit) }}</strong> across your notes</li>
              <li>Public reading links</li>
              <li>Live editing and collaborator cursors</li>
              <li>Folder sharing and browser access</li>
              <li>Your Markdown stays in Obsidian</li>
            </ul>
          </article>
        </div>
        <details class="marketing-comparison">
          <summary>Compare the allowances</summary>
          <div class="marketing-table-scroll">
            <table class="data-table">
              <thead><tr><th scope="col">Included</th><th v-for="plan in plans" :key="plan.id" scope="col">{{ plan.name }}</th></tr></thead>
              <tbody>
                <tr><th scope="row">Storage</th><td v-for="plan in plans" :key="plan.id">{{ formatStorage(plan.quotaBytes) }}</td></tr>
                <tr><th scope="row">Named collaborators</th><td v-for="plan in plans" :key="plan.id">{{ plan.collaboratorLimit === undefined ? 'See your account' : plan.collaboratorLimit === 0 ? 'Unlimited' : plan.collaboratorLimit }}</td></tr>
                <tr><th scope="row">Public link visitors</th><td v-for="plan in plans" :key="plan.id">No collaborator seats needed</td></tr>
                <tr><th scope="row">Sharing and collaboration</th><td v-for="plan in plans" :key="plan.id">Included</td></tr>
              </tbody>
            </table>
          </div>
        </details>
      </template>
      <section class="prose-section marketing-narrow"><h2>How upgrades work</h2><p>Only the owner needs an upgraded plan. People you invite can collaborate without purchasing their own subscription. Paid checkout is available only when an upgrade button is shown. Self-hosted servers can use different limits.</p><p>Storage includes encrypted note content, collaboration checkpoints, retained recovery versions, supported images, and stored key material. Going over a limit blocks growth but does not automatically delete existing data.</p><p>See the <NuxtLink to="/terms">proposed hosting and retirement policy</NuxtLink> for paid periods, notice, and export windows. That proposal does not change existing paid commitments. Checkout availability and current allowances are shown above.</p></section>
    </div>
    <MarketingFooter />
  </div>
</template>

<script setup lang="ts">
interface PublicPlan {
  id: string
  name: string
  description: string | null
  quotaBytes: number
  collaboratorLimit?: number
  priceLabel: string | null
  durationDays: number | null
  checkoutAvailable: boolean
  isDefault: boolean
}

interface PlanInfo { plans: Record<string, PublicPlan> }

const config = useRuntimeConfig()
const installUrl = 'obsidian://show-plugin?id=notecolab'
const { data: planInfo, pending, error } = await useFetch<PlanInfo>(`${config.public.apiUrl}/api/v1/info`, { key: 'public-plan-info' })
const plans = computed(() => Object.values(planInfo.value?.plans || {}))

function collaboratorLabel(limit: number): string {
  return limit <= 0 ? 'Unlimited named collaborators' : `${limit} named collaborators`
}

function formatStorage(bytes: number): string {
  if (bytes <= 0) return 'Unlimited storage'
  const mib = bytes / 1024 / 1024
  if (mib >= 1024) return `${Number((mib / 1024).toFixed(1))} GiB storage`
  return `${Number(mib.toFixed(1))} MiB storage`
}

useHead({ title: 'Pricing | Note Colab', meta: [{ name: 'description', content: 'Current Note Colab plans and checkout availability, loaded from the hosted server.' }] })
</script>

<template>
  <div :class="['h-screen flex flex-col overflow-hidden', { 'marketing-shell': marketingPage }]">
    <header v-if="marketingPage" class="marketing-header">
      <div class="marketing-nav">
        <NuxtLink to="/" class="marketing-brand" aria-label="Note Colab home">
          <span class="marketing-brand-mark" aria-hidden="true">N</span>
          <span>Note Colab</span>
        </NuxtLink>
        <nav class="marketing-nav-links" aria-label="Primary navigation">
          <NuxtLink to="/help">Help</NuxtLink>
          <NuxtLink to="/security">Security</NuxtLink>
          <NuxtLink to="/pricing">Pricing</NuxtLink>
          <NuxtLink to="/status">Status</NuxtLink>
        </nav>
        <div class="marketing-nav-actions">
          <ClientOnly>
            <NuxtLink v-if="loggedIn" to="/dashboard" class="marketing-button marketing-button-quiet">Dashboard</NuxtLink>
            <NuxtLink v-else to="/login" class="marketing-button marketing-button-quiet">Sign in</NuxtLink>
          </ClientOnly>
          <a :href="installUrl" class="marketing-button marketing-button-primary">Install in Obsidian</a>
        </div>
      </div>
    </header>

    <header v-else class="border-b backdrop-blur-sm sticky top-0 z-50" style="background-color: var(--nc-header-bg); border-color: var(--nc-border);">
      <div class="px-4 py-2.5 flex items-center justify-between">
        <NuxtLink to="/" class="flex items-center gap-2.5 text-base font-semibold hover:text-obsidian-accent transition-colors group">
          <div class="w-7 h-7 rounded-lg bg-obsidian-accent/10 border border-obsidian-accent/20 flex items-center justify-center group-hover:bg-obsidian-accent/20 transition-colors">
            <svg class="w-4 h-4 text-obsidian-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>
          </div>
          <span>Note<span class="text-obsidian-accent">Colab</span></span>
        </NuxtLink>
        <div class="flex items-center gap-3">
          <ClientOnly>
            <NuxtLink v-if="loggedIn" to="/dashboard" class="nc-headerlink transition-colors text-sm font-medium">Dashboard</NuxtLink>
            <NuxtLink v-else to="/login" class="nc-headerlink transition-colors text-sm font-medium">Login</NuxtLink>
          </ClientOnly>
          <a href="https://github.com/felixleopold/notecolab" class="nc-headerlink transition-colors p-1.5" title="GitHub" aria-label="Note Colab on GitHub">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
          </a>
        </div>
      </div>
    </header>
    <main class="flex-1 min-h-0 flex flex-col overflow-hidden"><slot /></main>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const { isLoggedIn } = useApi()
const loggedIn = ref(false)
const marketingPaths = new Set(['/', '/help', '/security', '/privacy', '/status', '/pricing', '/terms'])
const marketingPage = computed(() => marketingPaths.has(route.path))
const installUrl = 'obsidian://show-plugin?id=notecolab'

onMounted(() => { loggedIn.value = isLoggedIn() })
</script>

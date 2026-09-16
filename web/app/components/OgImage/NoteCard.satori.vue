<script setup lang="ts">
// OG preview card for a shared note (1200x630). Rendered server-side by
// nuxt-og-image via satori (+ resvg-wasm). Satori only understands a subset of
// CSS: use flexbox only, and give EVERY element with >1 child an explicit
// `display: flex`.
//
// URL fragments are unavailable to crawlers, so encrypted-title notes render
// with a generic server-side preview title.
const props = withDefaults(defineProps<{
  title?: string
  description?: string
  accessLabel?: string
}>(), {
  title: 'Open to decrypt',
  description: 'Open it in NoteColab to edit and collaborate.',
  accessLabel: 'Collaborative note',
})

// satori has no line-clamp here, so cap the title length ourselves to keep the
// layout from overflowing the card.
const displayTitle = computed(() => {
  const t = (props.title || 'Open to decrypt').trim() || 'Open to decrypt'
  return t.length > 120 ? `${t.slice(0, 119)}…` : t
})
</script>

<template>
  <div
    :style="{
      width: '1200px',
      height: '630px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: '80px',
      backgroundColor: '#1e1e1e',
      backgroundImage:
        'radial-gradient(circle at 12% 8%, rgba(127, 109, 242, 0.28), transparent 45%)',
      fontFamily: 'Inter, sans-serif',
      color: '#e8e9ea',
    }"
  >
    <!-- Context row -->
    <div :style="{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }">
      <div :style="{ display: 'flex', alignItems: 'center' }">
      <svg width="56" height="56" viewBox="0 0 24 24">
        <path
          d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
          stroke="#7f6df2"
          stroke-width="2"
          fill="none"
        />
      </svg>
      <span
        :style="{
          marginLeft: '20px',
          fontSize: '34px',
          fontWeight: 700,
          color: '#ffffff',
        }"
      >NoteColab</span>
      </div>
      <span
        :style="{
          padding: '12px 20px',
          border: '2px solid rgba(196, 181, 253, 0.35)',
          borderRadius: '999px',
          color: '#c4b5fd',
          fontSize: '24px',
          fontWeight: 600,
        }"
      >{{ accessLabel }}</span>
    </div>

    <!-- Title -->
    <div
      :style="{
        display: 'flex',
        fontSize: '76px',
        fontWeight: 800,
        lineHeight: 1.12,
        letterSpacing: '-0.02em',
        color: '#ffffff',
      }"
    >{{ displayTitle }}</div>

    <!-- Recipient guidance -->
    <div :style="{ display: 'flex', alignItems: 'center' }">
      <div
        :style="{
          display: 'flex',
          width: '40px',
          height: '6px',
          borderRadius: '3px',
          backgroundColor: '#7f6df2',
        }"
      />
      <span
        :style="{
          marginLeft: '20px',
          fontSize: '28px',
          fontWeight: 500,
          color: '#9aa0a6',
        }"
      >{{ description }}</span>
    </div>
  </div>
</template>

<template>
  <section v-if="manifest" class="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8">
    <header class="mb-8">
      <p class="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-violet-400">Shared folder</p>
      <h1 class="text-3xl font-semibold tracking-tight" style="color: var(--nc-text);">{{ manifest.name }}</h1>
      <p class="mt-2 text-sm" style="color: var(--nc-muted);">
        {{ manifest.entries.length }} encrypted Markdown {{ manifest.entries.length === 1 ? 'file' : 'files' }}
      </p>
    </header>

    <div class="overflow-hidden rounded-2xl border" style="border-color: var(--nc-border); background: var(--nc-surface);">
      <div
        v-for="row in rows"
        :key="`${row.kind}:${row.path}`"
        class="flex min-h-11 items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
        style="border-color: var(--nc-border);"
        :style="{ paddingLeft: `${16 + row.depth * 22}px` }"
      >
        <svg v-if="row.kind === 'folder'" class="h-4 w-4 shrink-0 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M3 7.5A1.5 1.5 0 0 1 4.5 6h5l2 2h8A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-10Z" />
        </svg>
        <svg v-else class="h-4 w-4 shrink-0" style="color: var(--nc-muted);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M7 3h7l4 4v14H7V3Zm7 0v5h4" />
        </svg>
        <span v-if="row.kind === 'folder'" class="text-sm font-medium" style="color: var(--nc-text);">{{ row.label }}</span>
        <a
          v-else
          :href="row.shareUrl"
          class="min-w-0 flex-1 truncate text-sm font-medium text-violet-400 hover:text-violet-300 hover:underline"
          rel="noreferrer"
        >
          {{ row.label }}
        </a>
      </div>
    </div>

    <p class="mt-5 text-xs leading-5" style="color: var(--nc-muted);">
      File links include their decryption keys in the URL fragment. Keep this folder link private.
    </p>
  </section>
</template>

<script setup lang="ts">
import type { FolderManifest } from '~/utils/folderManifest'

interface TreeRow {
  kind: 'folder' | 'file'
  path: string
  label: string
  depth: number
  shareUrl?: string
}

const props = defineProps<{ manifest: FolderManifest }>()
const manifest = computed(() => props.manifest)

const rows = computed<TreeRow[]>(() => {
  const result: TreeRow[] = []
  const folders = new Set<string>()
  for (const entry of [...props.manifest.entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = entry.path.split('/')
    for (let index = 0; index < parts.length - 1; index++) {
      const path = parts.slice(0, index + 1).join('/')
      if (folders.has(path)) continue
      folders.add(path)
      result.push({ kind: 'folder', path, label: parts[index]!, depth: index })
    }
    result.push({
      kind: 'file',
      path: entry.path,
      label: parts[parts.length - 1]!.replace(/\.md$/i, ''),
      depth: parts.length - 1,
      shareUrl: entry.shareUrl,
    })
  }
  return result
})
</script>

<template>
  <button
    v-if="roster"
    type="button"
    class="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md flex-shrink-0"
    style="background: var(--nc-bg); color: var(--nc-muted);"
    title="People with this note in the foreground"
    aria-haspopup="dialog"
    @click="dialog?.showModal()"
  >
    <svg aria-hidden="true" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
    {{ presenceLabel(roster) }}
  </button>
  <span v-else-if="connectionStatus" class="text-xs flex-shrink-0" style="color: var(--nc-muted);">
    {{ connectionStatus === 'connected' ? 'Presence unavailable' : 'Reconnecting…' }}
  </span>
  <dialog
    ref="dialog"
    class="presence-dialog rounded-xl p-5 w-80 max-w-[calc(100vw-2rem)]"
    style="background: var(--nc-bg); color: var(--nc-text); border: 1px solid var(--nc-border);"
    aria-label="People here now"
    @click="onDialogClick"
  >
    <div class="flex justify-between items-center gap-3 mb-3">
      <h2 class="font-semibold">Here now</h2>
      <button type="button" class="text-sm px-2 py-1 rounded" @click="dialog?.close()">Close</button>
    </div>
    <ul class="space-y-2 text-sm">
      <li v-for="participant in roster?.participants" :key="participant.id" class="flex justify-between gap-3">
        <span class="break-words min-w-0">{{ participant.id === roster?.selfId ? 'You' : participant.name }}</span>
        <span class="shrink-0" style="color: var(--nc-muted);">{{ participant.client === 'obsidian' ? 'Obsidian' : 'Web' }}</span>
      </li>
    </ul>
    <p v-if="!roster?.participants.length" class="text-sm">No one has this note in the foreground.</p>
    <p class="text-xs mt-4" style="color: var(--nc-muted);">People with this note in the foreground. Older clients may not report presence.</p>
  </dialog>
</template>

<script setup lang="ts">
import { presenceLabel, type PresenceRoster } from '~/utils/presence'

const props = defineProps<{
  roster: PresenceRoster | null
  connectionStatus?: 'connected' | 'syncing' | 'disconnected' | null
}>()
const dialog = ref<HTMLDialogElement | null>(null)
watch(() => props.roster, (roster) => {
  if (!roster) dialog.value?.close()
})
function onDialogClick(event: MouseEvent) {
  if (event.target === dialog.value) dialog.value?.close()
}
</script>

<style scoped>
.presence-dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
</style>

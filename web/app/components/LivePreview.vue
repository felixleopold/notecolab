<template>
  <div
    ref="container"
    class="live-preview-container"
    tabindex="0"
    @keydown="onKeydown"
  >
    <div
      v-for="(line, idx) in lines"
      :key="idx"
      class="live-line cursor-text"
      :class="{ 'live-line-active': idx === activeLine }"
      @click="setActiveLine(idx)"
    >
      <!-- Active line: show raw markdown source -->
      <div v-if="idx === activeLine && !readOnly" class="line-source">
        <input
          ref="lineInputs"
          type="text"
          :value="line"
          class="w-full bg-transparent outline-none text-obsidian-text"
          :style="{ fontFamily: 'JetBrains Mono, Fira Code, ui-monospace, SFMono-Regular, monospace', fontSize: '0.95em' }"
          @input="onLineInput(idx, ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="insertNewLine(idx)"
          @keydown.backspace="onBackspace(idx, $event)"
          @keydown.up.prevent="moveUp"
          @keydown.down.prevent="moveDown"
        />
      </div>
      <!-- Inactive lines: show rendered markdown -->
      <div v-else class="line-rendered" v-html="renderLine(line)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import MarkdownIt from 'markdown-it'

const props = defineProps<{
  content: string
  readOnly?: boolean
}>()

const emit = defineEmits<{
  'update:content': [content: string]
}>()

const container = ref<HTMLElement>()
const lineInputs = ref<HTMLInputElement[]>([])
const activeLine = ref<number | null>(null)

const md = new MarkdownIt({ html: true, linkify: true, typographer: true })

const lines = computed(() => props.content.split('\n'))

function renderLine(line: string): string {
  if (!line.trim()) return '<br>'
  // Render single line as inline markdown
  let rendered = md.render(line)
  // Remove wrapping <p> tags for inline feel
  rendered = rendered.replace(/^<p>([\s\S]*)<\/p>\s*$/, '$1')
  return rendered
}

function setActiveLine(idx: number) {
  if (props.readOnly) return
  activeLine.value = idx
  nextTick(() => {
    const inputs = lineInputs.value
    if (inputs && inputs[0]) {
      inputs[0].focus()
      // Place cursor at end
      const len = inputs[0].value.length
      inputs[0].setSelectionRange(len, len)
    }
  })
}

function onLineInput(idx: number, value: string) {
  const newLines = [...lines.value]
  newLines[idx] = value
  emit('update:content', newLines.join('\n'))
}

function insertNewLine(idx: number) {
  const input = lineInputs.value?.[0]
  const cursorPos = input?.selectionStart ?? lines.value[idx]!.length
  const currentLine = lines.value[idx]!
  const before = currentLine.slice(0, cursorPos)
  const after = currentLine.slice(cursorPos)

  const newLines = [...lines.value]
  newLines[idx] = before
  newLines.splice(idx + 1, 0, after)
  emit('update:content', newLines.join('\n'))
  nextTick(() => setActiveLine(idx + 1))
}

function onBackspace(idx: number, event: KeyboardEvent) {
  const input = lineInputs.value?.[0]
  if (input && input.selectionStart === 0 && input.selectionEnd === 0 && idx > 0) {
    event.preventDefault()
    const prevLine = lines.value[idx - 1]!
    const currentLine = lines.value[idx]!
    const newLines = [...lines.value]
    newLines[idx - 1] = prevLine + currentLine
    newLines.splice(idx, 1)
    emit('update:content', newLines.join('\n'))
    nextTick(() => {
      activeLine.value = idx - 1
      nextTick(() => {
        const inputs = lineInputs.value
        if (inputs && inputs[0]) {
          inputs[0].focus()
          inputs[0].setSelectionRange(prevLine.length, prevLine.length)
        }
      })
    })
  }
}

function moveUp() {
  if (activeLine.value !== null && activeLine.value > 0) {
    setActiveLine(activeLine.value - 1)
  }
}

function moveDown() {
  if (activeLine.value !== null && activeLine.value < lines.value.length - 1) {
    setActiveLine(activeLine.value + 1)
  }
}

function onKeydown(e: KeyboardEvent) {
  // If no active line, clicking into container activates first line
  if (activeLine.value === null && !props.readOnly) {
    setActiveLine(0)
  }
}

// Deactivate on click outside
onMounted(() => {
  const handler = (e: MouseEvent) => {
    if (container.value && !container.value.contains(e.target as Node)) {
      activeLine.value = null
    }
  }
  document.addEventListener('click', handler)
  onBeforeUnmount(() => document.removeEventListener('click', handler))
})
</script>

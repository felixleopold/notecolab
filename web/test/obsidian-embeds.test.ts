import assert from 'node:assert/strict'
import test from 'node:test'
import { renderObsidianImageEmbeds } from '../app/utils/obsidianEmbeds.ts'

test('renders image embeds with unescaped and table-safe escaped widths', () => {
  const expected = '<img data-obsidian-image="preview.svg" width="52" alt="preview.svg" class="obsidian-image-loading" />'

  assert.equal(renderObsidianImageEmbeds('![[preview.svg|52]]'), expected)
  assert.equal(renderObsidianImageEmbeds('![[preview.svg\\|52]]'), expected)
})

test('leaves non-image embeds for the note embed renderer', () => {
  assert.equal(renderObsidianImageEmbeds('![[Project note\\|52]]'), '![[Project note\\|52]]')
})

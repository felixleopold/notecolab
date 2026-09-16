import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { parse, compileScript } from 'vue/compiler-sfc'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

let bundle

test.beforeAll(async () => {
  const result = await build({
    entryPoints: ['e2e/editor-fixture.js'], bundle: true, write: false,
    format: 'iife', platform: 'browser', define: { 'import.meta.client': 'true' },
    alias: { '~': path.resolve('app') },
    plugins: [{
      name: 'vue-component',
      setup(builder) {
        builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
          const { descriptor } = parse(await readFile(filename, 'utf8'))
          const compiled = compileScript(descriptor, { id: 'editor-test', inlineTemplate: true, templateOptions: { transformAssetUrls: false } })
          return {
            contents: `import {ref, computed, watch, watchEffect, nextTick, onMounted, onBeforeUnmount} from 'vue';\nconst useApi = () => ({});\n${compiled.content}`,
            loader: 'ts', resolveDir: path.dirname(filename),
          }
        })
      },
    }],
  })
  bundle = result.outputFiles[0].text
})

for (const width of [1440, 390]) {
  test(`concurrent typing survives delayed updates at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.setContent('<div id="app"></div>')
    await page.addScriptTag({ content: bundle })
    await page.waitForFunction(() => window.fixture?.ready())
    const result = await page.evaluate(async () => window.fixture.concurrentTyping())
    expect(result.left).toBe('First line updated\nSecond line\nTyping ab here')
    expect(result.right).toBe(result.left)
    expect(result.shared).toBe(result.left)
    expect(result.line).toBe(3)
    await page.keyboard.type('c')
    expect(await page.evaluate(() => window.fixture.leftText())).toBe('First line updated\nSecond line\nTyping abc here')
  })
}

test('remote edits are not undone locally and stale content props do not overwrite the document', async ({ page }) => {
  await page.setContent('<div id="app"></div>')
  await page.addScriptTag({ content: bundle })
  await page.waitForFunction(() => window.fixture?.ready())
  await page.evaluate(() => window.fixture.concurrentTyping())
  await page.keyboard.press('ControlOrMeta+z')
  expect(await page.evaluate(() => window.fixture.leftText())).toBe('First line updated\nSecond line\nTyping here')
  await page.evaluate(() => window.fixture.staleSnapshot())
  expect(await page.evaluate(() => window.fixture.leftText())).toBe('First line updated\nSecond line\nTyping here')
})


test('read-only transitions block typing and undo while continuing to receive remote text', async ({ page }) => {
  await page.setContent('<div id="app"></div>')
  await page.addScriptTag({ content: bundle })
  await page.waitForFunction(() => window.fixture?.ready())
  await page.evaluate(() => window.fixture.concurrentTyping())
  await page.evaluate(() => window.fixture.setReadOnly(true))
  await page.keyboard.type('blocked')
  await page.keyboard.press('ControlOrMeta+z')
  expect(await page.evaluate(() => window.fixture.leftText())).toBe('First line updated\nSecond line\nTyping ab here')
  await page.evaluate(() => window.fixture.setText('Remote text while read-only'))
  expect(await page.evaluate(() => window.fixture.leftText())).toBe('Remote text while read-only')
  await page.evaluate(() => window.fixture.setReadOnly(false))
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' editable')
  expect(await page.evaluate(() => window.fixture.sharedText())).toContain(' editable')
})

test('rendered task changes and source/split transitions keep the shared document', async ({ page }) => {
  await page.setContent('<div id="app"></div>')
  await page.addScriptTag({ content: bundle })
  await page.waitForFunction(() => window.fixture?.ready())
  await page.evaluate(() => window.fixture.setText('- [ ] Shared task'))
  await page.evaluate(() => window.fixture.setMode('rendered'))
  await page.locator('.task-list-item-checkbox').check()
  expect(await page.evaluate(() => window.fixture.sharedText())).toBe('- [x] Shared task')
  await page.evaluate(() => window.fixture.setMode('split'))
  expect(await page.evaluate(() => window.fixture.leftText())).toBe('- [x] Shared task')
  await page.evaluate(() => window.fixture.setMode('source'))
  expect(await page.evaluate(() => window.fixture.leftText())).toBe('- [x] Shared task')
})

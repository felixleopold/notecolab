import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { parse, compileScript } from 'vue/compiler-sfc'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

let bundle

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import {createApp, h, ref} from 'vue';
        import PresenceIndicator from './app/components/PresenceIndicator.vue';
        const roster = ref({selfId:'self', participants:[{id:'self', name:'Me', client:'web'}, {id:'peer', name:'<img src=x onerror=alert(1)>', client:'obsidian'}]});
        createApp({setup:()=>()=>h(PresenceIndicator,{roster:roster.value,connectionStatus:'connected'})}).mount('#app');
        window.clearPresence=()=>{roster.value=null};`,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, format: 'iife', platform: 'browser',
    alias: { '~': path.resolve('app') },
    plugins: [{ name: 'vue-component', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
        const { descriptor } = parse(await readFile(filename, 'utf8'))
        const compiled = compileScript(descriptor, { id: 'presence-test', inlineTemplate: true })
        return { contents: `import {ref,watch} from 'vue';\n${compiled.content}`, loader: 'ts', resolveDir: path.dirname(filename) }
      })
    } }],
  })
  bundle = result.outputFiles[0].text
})

for (const width of [1440, 390]) {
  test(`presence includes you, escapes names and supports keyboard close at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.setContent('<style>:root{--nc-bg:white;--nc-text:black;--nc-muted:#555;--nc-border:#ddd}dialog{box-sizing:border-box;width:320px;max-width:calc(100vw - 2rem)}</style><div id="app"></div>')
    await page.addScriptTag({ content: bundle })
    const indicator = page.getByRole('button', { name: 'You + 1 other' })
    await indicator.click()
    const dialog = page.getByRole('dialog', { name: 'People here now' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('You', { exact: true })).toBeVisible()
    await expect(dialog.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible()
    await expect(dialog.locator('img')).toHaveCount(0)
    const bounds = await dialog.boundingBox()
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(indicator).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await page.evaluate(() => window.clearPresence())
    await expect(dialog).not.toBeVisible()
    await expect(page.getByText('Presence unavailable')).toBeVisible()
  })
}

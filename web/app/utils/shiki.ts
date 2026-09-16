/**
 * Shiki highlighter for the shared-note viewer.
 *
 * Mirrors CodeSuite's setup (the `shiki/core` engine with the JavaScript regex
 * engine, not WASM) so highlighting in a shared note matches what the author
 * sees in Obsidian. Themes are loaded as a DUAL pair (github-dark + github-light)
 * with `defaultColor: false`, so a single render emits both palettes as CSS
 * variables; the `.nc-light` class on <html> then selects light via CSS, with no
 * re-render needed (see the `.shiki` rules in NoteEditor.vue).
 *
 * Everything is dynamically imported so Shiki (and the grammars) only load when a
 * note is actually opened, keeping it out of the rest of the app's bundle.
 */
import type { HighlighterCore } from 'shiki/core'

let highlighter: HighlighterCore | null = null
let loading: Promise<HighlighterCore> | null = null

/** Dark theme is the viewer's default; `.nc-light` flips to light via CSS vars. */
export const SHIKI_THEMES = { dark: 'github-dark', light: 'github-light' } as const

/**
 * Load the highlighter once. Each `import()` uses a literal specifier so Vite can
 * code-split it into its own lazily-fetched chunk. Languages roughly mirror
 * CodeSuite's runtimes plus common markup; anything not listed falls back to
 * plain (un-highlighted) text in the same chrome.
 */
export async function loadHighlighter(): Promise<HighlighterCore> {
  if (highlighter) return highlighter
  if (!loading) {
    loading = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubDark, githubLight, ...langs] =
        await Promise.all([
          import('shiki/core'),
          import('shiki/engine/javascript'),
          import('shiki/themes/github-dark.mjs'),
          import('shiki/themes/github-light.mjs'),
          import('shiki/langs/python.mjs'),
          import('shiki/langs/javascript.mjs'),
          import('shiki/langs/typescript.mjs'),
          import('shiki/langs/jsx.mjs'),
          import('shiki/langs/tsx.mjs'),
          import('shiki/langs/shellscript.mjs'),
          import('shiki/langs/json.mjs'),
          import('shiki/langs/yaml.mjs'),
          import('shiki/langs/html.mjs'),
          import('shiki/langs/css.mjs'),
          import('shiki/langs/sql.mjs'),
          import('shiki/langs/c.mjs'),
          import('shiki/langs/cpp.mjs'),
          import('shiki/langs/java.mjs'),
          import('shiki/langs/go.mjs'),
          import('shiki/langs/rust.mjs'),
          import('shiki/langs/ruby.mjs'),
          import('shiki/langs/php.mjs'),
          import('shiki/langs/lua.mjs'),
          import('shiki/langs/perl.mjs'),
          import('shiki/langs/r.mjs'),
          import('shiki/langs/swift.mjs'),
          import('shiki/langs/powershell.mjs'),
          import('shiki/langs/markdown.mjs'),
          import('shiki/langs/diff.mjs'),
          import('shiki/langs/dockerfile.mjs'),
          import('shiki/langs/toml.mjs'),
          import('shiki/langs/xml.mjs'),
        ])
      highlighter = await createHighlighterCore({
        engine: createJavaScriptRegexEngine({ forgiving: true }),
        themes: [githubDark.default, githubLight.default],
        langs: langs.map((m: any) => m.default),
      })
      return highlighter
    })()
  }
  return loading
}

/** The loaded highlighter, or null if it hasn't finished loading yet. */
export function getHighlighter(): HighlighterCore | null {
  return highlighter
}

/** Whether a fence language (or one of its aliases) has a loaded grammar. */
export function isLangLoaded(lang: string): boolean {
  return !!highlighter && highlighter.getLoadedLanguages().includes(lang)
}

import type { Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Decoration, EditorView, MatchDecorator, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'

export type EditorTheme = 'light' | 'dark'

const githubHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--md-text)', fontSize: '2em', fontWeight: '600' },
  { tag: tags.heading2, color: 'var(--md-text)', fontSize: '1.5em', fontWeight: '600' },
  { tag: tags.heading3, color: 'var(--md-text)', fontSize: '1.25em', fontWeight: '600' },
  { tag: tags.heading4, color: 'var(--md-text)', fontWeight: '600' },
  { tag: tags.heading5, color: 'var(--md-text)', fontSize: '0.875em', fontWeight: '600' },
  { tag: tags.heading6, color: 'var(--md-muted)', fontSize: '0.85em', fontWeight: '600' },
  { tag: tags.strong, color: 'var(--md-text)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--md-link)' },
  { tag: tags.emphasis, color: 'var(--md-text)', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.quote, color: 'var(--md-muted)' },
  { tag: tags.monospace, color: 'var(--md-text)' },
  { tag: [tags.keyword, tags.operator], color: 'var(--cm-syntax-red)' },
  { tag: [tags.atom, tags.bool, tags.number], color: 'var(--cm-syntax-blue)' },
  { tag: [tags.string, tags.regexp], color: 'var(--cm-syntax-string)' },
  { tag: [tags.typeName, tags.className], color: 'var(--cm-syntax-purple)' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: 'var(--cm-syntax-purple)' },
  { tag: tags.comment, color: 'var(--cm-syntax-muted)' },
  { tag: tags.invalid, color: 'var(--cm-syntax-red)', textDecoration: 'underline wavy' },
])

const githubDarkEditorTheme = EditorView.theme({
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--nc-accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(56, 139, 253, 0.25)',
  },
}, { dark: true })

const wikiLinkMatcher = new MatchDecorator({
  regexp: /!?\[\[[^\]\n]+\]\]/g,
  decoration: Decoration.mark({ class: 'cm-wiki-link' }),
})

class WikiLinkHighlighter {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = wikiLinkMatcher.createDeco(view)
  }

  update(update: ViewUpdate) {
    this.decorations = wikiLinkMatcher.updateDeco(update, this.decorations)
  }
}

export const wikiLinkHighlighting = ViewPlugin.fromClass(WikiLinkHighlighter, {
  decorations: value => value.decorations,
})

export function codeMirrorThemeExtension(theme: EditorTheme): Extension {
  return theme === 'dark'
    ? [githubDarkEditorTheme, syntaxHighlighting(githubHighlightStyle)]
    : syntaxHighlighting(githubHighlightStyle)
}

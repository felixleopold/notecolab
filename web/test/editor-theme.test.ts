import assert from 'node:assert/strict'
import test from 'node:test'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { highlightingFor, syntaxTree } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { highlightTree } from '@lezer/highlight'
import { codeMirrorThemeExtension } from '../app/utils/editorTheme.ts'

test('CodeMirror can switch from dark to light without recreating the document', () => {
  const theme = new Compartment()
  let state = EditorState.create({
    doc: '# Kept intact',
    extensions: [theme.of(codeMirrorThemeExtension('dark'))],
  })

  assert.equal(state.facet(EditorView.darkTheme), true)

  state = state.update({
    effects: theme.reconfigure(codeMirrorThemeExtension('light')),
  }).state

  assert.equal(state.facet(EditorView.darkTheme), false)
  assert.equal(state.doc.toString(), '# Kept intact')
})

test('Markdown source tokens receive syntax highlighting', () => {
  const theme = new Compartment()
  let state = EditorState.create({
    doc: '# Highlighted heading with **bold** and [a link](https://example.com)',
    extensions: [
      markdown({ base: markdownLanguage }),
      theme.of(codeMirrorThemeExtension('dark')),
    ],
  })

  const highlightedText = (editorState: EditorState) => {
    const ranges: string[] = []
    highlightTree(
      syntaxTree(editorState),
      { style: tokenTags => highlightingFor(editorState, tokenTags) },
      (from, to) => ranges.push(editorState.sliceDoc(from, to)),
    )
    return ranges.join('')
  }

  assert.match(highlightedText(state), /Highlighted heading.*bold.*a link/)

  state = state.update({
    effects: theme.reconfigure(codeMirrorThemeExtension('light')),
  }).state

  assert.match(highlightedText(state), /Highlighted heading.*bold.*a link/)
})

test('Markdown list markers keep the rendered text color', () => {
  const state = EditorState.create({
    doc: '- A normal bullet',
    extensions: [
      markdown({ base: markdownLanguage }),
      codeMirrorThemeExtension('dark'),
    ],
  })
  const highlightedRanges: string[] = []

  highlightTree(
    syntaxTree(state),
    { style: tokenTags => highlightingFor(state, tokenTags) },
    (from, to) => highlightedRanges.push(state.sliceDoc(from, to)),
  )

  assert.ok(!highlightedRanges.includes('-'))
})

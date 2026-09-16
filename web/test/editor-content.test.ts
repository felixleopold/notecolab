import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { editorContentChange } from '../app/utils/editorContent.ts'

test('incoming edits keep subsequent typing at the cursor in unchanged text', () => {
  const content = 'First line\nSecond line\nTyping here'
  let state = EditorState.create({
    doc: content,
    selection: { anchor: content.indexOf(' here') },
  })

  const incoming = content.replace('First line', 'First line updated')
  state = state.update({ changes: editorContentChange(content, incoming) }).state
  assert.equal(state.doc.lineAt(state.selection.main.head).number, 3)

  state = state.update(state.replaceSelection(' continues')).state
  assert.equal(state.doc.toString(), 'First line updated\nSecond line\nTyping continues here')
})

test('incoming deletions and edits after a selection preserve its text and direction', () => {
  const content = 'First line\nSecond line\nLast line'
  let state = EditorState.create({
    doc: content,
    selection: { anchor: content.indexOf('Second') + 6, head: content.indexOf('Second') },
  })

  for (const incoming of ['line\nSecond line\nLast line', 'line\nSecond line\nLast line updated']) {
    state = state.update({ changes: editorContentChange(state.doc.toString(), incoming) }).state
    assert.equal(state.doc.toString(), incoming)
    assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), 'Second')
    assert.ok(state.selection.main.anchor > state.selection.main.head)
  }
})

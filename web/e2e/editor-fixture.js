import { createApp, h, ref, shallowRef, nextTick } from 'vue'
import * as Y from 'yjs'
import NoteEditor from '../app/components/NoteEditor.vue'

const initial = 'First line\nSecond line\nTyping here'
const leftDoc = new Y.Doc()
leftDoc.getText('content').insert(0, initial)
const rightDoc = new Y.Doc()
Y.applyUpdate(rightDoc, Y.encodeStateAsUpdate(leftDoc))
const left = shallowRef()
const right = shallowRef()
const content = ref(initial)
const mode = ref('source')
const readOnly = ref(false)
leftDoc.getText('content').observe(() => {content.value = leftDoc.getText('content').toString()})
createApp({
  setup: () => () => h('div', [
    h(NoteEditor, {ref: left, mode: mode.value, readOnly: readOnly.value, content: content.value, collaborationText: leftDoc.getText('content'), 'onUpdate:content': value => {content.value = value}}),
    h(NoteEditor, {ref: right, mode: 'source', content: initial, collaborationText: rightDoc.getText('content')}),
  ]),
}).mount('#app')
window.fixture = {
  ready: () => Boolean(left.value?.getEditorView() && right.value?.getEditorView()),
  leftText: () => left.value.getEditorView().state.doc.toString(),
  async concurrentTyping() {
    const a = left.value.getEditorView()
    const b = right.value.getEditorView()
    a.dispatch({selection: {anchor: initial.indexOf(' here')}})
    // Multiple transactions in one turn must all reach Yjs.
    a.dispatch(a.state.replaceSelection(' a'))
    a.dispatch(a.state.replaceSelection('b'))
    b.dispatch({changes: {from: 'First line'.length, insert: ' updated'}})
    // Both peers edited before either received the other's update.
    const aUpdate = Y.encodeStateAsUpdate(leftDoc)
    const bUpdate = Y.encodeStateAsUpdate(rightDoc)
    Y.applyUpdate(leftDoc, bUpdate, 'remote')
    Y.applyUpdate(rightDoc, aUpdate, 'remote')
    await nextTick()
    a.focus()
    return {left: a.state.doc.toString(), right: b.state.doc.toString(), shared: leftDoc.getText('content').toString(), line: a.state.doc.lineAt(a.state.selection.main.head).number}
  },
  async setReadOnly(value) { readOnly.value = value; await nextTick(); left.value.getEditorView().focus() },
  async setMode(value) { mode.value = value; await nextTick(); await nextTick() },
  async setText(value) {
    const text = leftDoc.getText('content')
    leftDoc.transact(() => {text.delete(0, text.length); text.insert(0, value)}, 'remote')
    await nextTick()
  },
  sharedText: () => leftDoc.getText('content').toString(),
  async staleSnapshot() { content.value = initial; await nextTick() },
}

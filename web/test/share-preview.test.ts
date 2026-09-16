import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSharePreview } from '../app/utils/sharePreview.ts'

test('encrypted editable notes get useful, non-repetitive preview copy', () => {
  assert.deepEqual(buildSharePreview({ accessMode: 'public_edit' }), {
    title: 'A note was shared with you',
    description: 'Open it in NoteColab to edit and collaborate.',
    imageTitle: 'Open to decrypt',
    accessLabel: 'Collaborative note',
  })
})

test('read-only previews explain what the recipient can do', () => {
  assert.deepEqual(buildSharePreview({ title: '  Release notes  ', accessMode: 'read_only' }), {
    title: 'Release notes',
    description: 'Open it in NoteColab to read it securely.',
    imageTitle: 'Release notes',
    accessLabel: 'View-only note',
  })
})

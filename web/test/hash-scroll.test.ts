import test from 'node:test'
import assert from 'node:assert/strict'
import { hashScrollTargetId } from '../app/utils/hashScroll'

test('capability fragments are never treated as document anchors', () => {
  for (const path of ['/s/note-id', '/invite/token', '/live/room-id']) {
    assert.equal(hashScrollTargetId(path, '#a+/unsafe[capability'), null)
  }
})

test('ordinary encoded heading fragments resolve to a DOM id without selector parsing', () => {
  assert.equal(hashScrollTargetId('/help', '#account%20recovery'), 'account recovery')
  assert.equal(hashScrollTargetId('/help', '#heading]with.selector'), 'heading]with.selector')
  assert.equal(hashScrollTargetId('/help', '#%E0%A4%A'), null)
})

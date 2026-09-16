import assert from 'node:assert/strict'
import test from 'node:test'
import { setTaskCheckedAtLine } from '../app/utils/taskCheckbox.ts'

test('checking a rendered task updates the matching Markdown source line', () => {
  const markdown = '# Launch plan\n\n- [ ] Verify backups\n- [x] Deploy'

  assert.equal(
    setTaskCheckedAtLine(markdown, 2, true),
    '# Launch plan\n\n- [x] Verify backups\n- [x] Deploy',
  )
})

test('task updates preserve nesting, blockquotes, ordered lists, and line endings', () => {
  assert.equal(setTaskCheckedAtLine('> 1. [X] Review\r\nNext', 0, false), '> 1. [ ] Review\r\nNext')
  assert.equal(setTaskCheckedAtLine('  * [ ] Nested', 0, true), '  * [x] Nested')
})

test('a non-task source line is not changed', () => {
  assert.equal(setTaskCheckedAtLine('- Ordinary item', 0, true), null)
})

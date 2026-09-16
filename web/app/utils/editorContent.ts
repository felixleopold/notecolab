export function editorContentChange(current: string, incoming: string) {
  let from = 0
  while (from < current.length && from < incoming.length && current[from] === incoming[from]) {
    from++
  }

  let to = current.length
  let incomingTo = incoming.length
  while (to > from && incomingTo > from && current[to - 1] === incoming[incomingTo - 1]) {
    to--
    incomingTo--
  }

  // Preserve unchanged text so CodeMirror can map the selection through the edit.
  return { from, to, insert: incoming.slice(from, incomingTo) }
}

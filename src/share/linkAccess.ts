/** The label for an owned note follows its current links, not the mode it was first shared with. */
export function ownedNoteAccessMode(links: readonly { accessMode: string }[]): string {
  if (links.some((link) => link.accessMode === 'public_edit')) return 'public_edit';
  if (links.some((link) => link.accessMode === 'read_only')) return 'read_only';
  return links.length > 0 ? 'invited_edit' : 'read_only';
}

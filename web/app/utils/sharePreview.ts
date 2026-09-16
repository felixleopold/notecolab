interface SharePreviewMetadata {
  title?: string | null
  accessMode?: string | null
}

export function buildSharePreview({ title, accessMode }: SharePreviewMetadata) {
  const publicTitle = title?.trim() || null
  const readOnly = accessMode === 'read_only'

  return {
    title: publicTitle || 'A note was shared with you',
    description: readOnly
      ? 'Open it in NoteColab to read it securely.'
      : 'Open it in NoteColab to edit and collaborate.',
    imageTitle: publicTitle || 'Open to decrypt',
    accessLabel: readOnly ? 'View-only note' : 'Collaborative note',
  }
}

/** True only for a recipient's read-only import, never the owner's source note. */
export function isReadOnlyRecipient(frontmatter: Record<string, unknown> | undefined): boolean {
  return frontmatter?.colab_access === 'read_only'
    && frontmatter.colab_owner === false
    && typeof frontmatter.colab_share_id === 'string'
    && frontmatter.colab_share_id.length > 0;
}

/**
 * The `colab_access` a vault copy records. A link's mode is not the caller's
 * permission (a view-only collaborator can hold an invited-edit link), so a
 * recipient the server denies editing gets a read-only mirror.
 */
export function recordedAccess<Mode extends string>(
  note: { accessMode: Mode; canEdit?: boolean },
  isOwner: boolean,
): Mode | 'read_only' {
  return !isOwner && note.canEdit === false ? 'read_only' : note.accessMode;
}

/** True for a locally tracked note received from someone else. */
export function isRecipientImport(frontmatter: Record<string, unknown> | undefined): boolean {
  return frontmatter?.colab_owner === false
    && typeof frontmatter.colab_share_id === 'string'
    && frontmatter.colab_share_id.length > 0
    && (frontmatter.colab_access === 'read_only'
      || frontmatter.colab_access === 'public_edit'
      || frontmatter.colab_access === 'invited_edit');
}

/** Remove NoteColab tracking fields while preserving ordinary frontmatter. */
export function stripColabMetadata(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return content;
  const frontmatter = match[0];
  const body = content.slice(frontmatter.length);

  const lines = frontmatter
    .replace(/^---\r?\n/, '')
    .replace(/\r?\n---\r?\n?$/, '')
    .split(/\r?\n/)
    .filter((line) => !/^colab_[A-Za-z0-9_-]+\s*:/.test(line));

  const meaningful = lines.some((line) => line.trim().length > 0);
  return meaningful ? `---\n${lines.join('\n')}\n---\n${body}` : body;
}

/** Prefer the original title over the visible recipient marker. */
export function editableCopyBasename(basename: string): string {
  const title = recipientNoteTitle(basename);
  return `${title.trimEnd() || 'Shared Note'} (local copy)`;
}

/** Remove the recipient marker used in vault filenames. */
export function recipientNoteTitle(basename: string): string {
  const marker = basename.lastIndexOf(' — NoteColab');
  return marker > 0 ? basename.slice(0, marker) : basename;
}

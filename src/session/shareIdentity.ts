export type EditableShareAccess = 'public_edit' | 'invited_edit';
export type ShareAccess = EditableShareAccess | 'read_only';

function frontmatterValue(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*([^\\r\\n]*)`, 'm'));
  const value = match?.[1]?.trim().replace(/\s+#.*$/, '') || '';
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * A live session remains valid only while the file still identifies the same
 * editable share. Read the raw file rather than MetadataCache so removing the
 * tracking keys cannot race a local or remote sync event.
 */
export function hasMatchingShareIdentity(
  frontmatter: string,
  shareId: string,
  allowedAccess: readonly ShareAccess[],
): boolean {
  const currentShareId = frontmatterValue(frontmatter, 'colab_share_id');
  const link = frontmatterValue(frontmatter, 'colab_link');
  const access = frontmatterValue(frontmatter, 'colab_access');
  const encryptionKey = frontmatterValue(frontmatter, 'colab_encryption_key')
    || link.split('#')[1]
    || '';
  return currentShareId === shareId
    && link.length > 0
    && encryptionKey.length > 0
    && allowedAccess.includes(access as ShareAccess);
}

export function hasMatchingEditableShareIdentity(frontmatter: string, shareId: string): boolean {
  return hasMatchingShareIdentity(frontmatter, shareId, ['public_edit', 'invited_edit']);
}

export type EditableShareAccess = 'public_edit' | 'invited_edit';
export type ShareAccess = EditableShareAccess | 'read_only';

function frontmatterValue(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*([^\\r\\n]*)`, 'm'));
  const value = match?.[1]?.trim().replace(/\s+#.*$/, '') || '';
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * A live session remains valid only while the file still identifies the same
 * share with an allowed access mode. Read the raw file rather than
 * MetadataCache so removing the tracking keys cannot race a local or remote
 * sync event.
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

/**
 * Owners join live document sync unless the note is a snapshot share: the
 * server grants them write through their account token whatever the mode or
 * expiry of the link they shared. Everyone else needs an editable link.
 */
export function joinsLiveSync(
  frontmatter: { colab_owner?: boolean; colab_access?: string; colab_update_mode?: string } | undefined,
): boolean {
  // A snapshot share promises that later edits stay private.
  return (frontmatter?.colab_owner === true && frontmatter.colab_update_mode !== 'snapshot')
    || frontmatter?.colab_access === 'public_edit'
    || frontmatter?.colab_access === 'invited_edit';
}

export function ownsShare(frontmatter: string): boolean {
  return frontmatterValue(frontmatter, 'colab_owner') === 'true';
}

export function hasMatchingEditableShareIdentity(frontmatter: string, shareId: string): boolean {
  const ownerLiveSync = ownsShare(frontmatter)
    && frontmatterValue(frontmatter, 'colab_update_mode') !== 'snapshot';
  return hasMatchingShareIdentity(frontmatter, shareId, ownerLiveSync
    ? ['public_edit', 'invited_edit', 'read_only']
    : ['public_edit', 'invited_edit']);
}

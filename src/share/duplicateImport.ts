/** Human label for an access mode, matching the share UI vocabulary. */
function accessLabel(accessMode: string): string {
  switch (accessMode) {
    case 'public_edit': return 'editable link';
    case 'invited_edit': return 'invited collaborators';
    case 'read_only': return 'view-only link';
    default: return accessMode;
  }
}

/**
 * The same note can be delivered twice through links with different permissions,
 * but a vault holds one file per note. Say which version stayed instead of
 * implying the newly delivered link was applied.
 */
export function existingImportNotice(
  basename: string,
  frontmatter: Record<string, unknown> | undefined,
  delivered: { linkShareId: string; accessMode: string },
): string {
  const knownLink = frontmatter?.colab_link_id;
  const knownAccess = frontmatter?.colab_access;
  const isDifferentLink = typeof knownLink === 'string'
    && knownLink.length > 0
    && knownLink !== delivered.linkShareId;
  const isDifferentAccess = typeof knownAccess === 'string'
    && knownAccess !== delivered.accessMode;

  if (isDifferentLink && isDifferentAccess) {
    return `"${basename}" is already in your vault as ${accessLabel(knownAccess)}`
      + ` and was opened unchanged. Delete it first to import the`
      + ` ${accessLabel(delivered.accessMode)} version.`;
  }
  return `Opened existing note: ${basename}`;
}

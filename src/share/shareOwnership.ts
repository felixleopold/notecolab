export type ShareOwnership = 'owner' | 'recipient' | 'unknown';

/**
 * `colab_owner` is only written by plugin 1.24.2 and later. Notes shared or
 * imported before that carry no marker at all, so their ownership is 'unknown'
 * and must not be guessed for destructive or identity-changing actions.
 */
export function shareOwnership(
  frontmatter: Record<string, unknown> | undefined,
): ShareOwnership {
  if (frontmatter?.colab_owner === true) return 'owner';
  if (frontmatter?.colab_owner === false) return 'recipient';
  return 'unknown';
}

/**
 * Owner-only publishing (content snapshots, renamed titles) is enforced by the
 * server, so an unmarked legacy note may still attempt it — that keeps notes
 * shared before 1.24.2 publishing. Only a known recipient must never publish.
 */
export function mayPublishAsOwner(
  frontmatter: Record<string, unknown> | undefined,
): boolean {
  return shareOwnership(frontmatter) !== 'recipient';
}

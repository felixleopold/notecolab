export interface NoteColabFrontmatter extends Record<string, unknown> {
  colab_share_id?: string;
  colab_link_id?: string;
  colab_link?: string;
  colab_access?: 'public_edit' | 'invited_edit' | 'read_only';
  colab_encryption_key?: string;
  colab_owner?: boolean;
  colab_expires?: string;
  colab_session?: string;
}

export function noteColabFrontmatter(value: unknown): NoteColabFrontmatter | undefined {
  return typeof value === 'object' && value !== null
    ? value as NoteColabFrontmatter
    : undefined;
}

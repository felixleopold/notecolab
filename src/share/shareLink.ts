/** Extract the permission-bearing share ID from a NoteColab URL. */
export function shareIdFromLink(link: string | undefined): string {
  if (!link) return '';
  try {
    const parts = new URL(link).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
}

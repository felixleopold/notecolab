const MAX_TITLE_BYTES = 200;
const MAX_BASENAME_BYTES = 240;
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (usedBytes + characterBytes > maxBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

/** Sanitize a share-supplied title to one safe vault filename segment. */
export function sanitizeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() || '')
    // eslint-disable-next-line no-control-regex -- Control characters are invalid in filenames.
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return truncateUtf8(base, MAX_TITLE_BYTES);
}

function sanitizeLabel(label: string): string {
  return label
    .replace(/[\\/]/g, ' ')
    // eslint-disable-next-line no-control-regex -- Control characters are invalid in filenames.
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a visibly recipient-only basename while keeping the note title first. */
export function sharedNoteBasename(title: string, ownerLabel?: string): string {
  const cleanTitle = sanitizeFilename(title) || 'Shared Note';
  const cleanLabel = ownerLabel ? sanitizeLabel(ownerLabel) : '';
  const marker = cleanLabel ? ` — NoteColab · ${cleanLabel}` : ' — NoteColab';
  const firstTitleCharacter = Array.from(cleanTitle)[0] || 'S';
  const safeMarker = truncateUtf8(
    marker,
    MAX_BASENAME_BYTES - byteLength(firstTitleCharacter),
  );
  const availableTitleBytes = MAX_BASENAME_BYTES - byteLength(safeMarker);
  return truncateUtf8(cleanTitle, availableTitleBytes).trimEnd() + safeMarker;
}

/** Append Obsidian's collision counter without exceeding filesystem limits. */
export function withFilenameCounter(basename: string, counter: number): string {
  if (counter <= 0) return truncateUtf8(basename, MAX_BASENAME_BYTES);
  const suffix = ` (${counter})`;
  const markerIndex = basename.lastIndexOf(' — NoteColab');
  if (markerIndex > 0) {
    const title = basename.slice(0, markerIndex);
    const marker = basename.slice(markerIndex);
    const firstTitleCharacter = Array.from(title)[0] || 'S';
    const markerBytes = MAX_BASENAME_BYTES
      - byteLength(suffix)
      - byteLength(firstTitleCharacter);
    const safeMarker = truncateUtf8(marker, Math.max(0, markerBytes));
    const availableTitleBytes = MAX_BASENAME_BYTES - byteLength(suffix) - byteLength(safeMarker);
    return truncateUtf8(title, availableTitleBytes).trimEnd() + suffix + safeMarker;
  }
  return truncateUtf8(basename, MAX_BASENAME_BYTES - byteLength(suffix)).trimEnd() + suffix;
}

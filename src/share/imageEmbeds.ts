const IMAGE_EMBED_RE =
  /!\[\[([^\]|\n]{1,255}\.(?:png|jpe?g|gif|webp|svg|bmp))(?:\\?\|[^\]\n]{0,255})?\]\]/gi;

/** Find image filenames in Obsidian embeds, including escaped pipes in tables. */
export function findImageEmbeds(text: string): string[] {
  const filenames: string[] = [];
  let match: RegExpExecArray | null;
  IMAGE_EMBED_RE.lastIndex = 0;
  while ((match = IMAGE_EMBED_RE.exec(text)) !== null) {
    filenames.push(match[1].trim());
  }
  return [...new Set(filenames)];
}

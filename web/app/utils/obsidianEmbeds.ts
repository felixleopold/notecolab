function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Convert Obsidian image embeds, including table-safe escaped pipe aliases. */
export function renderObsidianImageEmbeds(text: string): string {
  return text.replace(
    /!\[\[([^\]|\n]{1,255}\.(?:png|jpe?g|gif|webp|svg|bmp))(?:\\?\|(\d+))?\]\]/gi,
    (_match, filename: string, width: string | undefined) => {
      const safeFilename = escapeHtmlAttr(filename)
      const widthAttr = width ? ` width="${width}"` : ''
      return `<img data-obsidian-image="${safeFilename}"${widthAttr} alt="${safeFilename}" class="obsidian-image-loading" />`
    },
  )
}

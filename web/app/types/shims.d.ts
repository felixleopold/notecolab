declare module 'markdown-it-mark' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginSimple
  export default plugin
}

declare module '@traptitech/markdown-it-katex' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginWithOptions
  export default plugin
}

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginWithOptions
  export default plugin
}

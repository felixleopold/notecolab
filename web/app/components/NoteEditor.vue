<template>
  <div class="nc-note-editor flex flex-col h-full" :class="theme === 'light' ? 'nc-light' : ''" style="background-color: var(--nc-bg);">
    <!-- Document identity -->
    <div v-if="noteTitle" class="nc-note-header px-3 sm:px-5 py-3 border-b" style="border-color: var(--nc-border);">
      <div class="flex items-center gap-3">
        <h1 class="flex-1 min-w-0 text-base sm:text-lg font-semibold truncate" style="color: var(--nc-text);">{{ noteTitle }}</h1>
        <div v-if="showChrome" class="flex items-center gap-2 flex-shrink-0">
          <span v-if="accessMode" class="hidden sm:flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border" style="border-color: var(--nc-border); color: var(--nc-muted);">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path v-if="accessMode === 'public_edit'" stroke-linecap="round" stroke-linejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              <path v-else stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
            </svg>
            {{ accessModeLabel }}
          </span>
          <span v-if="expiresAt" class="flex items-center gap-1.5 text-xs flex-shrink-0" style="color: var(--nc-muted);">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            {{ expiresLabel }}
          </span>
        </div>
      </div>
    </div>

    <!-- Toolbar -->
    <div v-if="showToolbar" class="nc-editor-toolbar flex items-center gap-2 sm:gap-3 px-3 sm:px-5 border-b text-sm overflow-x-auto" style="border-color: var(--nc-border);">


      <!-- Mode switcher -->
      <div v-if="showModeSwitcher" class="flex flex-shrink-0 self-stretch">
        <button
          v-for="m in modes"
          :key="m.value"
          @click="$emit('update:mode', m.value)"
          class="nc-view-tab flex items-center gap-1.5 px-2.5 sm:px-3 text-xs font-medium border-b-2 transition-colors duration-150"
          :class="{ 'is-active': mode === m.value }"
        >
          <svg v-if="m.value === 'source'" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>
          </svg>
          <svg v-else-if="m.value === 'split'" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7"/>
          </svg>
          <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
            <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
          </svg>
          <span class="hidden sm:inline">{{ m.label }}</span>
        </button>
      </div>

      <!-- Formatting toolbar (only when editing in source/split mode) -->
      <template v-if="!readOnly && (mode === 'source' || mode === 'split')">
        <div class="w-px h-5 flex-shrink-0" style="background: var(--nc-border);" />
        <div class="flex items-center gap-0.5 flex-shrink-0">
          <!-- Bold -->
          <button @click="toggleBold" class="p-1.5 rounded-md transition-colors hover:bg-white/10" style="color: var(--nc-muted);" title="Bold (Ctrl+B)">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6z"/>
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 12h9a4 4 0 014 4 4 4 0 01-4 4H6z"/>
            </svg>
          </button>
          <!-- Italic -->
          <button @click="toggleItalic" class="p-1.5 rounded-md transition-colors hover:bg-white/10" style="color: var(--nc-muted);" title="Italic (Ctrl+I)">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10 4h4m-2 0l-4 16m0 0h4m2-16l-4 16"/>
            </svg>
          </button>
          <!-- Heading dropdown -->
          <div class="relative" ref="headingDropdownRef">
            <button ref="headingBtnRef" @click="toggleHeadingDropdown" class="flex items-center gap-0.5 p-1.5 rounded-md transition-colors hover:bg-white/10" style="color: var(--nc-muted);" title="Heading">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 9h16M4 15h16M9 4l-2 16M15 4l-2 16"/>
              </svg>
              <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
              </svg>
            </button>
          </div>
          <Teleport to="body">
            <div v-if="showHeadingDropdown" ref="headingDropdownMenuRef"
              class="fixed rounded-lg border shadow-xl py-1 min-w-[120px]"
              :style="{ top: headingDropdownPos.top + 'px', left: headingDropdownPos.left + 'px', zIndex: 9999, background: 'var(--nc-surface)', borderColor: 'var(--nc-border)' }">
              <button v-for="level in [1,2,3,4,5,6]" :key="level" @click="setHeading(level); showHeadingDropdown = false" class="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors" style="color: var(--nc-text-2);">
                <span :style="{ fontSize: `${18 - level * 1.5}px`, fontWeight: level <= 2 ? '700' : '600' }">H{{ level }}</span>
                <span class="ml-2" style="color: var(--nc-muted);">Heading {{ level }}</span>
              </button>
              <div class="border-t my-1" style="border-color: var(--nc-border);" />
              <button @click="removeHeading(); showHeadingDropdown = false" class="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors" style="color: var(--nc-muted);">
                Normal text
              </button>
            </div>
          </Teleport>
          <!-- Insert Image -->
          <button @click="triggerImageUpload" class="p-1.5 rounded-md transition-colors hover:bg-white/10" style="color: var(--nc-muted);" title="Insert image">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
          </button>
          <input ref="imageFileInput" type="file" accept="image/*" class="hidden" @change="onImageFileSelected" />
          <!-- Comment -->
          <button @click="toggleComment" class="p-1.5 rounded-md transition-colors hover:bg-white/10" style="color: var(--nc-muted);" title="Comment (<!-- -->)">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
            </svg>
          </button>
        </div>
      </template>

      <div class="flex-1 min-w-0" />

      <!-- Connection status -->
      <div v-if="showChrome && connectionStatus" class="flex items-center gap-1.5 text-xs flex-shrink-0 px-2 py-1 rounded-md" style="background: var(--nc-bg);">
        <span class="relative flex h-2 w-2">
          <span
            v-if="connectionStatus === 'connected'"
            class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"
          />
          <span
            class="relative inline-flex rounded-full h-2 w-2"
            :class="{
              'bg-green-500': connectionStatus === 'connected',
              'bg-amber-500': connectionStatus === 'syncing',
              'bg-red-500': connectionStatus === 'disconnected',
            }"
          />
        </span>
        <span class="capitalize hidden sm:inline" style="color: var(--nc-muted);">{{ connectionStatus }}</span>
      </div>

      <PresenceIndicator v-if="showChrome" :roster="presence ?? null" :connection-status="connectionStatus" />

      <!-- Read-only badge -->
      <span v-if="showChrome && readOnly" class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md font-medium flex-shrink-0" style="background: rgba(245, 158, 11, 0.08); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.15);">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
        </svg>
        View only
      </span>

      <!-- Help -->
      <button @click="showHelpModal = true" class="flex-shrink-0 p-1.5 rounded-md transition-colors hover:bg-white/10" style="color: var(--nc-muted);" title="How to use this editor">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
      </button>
      <Teleport to="body">
        <div v-if="showHelpModal" class="fixed inset-0 z-[10000] flex items-center justify-center p-4" style="background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);" @click.self="showHelpModal = false">
          <div class="relative w-full max-w-xl max-h-[85vh] overflow-y-auto rounded-2xl border shadow-2xl" style="background: var(--nc-bg); border-color: var(--nc-border);">
            <!-- Header -->
            <div class="sticky top-0 flex items-center justify-between px-5 py-4 border-b" style="background: var(--nc-surface); border-color: var(--nc-border);">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg flex items-center justify-center" style="background: rgba(127, 109, 242, 0.15);">
                  <svg class="w-4 h-4" style="color: var(--nc-accent);" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                  </svg>
                </div>
                <h2 class="font-semibold text-sm" style="color: var(--nc-text);">How to use this editor</h2>
              </div>
              <button @click="showHelpModal = false" class="p-1.5 rounded-md hover:bg-white/10 transition-colors" style="color: var(--nc-muted);">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <!-- Body -->
            <div class="p-5 space-y-5 text-sm" style="color: var(--nc-text-2);">
              <!-- What is this -->
              <div>
                <h3 class="font-semibold mb-2" style="color: var(--nc-text);">What is this?</h3>
                <p style="color: var(--nc-muted); line-height: 1.6;">You've received an <strong style="color: var(--nc-accent-soft);">encrypted note</strong> shared via NoteColab, a tool made by <a href="https://felixmrak.com" target="_blank" rel="noopener" style="color: var(--nc-accent-soft);" class="hover:underline">Felix Mrak</a>. REST-stored note material is decrypted in your browser; live collaboration text is visible to the relay.</p>
              </div>
              <!-- View modes -->
              <div>
                <h3 class="font-semibold mb-2.5" style="color: var(--nc-text);">View modes</h3>
                <div class="space-y-2">
                  <div class="flex items-start gap-3 p-3 rounded-lg" style="background: var(--nc-surface);">
                    <svg class="w-4 h-4 mt-0.5 flex-shrink-0" style="color: var(--nc-accent);" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
                    <div><span class="font-medium" style="color: var(--nc-text);">Source</span> <span style="color: var(--nc-muted);">Edit raw Markdown text directly.</span></div>
                  </div>
                  <div class="flex items-start gap-3 p-3 rounded-lg" style="background: var(--nc-surface);">
                    <svg class="w-4 h-4 mt-0.5 flex-shrink-0" style="color: var(--nc-accent);" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7"/></svg>
                    <div><span class="font-medium" style="color: var(--nc-text);">Split</span> <span style="color: var(--nc-muted);">Editor on the left, formatted preview on the right.</span></div>
                  </div>
                  <div class="flex items-start gap-3 p-3 rounded-lg" style="background: var(--nc-surface);">
                    <svg class="w-4 h-4 mt-0.5 flex-shrink-0" style="color: var(--nc-accent);" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                    <div><span class="font-medium" style="color: var(--nc-text);">Reading</span> <span style="color: var(--nc-muted);">Formatted preview only, no editor.</span></div>
                  </div>
                </div>
              </div>
              <!-- Toolbar -->
              <div v-if="!readOnly">
                <h3 class="font-semibold mb-2" style="color: var(--nc-text);">Formatting toolbar</h3>
                <p style="color: var(--nc-muted); line-height: 1.6;">Use the buttons in the toolbar at the top of the editor to quickly apply formatting: headings, bold, italic, lists, code blocks, links, and image upload. You can also switch between Source, Split, and Reading view modes using the mode buttons on the right side of the toolbar.</p>
              </div>
              <!-- Comments -->
              <div>
                <h3 class="font-semibold mb-2" style="color: var(--nc-text);">Adding comments</h3>
                <p style="color: var(--nc-muted); line-height: 1.6;">To leave a comment that is hidden in reading view, use HTML comment syntax: <code class="px-1 py-0.5 rounded text-xs" style="background: var(--nc-surface-2); color: var(--nc-accent-soft);">&lt;!-- your comment here --&gt;</code>. The comment will be visible in source and split mode but invisible in the rendered reading view. Use a blockquote (<code class="px-1 py-0.5 rounded text-xs" style="background: var(--nc-surface-2); color: var(--nc-accent-soft);">&gt; </code>) to highlight feedback inline.</p>
              </div>
              <!-- Markdown basics -->
              <div>
                <h3 class="font-semibold mb-2.5" style="color: var(--nc-text);">Markdown basics</h3>
                <p class="mb-2.5" style="color: var(--nc-muted);">Markdown is a simple way to format text using special characters. Here's what you can type:</p>
                <div class="rounded-lg overflow-hidden border text-xs" style="border-color: var(--nc-border);">
                  <table class="w-full">
                    <thead><tr style="background: var(--nc-surface);"><th class="px-3 py-2 text-left font-medium" style="color: var(--nc-muted);">You type</th><th class="px-3 py-2 text-left font-medium" style="color: var(--nc-muted);">Result</th></tr></thead>
                    <tbody style="color: var(--nc-text-2);">
                      <tr class="border-t" style="border-color: var(--nc-border);"><td class="px-3 py-2 font-mono" style="color: var(--nc-accent-soft);"># Heading 1</td><td class="px-3 py-2"><strong style="font-size: 1.1em;">Heading 1</strong></td></tr>
                      <tr class="border-t" style="border-color: var(--nc-border);"><td class="px-3 py-2 font-mono" style="color: var(--nc-accent-soft);">## Heading 2</td><td class="px-3 py-2"><strong>Heading 2</strong></td></tr>
                      <tr class="border-t" style="border-color: var(--nc-border);"><td class="px-3 py-2 font-mono" style="color: var(--nc-accent-soft);">**bold text**</td><td class="px-3 py-2"><strong>bold text</strong></td></tr>
                      <tr class="border-t" style="border-color: var(--nc-border);"><td class="px-3 py-2 font-mono" style="color: var(--nc-accent-soft);">*italic text*</td><td class="px-3 py-2"><em>italic text</em></td></tr>
                      <tr class="border-t" style="border-color: var(--nc-border);"><td class="px-3 py-2 font-mono" style="color: var(--nc-accent-soft);">- list item</td><td class="px-3 py-2">• list item</td></tr>
                      <tr class="border-t" style="border-color: var(--nc-border);"><td class="px-3 py-2 font-mono" style="color: var(--nc-accent-soft);">1. numbered item</td><td class="px-3 py-2">1. numbered item</td></tr>
                      <tr class="border-t" style="border-color: var(--nc-border);"><td class="px-3 py-2 font-mono" style="color: var(--nc-accent-soft);">`code`</td><td class="px-3 py-2 font-mono" style="background: var(--nc-surface-2); font-size: 0.85em;">code</td></tr>
                      <tr class="border-t" style="border-color: var(--nc-border);"><td class="px-3 py-2 font-mono" style="color: var(--nc-accent-soft);">&gt; blockquote</td><td class="px-3 py-2"><span style="border-left: 3px solid var(--nc-accent); padding-left: 8px; color: var(--nc-muted);">blockquote</span></td></tr>
                      <tr class="border-t" style="border-color: var(--nc-border);"><td class="px-3 py-2 font-mono" style="color: var(--nc-accent-soft);">[text](url)</td><td class="px-3 py-2" style="color: var(--nc-accent);">text (as a link)</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <!-- Collaboration -->
              <div v-if="!readOnly">
                <h3 class="font-semibold mb-2" style="color: var(--nc-text);">Real-time collaboration</h3>
                <p style="color: var(--nc-muted); line-height: 1.6;">Changes you make are synced instantly to everyone who has this link open. The presence indicator includes you and counts people with this note in the foreground, including readers. Click it to see participant names. Older clients may not report presence.</p>
              </div>
              <!-- Images -->
              <div v-if="!readOnly">
                <h3 class="font-semibold mb-2" style="color: var(--nc-text);">Adding images</h3>
                <p style="color: var(--nc-muted); line-height: 1.6;">Click the <svg class="inline w-3.5 h-3.5" style="vertical-align: -2px;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg> image button in the toolbar or paste an image directly into the editor. Images are encrypted before upload.</p>
              </div>
              <!-- Privacy -->
              <div class="p-3.5 rounded-lg border" style="background: rgba(127, 109, 242, 0.05); border-color: rgba(127, 109, 242, 0.2);">
                <div class="flex items-start gap-2.5">
                  <svg class="w-4 h-4 mt-0.5 flex-shrink-0" style="color: var(--nc-accent);" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                  <p style="color: var(--nc-muted); line-height: 1.6;"><strong style="color: var(--nc-accent-soft);">Client-encrypted REST storage.</strong> The decryption key is in the <code class="px-1 py-0.5 rounded text-xs" style="background: var(--nc-surface-2); color: var(--nc-accent-soft);">#hash</code> of the URL and is not sent in HTTP requests. Live Yjs text is plaintext to the relay.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- Open in Obsidian -->
      <a
        v-if="obsidianUri"
        :href="obsidianUri"
        class="hidden sm:flex text-xs font-medium transition-all duration-200 items-center gap-2 px-3 py-1.5 rounded-lg flex-shrink-0 hover:-translate-y-0.5"
        style="background: rgba(127, 109, 242, 0.1); color: var(--nc-accent-soft); border: 1px solid rgba(127, 109, 242, 0.2);"
        @mouseenter="($event.target as HTMLElement).style.borderColor = 'rgba(127, 109, 242, 0.4)'"
        @mouseleave="($event.target as HTMLElement).style.borderColor = 'rgba(127, 109, 242, 0.2)'"
      >
        <img src="~/assets/Obsidian_Logo.png" alt="Obsidian" class="w-4 h-4" />
        Open in Obsidian
      </a>
    </div>

    <!-- Sync error banner -->
    <div v-if="syncError" class="flex items-center gap-2 px-4 py-2 text-sm" style="background: rgba(239, 68, 68, 0.1); color: #f87171; border-bottom: 1px solid rgba(239, 68, 68, 0.2);">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
      </svg>
      {{ syncError }}
    </div>

    <!-- Editor area -->
    <div class="flex-1 min-h-0 overflow-hidden">
      <!-- Source mode -->
      <div v-if="mode === 'source'" ref="sourceContainer" class="h-full overflow-auto" />

      <!-- Split mode: side-by-side on desktop, stacked on mobile -->
      <div v-else-if="mode === 'split'" class="flex flex-col md:flex-row h-full split-view">
        <div ref="splitContainer" class="w-full md:w-1/2 h-1/2 md:h-full flex flex-col" style="border-color: var(--nc-border); border-right-width: 1px;" />
        <div ref="splitRenderedContainer" class="w-full md:w-1/2 h-1/2 md:h-full overflow-auto" @click="onRenderedClick" @change="onRenderedChange">
          <div class="markdown-rendered" v-html="renderedHtml" />
        </div>
      </div>

      <!-- Reading mode -->
      <div v-else-if="mode === 'rendered'" class="h-full overflow-auto" @click="onRenderedClick" @change="onRenderedChange">
        <div class="markdown-rendered" v-html="renderedHtml" />
      </div>

      <!-- Link not found dialog -->
      <Teleport to="body">
        <div v-if="showLinkNotFound" class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.6);" @click.self="showLinkNotFound = false">
          <div class="rounded-xl p-6 max-w-sm w-full mx-4" style="background: var(--nc-surface); border: 1px solid var(--nc-border);">
            <div class="flex items-center gap-3 mb-4">
              <div class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style="background: rgba(127, 109, 242, 0.1); border: 1px solid rgba(127, 109, 242, 0.2);">
                <svg class="w-5 h-5" style="color: var(--nc-accent-soft);" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
                  <path stroke-linecap="round" stroke-linejoin="round" d="M14 3v5h5M10 12a2 2 0 114 0c0 1.5-2 1.5-2 3M12 18h.01" />
                </svg>
              </div>
              <div>
                <h3 class="text-base font-semibold" style="color: var(--nc-text);">Note not available</h3>
              </div>
            </div>
            <p class="text-sm mb-5" style="color: var(--nc-muted); line-height: 1.6;">
              <strong style="color: var(--nc-text-2);">{{ linkNotFoundTitle }}</strong> hasn't been shared with you yet, or you haven't opened it before.
            </p>
            <p class="text-xs mb-5" style="color: var(--nc-faint); line-height: 1.5;">
              Ask the note owner to share it. Once you visit a shared note, links to it will work automatically.
            </p>
            <div class="flex gap-2 justify-end">
              <button
                class="px-4 py-2 text-sm rounded-lg transition-colors"
                style="background: var(--nc-border); color: var(--nc-text-2); border: 1px solid var(--nc-border);"
                @click="showLinkNotFound = false"
              >Close</button>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<script setup lang="ts">
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { UndoManager, type Text as YText } from 'yjs'
import { yCollab, ySyncFacet, yUndoManagerKeymap } from 'y-codemirror.next'
import { Compartment, EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import markdownItKatex from '@traptitech/markdown-it-katex'
import markdownItMark from 'markdown-it-mark'
import markdownItTaskLists from 'markdown-it-task-lists'
import { decryptBinary, encryptBinary } from '~/utils/crypto'
import { renderObsidianImageEmbeds } from '~/utils/obsidianEmbeds'
import { loadHighlighter, getHighlighter, isLangLoaded, SHIKI_THEMES } from '~/utils/shiki'
import { codeMirrorThemeExtension, wikiLinkHighlighting } from '~/utils/editorTheme'
import { setTaskCheckedAtLine } from '~/utils/taskCheckbox'
import { editorContentChange } from '~/utils/editorContent'
import type { PresenceRoster } from '~/utils/presence'
import type { Awareness } from 'y-protocols/awareness'

const props = defineProps<{
  mode: 'source' | 'split' | 'rendered'
  content: string
  readOnly?: boolean
  connectionStatus?: 'connected' | 'syncing' | 'disconnected' | null
  syncError?: string | null
  presence?: PresenceRoster | null
  obsidianUri?: string
  extensions?: Extension[]
  collaborationText?: YText | null
  collaborationAwareness?: Awareness | null
  noteTitle?: string
  accessMode?: string
  expiresAt?: string
  shareId?: string
  encryptionKey?: string
  writeCapability?: string
  autoOpenHelp?: boolean
  theme?: 'light' | 'dark'
  showModeSwitcher?: boolean
  showChrome?: boolean
}>()

// Presentation defaults preserve the full editor UI; the shared-note page narrows
// these down for a clean read-only reading experience.
const theme = computed(() => props.theme ?? 'dark')
const showModeSwitcher = computed(() => props.showModeSwitcher ?? true)
const showChrome = computed(() => props.showChrome ?? true)
// The toolbar is only worth showing when it would contain something: editing tools,
// the view-mode switcher, or the connection/status chrome.
const showToolbar = computed(() => !props.readOnly || showModeSwitcher.value || showChrome.value)

const emit = defineEmits<{
  'update:mode': [mode: 'source' | 'split' | 'rendered']
  'update:content': [content: string]
}>()

const modes = [
  { value: 'source' as const, label: 'Source' },
  { value: 'split' as const, label: 'Split' },
  { value: 'rendered' as const, label: 'Reading' },
]

const sourceContainer = ref<HTMLElement>()
const splitContainer = ref<HTMLElement>()
const splitRenderedContainer = ref<HTMLElement>()
let editorView: EditorView | null = null
let editorUndoManager: UndoManager | null = null
const editorTheme = new Compartment()
const editorReadOnly = new Compartment()
const md = new MarkdownIt({ html: true, linkify: true, typographer: true, breaks: true })
md.use(markdownItKatex, { throwOnError: false })
md.use(markdownItMark)
md.use(markdownItTaskLists, { enabled: true, label: true })

// Source line mapping plugin: adds data-source-lines="start,end" to block elements for scroll sync
function sourceMapPlugin(md: MarkdownIt) {
  const origRenderToken = md.renderer.renderToken.bind(md.renderer)
  md.renderer.renderToken = function(tokens: any[], idx: number, options: any) {
    const token = tokens[idx]
    if (token.map && token.nesting === 1) {
      token.attrSet('data-source-lines', `${token.map[0]},${token.map[1]}`)
    }
    return origRenderToken(tokens, idx, options)
  }
  // Also annotate self-contained block tokens (nesting=0) that have their own render rules
  const origFence = md.renderer.rules.fence!
  md.renderer.rules.fence = function(tokens, idx, options, env, self) {
    const token = tokens[idx]!
    let html = origFence(tokens, idx, options, env, self)
    if (token.map) {
      html = html.replace(/^<pre/, `<pre data-source-lines="${token.map[0]},${token.map[1]}"`)
    }
    return html
  }
  const origHtmlBlock = md.renderer.rules.html_block!
  md.renderer.rules.html_block = function(tokens, idx) {
    const token = tokens[idx]!
    let html = token.content
    if (token.map && /^<\w/.test(html)) {
      html = html.replace(/^(<\w+)/, `$1 data-source-lines="${token.map[0]},${token.map[1]}"`)
    }
    return html
  }
}
md.use(sourceMapPlugin)

// Custom callout plugin: transforms blockquotes starting with [!TYPE] into styled callout divs
function calloutPlugin(md: MarkdownIt) {
  const defaultRender = md.renderer.rules.blockquote_open || function(tokens: any, idx: any, options: any, _env: any, self: any) {
    return self.renderToken(tokens, idx, options)
  }
  const defaultCloseRender = md.renderer.rules.blockquote_close || function(tokens: any, idx: any, options: any, _env: any, self: any) {
    return self.renderToken(tokens, idx, options)
  }

  // Track which blockquote_open indices are callouts
  const calloutIndices = new Set<number>()

  md.renderer.rules.blockquote_open = function(tokens, idx, options, env, self) {
    // Look ahead for [!TYPE] pattern in the first inline content of this blockquote
    let depth = 0
    for (let i = idx + 1; i < tokens.length; i++) {
      if (tokens[i]!.type === 'blockquote_open') { depth++; continue }
      if (tokens[i]!.type === 'blockquote_close') {
        if (depth > 0) { depth--; continue }
        break
      }
      if (depth > 0) continue
      if (tokens[i]!.type === 'inline') {
        const match = tokens[i]!.content.match(/^\[!(\w+)\]\s*(.*)/)
        if (match) {
          const type = match[1]!.toLowerCase()
          const customTitle = match[2]?.trim()
          const title = customTitle || type.charAt(0).toUpperCase() + type.slice(1)
          // Strip the [!TYPE] line from content
          tokens[i]!.content = tokens[i]!.content.replace(/^\[!\w+\]\s*.*(\n|$)/, '')
          // Re-parse inline children so plugins (e.g. KaTeX) process the updated content
          tokens[i]!.children = md.parseInline(tokens[i]!.content, {})[0]?.children || []
          calloutIndices.add(idx)
          const icon = calloutIcon(type)
          const mapAttr = tokens[idx]!.map ? ` data-source-lines="${tokens[idx]!.map[0]},${tokens[idx]!.map[1]}"` : ''
          return `<div class="callout callout-${md.utils.escapeHtml(type)}"${mapAttr}><div class="callout-title">${icon}<span>${md.utils.escapeHtml(title)}</span></div><div class="callout-content">`
        }
        break
      }
    }
    return defaultRender(tokens, idx, options, env, self)
  }

  md.renderer.rules.blockquote_close = function(tokens, idx, options, env, self) {
    // Find the matching blockquote_open for this close
    let depth = 0
    for (let i = idx - 1; i >= 0; i--) {
      if (tokens[i]!.type === 'blockquote_close') { depth++; continue }
      if (tokens[i]!.type === 'blockquote_open') {
        if (depth > 0) { depth--; continue }
        // Found our matching open
        if (calloutIndices.has(i)) {
          calloutIndices.delete(i)
          return '</div></div>'
        }
        break
      }
    }
    return defaultCloseRender(tokens, idx, options, env, self)
  }
}

function calloutIcon(type: string): string {
  const icons: Record<string, string> = {
    note: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>',
    tip: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>',
    warning: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>',
    danger: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M5.07 19H19a2 2 0 001.75-2.97l-6.93-12.14a2 2 0 00-3.5 0L3.32 16.03A2 2 0 005.07 19z"/></svg>',
    info: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    example: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>',
    quote: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>',
    abstract: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
    success: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    question: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    bug: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    failure: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
  }
  return icons[type] || icons.note!
}

md.use(calloutPlugin)

// CodeSuite baked-output plugin: renders ```codesuite-output blocks (output that
// CodeSuite serialized into the note) as a styled output panel, so shared notes
// show code *results*, not just the code. The fence body is a single JSON line
// (see CodeSuite's baked-output.ts). Image figures are emitted as
// `data-obsidian-image` placeholders that the existing image loader decrypts and
// fills in, exactly like normal Obsidian image embeds.
function renderBakedOutput(jsonText: string): string {
  let data: any
  try { data = JSON.parse(jsonText.trim()) } catch { data = null }
  // Unknown / malformed → show the raw block so nothing is silently dropped.
  if (!data || data.v !== 1 || typeof data.hash !== 'string') {
    return `<pre class="cs-output-raw"><code>${md.utils.escapeHtml(jsonText)}</code></pre>`
  }
  const esc = md.utils.escapeHtml
  const exit = typeof data.exit === 'number' ? data.exit : null
  const failed = exit !== null && exit !== 0
  const label = esc(typeof data.label === 'string' ? data.label : 'Output')

  let body = ''
  if (data.stdout) body += `<pre class="cs-output-stream cs-output-stdout">${esc(String(data.stdout))}</pre>`
  if (data.stderr) body += `<pre class="cs-output-stream cs-output-stderr">${esc(String(data.stderr))}</pre>`
  if (Array.isArray(data.figures)) {
    for (const fig of data.figures) {
      if (!fig || typeof fig !== 'object') continue
      if (fig.kind === 'image' && typeof fig.file === 'string') {
        // External figure file — same decrypt-and-load path as Obsidian images.
        body += `<img data-obsidian-image="${esc(fig.file)}" alt="${esc(fig.file)}" class="cs-output-img obsidian-image-loading" />`
      } else if (fig.kind === 'image' && typeof fig.data === 'string') {
        // Inlined base64 image (the self-contained escape hatch).
        body += `<img src="data:image/png;base64,${esc(fig.data)}" alt="figure" class="cs-output-img" />`
      } else if (fig.kind === 'widget' && typeof fig.html === 'string') {
        // Interactive widget (e.g. Plotly) — sandboxed iframe, no same-origin access.
        body += `<iframe class="cs-output-widget" sandbox="allow-scripts allow-popups" srcdoc="${esc(fig.html)}"></iframe>`
      }
    }
  }

  const labelCls = failed ? 'cs-output-label cs-output-failed' : 'cs-output-label'
  const bodyHtml = body || '<div class="cs-output-empty">No output</div>'
  return `<div class="cs-output"><div class="cs-output-header">` +
    `<span class="${labelCls}">${label}</span>` +
    `<span class="cs-output-badge">baked</span></div>` +
    `<div class="cs-output-body">${bodyHtml}</div></div>`
}

// Render a normal code block with CodeSuite-style chrome (header + language label
// + copy button) and Shiki syntax highlighting matching CodeSuite. Highlighting
// is synchronous once the highlighter has loaded; until then (and for languages
// we don't bundle) the code renders plain in the same chrome, then re-renders
// highlighted when the highlighter is ready (see `shikiReady`). Line numbers are
// added in CSS via counters on Shiki's `.line` spans.
function renderCodeBlock(code: string, lang: string, map: [number, number] | null): string {
  const esc = md.utils.escapeHtml
  const src = code.replace(/\n$/, '')
  const langLabel = lang || 'text'
  const hl = getHighlighter()

  let bodyHtml: string
  if (hl && lang && isLangLoaded(lang)) {
    try {
      bodyHtml = hl.codeToHtml(src, {
        lang,
        themes: { light: SHIKI_THEMES.light, dark: SHIKI_THEMES.dark },
        defaultColor: false,
      })
    } catch {
      bodyHtml = `<pre class="shiki cs-code-plain"><code>${esc(src)}</code></pre>`
    }
  } else {
    bodyHtml = `<pre class="shiki cs-code-plain"><code>${esc(src)}</code></pre>`
  }

  const srcAttr = map ? ` data-source-lines="${map[0]},${map[1]}"` : ''
  return `<div class="cs-code"${srcAttr}>` +
    `<div class="cs-code-header"><span class="cs-code-lang">${esc(langLabel)}</span>` +
    `<button class="cs-code-copy" type="button" aria-label="Copy code">Copy</button></div>` +
    `<div class="cs-code-body">${bodyHtml}</div></div>`
}

// Own all fence rendering: baked outputs → output panel, everything else →
// highlighted code block. (We render data-source-lines ourselves, matching what
// sourceMapPlugin does for other blocks, so scroll-sync still works.)
function codeBlockPlugin(md: MarkdownIt) {
  md.renderer.rules.fence = function(tokens, idx) {
    const token = tokens[idx]!
    const lang = (token.info || '').trim().split(/\s+/)[0] || ''
    if (lang === 'codesuite-output') return renderBakedOutput(token.content)
    return renderCodeBlock(token.content, lang, token.map as [number, number] | null)
  }
}
md.use(codeBlockPlugin)

// Help modal
const showHelpModal = ref(false)
watchEffect(() => {
  if (props.autoOpenHelp) showHelpModal.value = true
})

// --- Formatting toolbar ---
const showHeadingDropdown = ref(false)
const headingDropdownRef = ref<HTMLElement>()
const headingBtnRef = ref<HTMLButtonElement>()
const headingDropdownMenuRef = ref<HTMLElement>()
const headingDropdownPos = ref({ top: 0, left: 0 })
const imageFileInput = ref<HTMLInputElement>()

function toggleHeadingDropdown() {
  if (!showHeadingDropdown.value) {
    const rect = headingBtnRef.value?.getBoundingClientRect()
    if (rect) headingDropdownPos.value = { top: rect.bottom + 4, left: rect.left }
  }
  showHeadingDropdown.value = !showHeadingDropdown.value
}

// Close heading dropdown on outside click
if (import.meta.client) {
  document.addEventListener('click', (e) => {
    const target = e.target as Node
    const inTrigger = headingDropdownRef.value?.contains(target)
    const inMenu = headingDropdownMenuRef.value?.contains(target)
    if (!inTrigger && !inMenu) showHeadingDropdown.value = false
  })
}

function wrapSelection(before: string, after: string) {
  if (!editorView) return
  const { from, to } = editorView.state.selection.main
  const selected = editorView.state.sliceDoc(from, to)
  // If already wrapped, unwrap
  const docText = editorView.state.doc.toString()
  if (from >= before.length && docText.slice(from - before.length, from) === before && docText.slice(to, to + after.length) === after) {
    editorView.dispatch({ changes: [
      { from: to, to: to + after.length, insert: '' },
      { from: from - before.length, to: from, insert: '' },
    ] })
    editorView.dispatch({ selection: { anchor: from - before.length, head: to - before.length } })
  } else {
    const replacement = before + (selected || 'text') + after
    editorView.dispatch({ changes: { from, to, insert: replacement } })
    editorView.dispatch({ selection: { anchor: from + before.length, head: from + before.length + (selected || 'text').length } })
  }
  editorView.focus()
}

function toggleBold() { wrapSelection('**', '**') }
function toggleItalic() { wrapSelection('*', '*') }
function toggleComment() { wrapSelection('<!-- ', ' -->') }

function setHeading(level: number) {
  if (!editorView) return
  const { from } = editorView.state.selection.main
  const line = editorView.state.doc.lineAt(from)
  const lineText = line.text
  // Remove existing heading prefix
  const stripped = lineText.replace(/^#{1,6}\s*/, '')
  const prefix = '#'.repeat(level) + ' '
  editorView.dispatch({ changes: { from: line.from, to: line.to, insert: prefix + stripped } })
  editorView.focus()
}

function removeHeading() {
  if (!editorView) return
  const { from } = editorView.state.selection.main
  const line = editorView.state.doc.lineAt(from)
  const stripped = line.text.replace(/^#{1,6}\s*/, '')
  editorView.dispatch({ changes: { from: line.from, to: line.to, insert: stripped } })
  editorView.focus()
}

function triggerImageUpload() {
  imageFileInput.value?.click()
}

async function onImageFileSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) await uploadAndInsertImage(file)
  input.value = ''
}

async function uploadAndInsertImage(file: File) {
  if (!editorView || !props.shareId || !props.encryptionKey) return

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const ext = file.name.split('.').pop() || 'png'
  const filename = `Pasted image ${timestamp}.${ext}`

  // Encrypt and upload
  const buffer = await file.arrayBuffer()
  const encrypted = await encryptBinary(buffer, props.encryptionKey)

  const { apiKey } = await api.ensureRegistered()
  await fetch(`${api.baseUrl}/api/v1/notes/${encodeURIComponent(props.shareId)}/images`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(props.writeCapability ? { 'X-NoteColab-Write-Token': props.writeCapability } : {}),
    },
    body: JSON.stringify({ filename, encryptedData: encrypted, mimeType: file.type || 'image/png' }),
  })

  // Insert the image reference at cursor
  const pos = editorView.state.selection.main.head
  const imageRef = `![[${filename}]]`
  editorView.dispatch({ changes: { from: pos, insert: imageRef } })
  editorView.focus()
}

// Strip YAML frontmatter from content
function stripFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  return match ? text.slice(match[0].length) : text
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Apply Obsidian → web syntax conversions to a chunk of NON-code text.
function transformObsidianInline(text: string): string {
  // Remove Dataview inline expressions (= this.file.xxx)
  text = text.replace(/^= .+$/gm, '')
  // Convert ![[image|width]] to img placeholder with data attributes
  text = renderObsidianImageEmbeds(text)
  // Convert ![[embed]] (non-image) to clickable embed placeholder
  text = text.replace(/!\[\[([^\]]+)\]\]/g, (_m, ref) => {
    const safe = escapeHtmlAttr(ref)
    // Split on # to get note title and optional section
    const [noteTitle, ...rest] = ref.split('#')
    const section = rest.length ? '#' + rest.join('#') : ''
    const display = section ? `${noteTitle} › ${rest.join(' › ')}` : noteTitle
    return `<div class="embed-placeholder" data-note-title="${escapeHtmlAttr(noteTitle.trim())}" data-embed-ref="${safe}"><span class="embed-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg></span><span class="embed-label">Embedded note</span><span class="embed-title">${escapeHtmlAttr(display)}</span></div>`
  })
  // Convert [[link|display]] to clickable wiki link
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_m, target, display) => {
    return `<a class="wiki-link" data-note-title="${escapeHtmlAttr(target.trim())}">${escapeHtmlAttr(display)}</a>`
  })
  // Convert [[link]] to clickable wiki link
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_m, target) => {
    return `<a class="wiki-link" data-note-title="${escapeHtmlAttr(target.trim())}">${escapeHtmlAttr(target)}</a>`
  })
  return text
}

// Clean Obsidian-specific syntax for web rendering. Fenced code blocks are left
// untouched — their contents are literal, and baked codesuite-output blocks carry
// JSON that must reach the codesuite-output renderer intact (rewriting a stray
// [[..]] or ![[..]] inside that JSON would corrupt it).
function cleanObsidianSyntax(text: string): string {
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  return text.split('\n').map((line) => {
    if (!inFence) {
      const open = /^(\s*)(`{3,}|~{3,})/.exec(line)
      if (open) {
        const marker = open[2] ?? ''
        inFence = true
        fenceChar = marker.charAt(0)
        fenceLen = marker.length
        return line
      }
      return transformObsidianInline(line)
    }
    // Inside a fence: a bare same-char fence of >= length closes it.
    if (new RegExp(`^\\s*\\${fenceChar}{${fenceLen},}\\s*$`).test(line)) inFence = false
    return line
  }).join('\n')
}

// Compute how many lines the frontmatter occupies (for source line mapping)
const frontmatterOffset = computed(() => {
  const match = props.content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return 0
  return (match[0].match(/\n/g) || []).length
})

const strippedContent = computed(() => cleanObsidianSyntax(stripFrontmatter(props.content)))
// Bumped once Shiki finishes loading so code blocks re-render highlighted.
const shikiReady = ref(false)
const renderedHtml = computed(() => {
  void shikiReady.value // re-render when syntax highlighting becomes available
  // The note body is decrypted client-side (the AES key lives in the URL
  // fragment and is never sent to the server), so there is nothing to render
  // server-side. Sanitize the rendered HTML on the client before it is injected
  // via v-html: the body is authored by whoever created the share and is
  // untrusted to the viewer, and markdown-it runs with html:true, so raw
  // <script>/onerror/javascript: would otherwise execute in our origin. DOMPurify
  // keeps the data-*/class attributes and delegated-listener markup the viewer
  // relies on while stripping active content.
  if (!import.meta.client) return ''
  const html = DOMPurify.sanitize(md.render(strippedContent.value), { ADD_ATTR: ['target'] })
  if (!props.readOnly) return html
  return html.replaceAll(
    '<input class="task-list-item-checkbox"',
    '<input class="task-list-item-checkbox" disabled',
  )
})
onMounted(async () => {
  try {
    await loadHighlighter()
    shikiReady.value = true
  } catch (e) {
    console.warn('CodeSuite highlighter failed to load; code blocks stay plain.', e)
  }
})

// Copy-to-clipboard for code blocks. The rendered HTML is injected via v-html, so
// listeners are wired here after each render (idempotent via the data-wired flag).
function wireCodeBlocks(container: HTMLElement) {
  for (const btn of container.querySelectorAll<HTMLButtonElement>('.cs-code-copy')) {
    if (btn.dataset.wired === '1') continue
    btn.dataset.wired = '1'
    btn.addEventListener('click', () => {
      const body = btn.closest('.cs-code')?.querySelector('.cs-code-body')
      const text = (body?.textContent ?? '').replace(/\n$/, '')
      void navigator.clipboard.writeText(text).then(() => {
        const prev = btn.textContent
        btn.textContent = 'Copied'
        setTimeout(() => { btn.textContent = prev }, 1500)
      })
    })
  }
}

// Cache for decrypted image blob URLs
const imageBlobUrls = new Map<string, string>()
const api = useApi()

// Load and decrypt images after the rendered HTML is mounted/updated
async function loadImages(container: HTMLElement | undefined) {
  if (!container || !props.shareId || !props.encryptionKey) return

  const imgs = container.querySelectorAll<HTMLImageElement>('img[data-obsidian-image]')
  const pendingLoads: Promise<void>[] = []
  for (const img of imgs) {
    const filename = img.getAttribute('data-obsidian-image')
    if (!filename) continue

    // Check cache first
    if (imageBlobUrls.has(filename)) {
      const p = new Promise<void>(resolve => {
        if (img.complete) { resolve(); return }
        img.onload = () => resolve()
        img.onerror = () => resolve()
      })
      img.src = imageBlobUrls.get(filename)!
      img.classList.remove('obsidian-image-loading')
      pendingLoads.push(p)
      continue
    }

    try {
      const { apiKey } = await api.ensureRegistered()
      const res = await fetch(
        `${api.baseUrl}/api/v1/notes/${encodeURIComponent(props.shareId)}/images/${encodeURIComponent(filename)}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
      )
      if (!res.ok) continue
      const data = await res.json()
      const decrypted = await decryptBinary(data.encryptedData, props.encryptionKey!)
      const blob = new Blob([decrypted], { type: data.mimeType })
      const url = URL.createObjectURL(blob)
      imageBlobUrls.set(filename, url)
      const p = new Promise<void>(resolve => {
        img.onload = () => resolve()
        img.onerror = () => resolve()
      })
      img.src = url
      img.classList.remove('obsidian-image-loading')
      pendingLoads.push(p)
    } catch (e) {
      console.warn(`Failed to load image ${filename}:`, e)
    }
  }
  // Wait for all images to decode and be laid out before rebuilding line maps
  if (pendingLoads.length > 0) {
    await Promise.all(pendingLoads)
  }
  // Give browser a frame to update layout with new image dimensions
  await new Promise(resolve => requestAnimationFrame(resolve))
  buildRenderedLineMap()
}

// Watch for content/mode changes and load images
const renderedContainer = ref<HTMLElement>()

watch([renderedHtml, () => props.mode], () => {
  nextTick(() => {
    // Find the rendered container in the DOM
    const el = document.querySelector('.markdown-rendered') as HTMLElement | undefined
    if (el) loadImages(el)
    // Wire copy buttons on every rendered container (split shows two).
    for (const c of document.querySelectorAll<HTMLElement>('.markdown-rendered')) wireCodeBlocks(c)
  })
}, { flush: 'post', immediate: true })

const accessModeLabel = computed(() => {
  switch (props.accessMode) {
    case 'public_edit': return 'Editable link'
    case 'invited_edit': return 'Invited collaborators'
    case 'read_only': return 'View-only link'
    default: return props.accessMode
  }
})

const expiresLabel = computed(() => {
  if (!props.expiresAt) return ''
  const d = new Date(props.expiresAt)
  const now = new Date()
  const diff = d.getTime() - now.getTime()
  if (diff < 0) return 'expired'
  if (diff < 3600000) return `in ${Math.ceil(diff / 60000)}m`
  if (diff < 86400000) return `in ${Math.ceil(diff / 3600000)}h`
  return `in ${Math.ceil(diff / 86400000)}d`
})

function readOnlyExtensions() {
  return [
    EditorState.readOnly.of(Boolean(props.readOnly)),
    keymap.of(props.readOnly ? [] : [...defaultKeymap, ...(props.collaborationText ? yUndoManagerKeymap : historyKeymap)]),
  ]
}

function buildExtensions() {
  return [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    wikiLinkHighlighting,
    editorTheme.of(codeMirrorThemeExtension(theme.value)),
    EditorView.lineWrapping,
    highlightActiveLine(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        emit('update:content', update.state.doc.toString())
      }
    }),
    // Input handlers
    EditorView.domEventHandlers({
      beforeinput(event, view) {
        if (view.state.readOnly && (event.inputType === 'historyUndo' || event.inputType === 'historyRedo')) {
          event.preventDefault()
          return true
        }
        return false
      },
      paste(event) {
        if (props.readOnly) return false
        const items = event.clipboardData?.items
        if (!items) return false
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            event.preventDefault()
            const file = item.getAsFile()
            if (file) uploadAndInsertImage(file)
            return true
          }
        }
        return false
      },
    }),
    editorReadOnly.of(readOnlyExtensions()),
    ...(props.collaborationText ? [yCollab(props.collaborationText, props.collaborationAwareness ?? null, { undoManager: editorUndoManager! })] : [history()]),
    ...(props.extensions || []),
  ]
}

function createEditor(container: HTMLElement) {
  editorUndoManager = props.collaborationText ? new UndoManager(props.collaborationText) : null
  editorView = new EditorView({
    state: EditorState.create({
      doc: props.collaborationText?.toString() ?? props.content,
      extensions: buildExtensions(),
    }),
    parent: container,
  })
  // Attach scroll sync listener to CM's internal scroll element
  editorView.scrollDOM.addEventListener('scroll', onSourceScroll, { passive: true })
}

function destroyEditor() {
  if (editorView) {
    editorView.scrollDOM.removeEventListener('scroll', onSourceScroll)
    const syncConfig = editorView.state.facet(ySyncFacet)
    editorView.destroy()
    syncConfig?.undoManager.destroy()
    editorUndoManager?.destroy()
    editorUndoManager = null
    editorView = null
  }
}

defineExpose({
  getEditorView: () => editorView,
})

// Recreate editor when mode changes or container refs become available
watch(
  [() => props.mode, () => props.collaborationText, sourceContainer, splitContainer],
  () => {
    nextTick(() => {
      destroyEditor()
      if (props.mode === 'source' && sourceContainer.value) {
        createEditor(sourceContainer.value)
      } else if (props.mode === 'split' && splitContainer.value) {
        createEditor(splitContainer.value)
      }
    })
  },
  { immediate: true }
)

watch(theme, (nextTheme) => {
  editorView?.dispatch({
    effects: editorTheme.reconfigure(codeMirrorThemeExtension(nextTheme)),
  })
})

watch(() => props.readOnly, () => {
  editorView?.dispatch({ effects: editorReadOnly.reconfigure(readOnlyExtensions()) })
})

// Bound editors receive Yjs transactions directly. Props only drive the preview.
watch(() => props.content, (newContent) => {
  if (props.collaborationText) return
  if (editorView) {
    const current = editorView.state.doc.toString()
    if (current !== newContent) {
      editorView.dispatch({
        changes: editorContentChange(current, newContent),
      })
    }
  }
})

onBeforeUnmount(() => {
  destroyEditor()
  // Remove rendered scroll listener
  splitRenderedContainer.value?.removeEventListener('scroll', onRenderedScroll)
  splitRenderedContainer.value?.removeEventListener('mouseup', onRenderedMouseUp)
  resizeObserver?.disconnect()
  // Revoke blob URLs
  for (const url of imageBlobUrls.values()) {
    URL.revokeObjectURL(url)
  }
  imageBlobUrls.clear()
})

// --- Line-mapped scroll sync for split mode ---
let isScrollSyncing = false
let renderedLineMap: Array<{line: number, top: number}> = []

function buildRenderedLineMap() {
  const container = splitRenderedContainer.value
  if (!container) { renderedLineMap = []; return }
  const elements = container.querySelectorAll('[data-source-lines]')
  const map: Array<{line: number, top: number}> = []
  const seen = new Set<number>()
  const containerRect = container.getBoundingClientRect()
  for (const el of elements) {
    const attr = el.getAttribute('data-source-lines')
    if (!attr) continue
    const startLine = attr.split(',').map(Number)[0]!
    if (seen.has(startLine)) continue
    seen.add(startLine)
    const rect = (el as HTMLElement).getBoundingClientRect()
    map.push({ line: startLine, top: rect.top - containerRect.top + container.scrollTop })
  }
  map.sort((a, b) => a.line - b.line)
  renderedLineMap = map
}

// Get fresh source-side anchor positions from CM6 (avoids stale cached values)
function getFreshAnchorPairs(): { sourceAnchors: number[], renderedAnchors: number[] } {
  if (!editorView || renderedLineMap.length === 0) return { sourceAnchors: [], renderedAnchors: [] }
  const doc = editorView.state.doc
  const sourceAnchors: number[] = []
  const renderedAnchors: number[] = []
  for (const entry of renderedLineMap) {
    const cmLine = Math.max(1, Math.min(entry.line + frontmatterOffset.value + 1, doc.lines))
    const block = editorView.lineBlockAt(doc.line(cmLine).from)
    sourceAnchors.push(block.top)
    renderedAnchors.push(entry.top)
  }
  return { sourceAnchors, renderedAnchors }
}

// Piecewise linear interpolation between anchor arrays
function interpolateScroll(
  scrollPos: number,
  fromAnchors: number[],
  toAnchors: number[],
  fromMax: number,
  toMax: number
): number {
  if (fromAnchors.length === 0 || toAnchors.length === 0) {
    return fromMax > 0 ? (scrollPos / fromMax) * toMax : 0
  }
  // Before first anchor
  if (scrollPos <= fromAnchors[0]!) {
    return fromAnchors[0]! > 0 ? (scrollPos / fromAnchors[0]!) * toAnchors[0]! : 0
  }
  // After last anchor — ensures both panes reach bottom together
  const lastIdx = fromAnchors.length - 1
  if (scrollPos >= fromAnchors[lastIdx]!) {
    const remaining = fromMax - fromAnchors[lastIdx]!
    if (remaining > 0) {
      const t = (scrollPos - fromAnchors[lastIdx]!) / remaining
      return toAnchors[lastIdx]! + t * (toMax - toAnchors[lastIdx]!)
    }
    return toMax
  }
  // Between anchors — binary search for the segment
  let lo = 0, hi = fromAnchors.length - 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (fromAnchors[mid + 1]! < scrollPos) lo = mid + 1
    else hi = mid
  }
  const segLen = fromAnchors[lo + 1]! - fromAnchors[lo]!
  const t = segLen > 0 ? (scrollPos - fromAnchors[lo]!) / segLen : 0
  return toAnchors[lo]! + t * (toAnchors[lo + 1]! - toAnchors[lo]!)
}

function onSourceScroll() {
  if (isScrollSyncing || !editorView) return
  const rendered = splitRenderedContainer.value
  if (!rendered) return
  const { sourceAnchors, renderedAnchors } = getFreshAnchorPairs()
  const sourceMax = editorView.scrollDOM.scrollHeight - editorView.scrollDOM.clientHeight
  const renderedMax = rendered.scrollHeight - rendered.clientHeight
  if (sourceMax <= 0) return
  isScrollSyncing = true
  const target = interpolateScroll(
    editorView.scrollDOM.scrollTop, sourceAnchors, renderedAnchors, sourceMax, renderedMax
  )
  rendered.scrollTop = Math.max(0, Math.min(target, renderedMax))
  requestAnimationFrame(() => { isScrollSyncing = false })
}

function onRenderedScroll() {
  if (isScrollSyncing || !editorView) return
  const rendered = splitRenderedContainer.value
  if (!rendered) return
  const { sourceAnchors, renderedAnchors } = getFreshAnchorPairs()
  const sourceMax = editorView.scrollDOM.scrollHeight - editorView.scrollDOM.clientHeight
  const renderedMax = rendered.scrollHeight - rendered.clientHeight
  if (renderedMax <= 0) return
  isScrollSyncing = true
  const target = interpolateScroll(
    rendered.scrollTop, renderedAnchors, sourceAnchors, renderedMax, sourceMax
  )
  editorView.scrollDOM.scrollTop = Math.max(0, Math.min(target, sourceMax))
  requestAnimationFrame(() => { isScrollSyncing = false })
}

// Rebuild rendered line map when content or mode changes
watch([renderedHtml, () => props.mode], () => {
  if (props.mode === 'split') {
    nextTick(() => { buildRenderedLineMap() })
  }
}, { flush: 'post' })

// Rebuild on container resize (window resize, panel drag, etc.)
let resizeObserver: ResizeObserver | null = null

// Attach rendered-side listeners when the container appears
watch(splitRenderedContainer, (rend) => {
  if (rend) {
    rend.addEventListener('scroll', onRenderedScroll, { passive: true })
    rend.addEventListener('mouseup', onRenderedMouseUp)
    nextTick(() => { buildRenderedLineMap() })
    // Delayed rebuild to catch late layout changes (font loading, async CSS)
    setTimeout(() => { buildRenderedLineMap() }, 500)
    // Observe size changes
    resizeObserver?.disconnect()
    resizeObserver = new ResizeObserver(() => { buildRenderedLineMap() })
    resizeObserver.observe(rend)
  }
}, { immediate: true })

// --- Wiki link and embed click handling ---
const showLinkNotFound = ref(false)
const linkNotFoundTitle = ref('')

function onWikiLinkClick(e: MouseEvent) {
  const target = (e.target as HTMLElement).closest('.wiki-link, .embed-placeholder') as HTMLElement
  if (!target) return
  e.preventDefault()
  e.stopPropagation()
  const noteTitle = target.getAttribute('data-note-title')
  if (!noteTitle) return

  // Check recent notes cache for a matching title
  const recentUrl = findRecentNoteUrlByTitle(noteTitle)
  if (recentUrl) {
    window.location.href = recentUrl
    return
  }

  // Not found — show dialog
  linkNotFoundTitle.value = noteTitle
  showLinkNotFound.value = true
}

function onRenderedClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.wiki-link') || target.closest('.embed-placeholder')) {
    onWikiLinkClick(e)
  }
}

function onRenderedChange(e: Event) {
  if (props.readOnly) return
  const checkbox = e.target
  if (!(checkbox instanceof HTMLInputElement) || !checkbox.classList.contains('task-list-item-checkbox')) return

  const item = checkbox.closest<HTMLElement>('li[data-source-lines]')
  const sourceStart = Number(item?.dataset.sourceLines?.split(',')[0])
  if (!Number.isInteger(sourceStart)) return

  const updated = setTaskCheckedAtLine(
    props.collaborationText?.toString() ?? props.content,
    sourceStart + frontmatterOffset.value,
    checkbox.checked,
  )
  if (updated === null) return
  if (props.collaborationText) {
    const text = props.collaborationText
    const change = editorContentChange(text.toString(), updated)
    text.doc?.transact(() => {
      if (change.to > change.from) text.delete(change.from, change.to - change.from)
      if (change.insert) text.insert(change.from, change.insert)
    })
  } else {
    emit('update:content', updated)
  }
}

// --- Click-to-sync: select text in rendered pane → select in source ---
function onRenderedMouseUp() {
  if (!editorView) return
  // Short delay so browser finalizes the selection
  setTimeout(() => {
    const sel = window.getSelection()
    const selectedText = sel?.toString()
    if (!selectedText || !selectedText.trim()) return

    // Walk up from anchor node to find closest data-source-lines element
    let node: Node | null = sel!.anchorNode
    let mappedEl: HTMLElement | null = null
    while (node && node !== splitRenderedContainer.value) {
      if (node instanceof HTMLElement && node.hasAttribute('data-source-lines')) {
        mappedEl = node; break
      }
      node = node.parentNode
    }
    // Also check focus node for a wider range
    let mappedEl2: HTMLElement | null = null
    node = sel!.focusNode
    while (node && node !== splitRenderedContainer.value) {
      if (node instanceof HTMLElement && node.hasAttribute('data-source-lines')) {
        mappedEl2 = node; break
      }
      node = node.parentNode
    }

    if (!mappedEl && !mappedEl2) return
    const parseLines = (el: HTMLElement) => {
      const attr = el.getAttribute('data-source-lines')
      if (!attr) return null
      const [s, e] = attr.split(',').map(Number)
      return { start: s, end: e }
    }
    const range1 = mappedEl ? parseLines(mappedEl) : null
    const range2 = mappedEl2 ? parseLines(mappedEl2) : null
    const startLine = Math.min(range1?.start ?? Infinity, range2?.start ?? Infinity)
    const endLine = Math.max(range1?.end ?? 0, range2?.end ?? 0)
    if (!isFinite(startLine) || endLine === 0) return

    // Convert to CM coordinates
    const doc = editorView!.state.doc
    const cmStart = Math.max(1, startLine + frontmatterOffset.value + 1)
    const cmEnd = Math.min(doc.lines, endLine + frontmatterOffset.value)
    const searchFrom = doc.line(cmStart).from
    const searchTo = doc.line(cmEnd).to
    const sourceText = doc.sliceString(searchFrom, searchTo)

    // Find the selected text in the source range
    const needle = selectedText.trim()
    const idx = sourceText.indexOf(needle)
    if (idx !== -1) {
      const from = searchFrom + idx
      const to = from + needle.length
      editorView!.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      })
      editorView!.focus()
    }
  }, 20)
}
</script>

<style>
.nc-note-editor {
  --nc-bg: var(--md-canvas);
  --nc-surface: var(--md-subtle-bg);
  --nc-border: var(--md-border);
}

.nc-note-header,
.nc-editor-toolbar {
  background: var(--nc-bg);
}

.nc-editor-toolbar {
  min-height: 48px;
}

.nc-view-tab {
  color: var(--nc-muted);
  border-color: transparent;
}

.nc-view-tab:hover {
  color: var(--nc-text);
  background: var(--nc-surface);
}

.nc-view-tab.is-active {
  color: var(--nc-text);
  border-color: var(--nc-accent);
  background: transparent;
}

/* Make CodeMirror fill its container in split mode */
.split-view .cm-editor {
  flex: 1 1 0% !important;
  min-height: 0 !important;
  overflow: hidden !important;
}
.split-view .cm-editor .cm-scroller {
  overflow: auto;
}

/* GitHub dark-mode inspired markdown rendering — in component <style> to bypass Tailwind's PostCSS processing */
.markdown-rendered {
  font-size: 16px;
  line-height: 1.7;
  word-wrap: break-word;
  max-width: 48rem;
  margin: 0 auto;
  padding: 2rem 3rem;
  color: var(--md-text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
}

.markdown-rendered h1,
.markdown-rendered h2,
.markdown-rendered h3,
.markdown-rendered h4,
.markdown-rendered h5,
.markdown-rendered h6 {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--md-text);
}

.markdown-rendered h1 {
  font-size: 2em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--md-border);
}

.markdown-rendered h2 {
  font-size: 1.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--md-border);
}

.markdown-rendered h3 { font-size: 1.25em; }
.markdown-rendered h4 { font-size: 1em; }
.markdown-rendered h5 { font-size: 0.875em; }
.markdown-rendered h6 { font-size: 0.85em; color: var(--md-muted); }

.markdown-rendered p {
  margin-top: 0;
  margin-bottom: 16px;
}

.markdown-rendered ul,
.markdown-rendered ol {
  margin-top: 0;
  margin-bottom: 16px;
  padding-left: 2em;
}

.markdown-rendered ul { list-style-type: disc; }
.markdown-rendered ol { list-style-type: decimal; }

.markdown-rendered li {
  margin-bottom: 4px;
}

.markdown-rendered li + li {
  margin-top: 4px;
}

.markdown-rendered li > ul,
.markdown-rendered li > ol {
  margin-top: 4px;
  margin-bottom: 0;
}

.markdown-rendered blockquote {
  margin: 0 0 16px;
  padding: 0 1em;
  color: var(--md-muted);
  border-left: 0.25em solid var(--md-border);
}

.markdown-rendered blockquote > :first-child { margin-top: 0; }
.markdown-rendered blockquote > :last-child { margin-bottom: 0; }

.markdown-rendered code {
  padding: 0.2em 0.4em;
  margin: 0;
  font-size: 85%;
  white-space: break-spaces;
  background-color: var(--md-code-bg);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  color: var(--md-text);
}

.markdown-rendered pre {
  margin-top: 0;
  margin-bottom: 16px;
  padding: 16px;
  overflow: auto;
  font-size: 85%;
  line-height: 1.45;
  background-color: var(--md-subtle-bg);
  border-radius: 6px;
  border: 1px solid var(--md-border);
}

.markdown-rendered pre code {
  padding: 0;
  margin: 0;
  font-size: 100%;
  white-space: pre;
  background: transparent;
  border: 0;
  color: var(--md-text);
}

.markdown-rendered a {
  color: var(--md-link);
  text-decoration: none;
}

.markdown-rendered a:hover {
  text-decoration: underline;
}

.markdown-rendered strong {
  font-weight: 600;
  color: var(--md-text);
}

.markdown-rendered em {
  font-style: italic;
  color: var(--md-text);
}

.markdown-rendered hr {
  height: 0.25em;
  padding: 0;
  margin: 24px 0;
  background-color: var(--md-border);
  border: 0;
}

.markdown-rendered table {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
  border-spacing: 0;
  border-collapse: collapse;
  margin-top: 0;
  margin-bottom: 16px;
}

.markdown-rendered th {
  font-weight: 600;
  padding: 6px 13px;
  border: 1px solid var(--md-border);
  background-color: var(--md-table-head);
  color: var(--md-text);
}

.markdown-rendered td {
  padding: 6px 13px;
  border: 1px solid var(--md-border);
}

.markdown-rendered tr {
  background-color: var(--md-canvas);
  border-top: 1px solid var(--md-border);
}

.markdown-rendered tr:nth-child(2n) {
  background-color: var(--md-subtle-bg);
}

.markdown-rendered img {
  max-width: 100%;
  border-radius: 6px;
  margin: 8px 0;
  display: block;
}

/* CodeSuite baked outputs — ```codesuite-output blocks rendered as result panels */
.markdown-rendered .cs-output {
  margin: 0 0 16px;
  border: 1px solid var(--md-border);
  border-radius: 6px;
  overflow: hidden;
  background-color: var(--md-canvas);
}
.markdown-rendered .cs-output-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  background-color: var(--md-table-head);
  border-bottom: 1px solid var(--md-border);
}
.markdown-rendered .cs-output-label {
  flex: 1;
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--md-muted);
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}
.markdown-rendered .cs-output-label.cs-output-failed { color: #f85149; }
.markdown-rendered .cs-output-badge {
  flex: 0 0 auto;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--md-muted);
  border: 1px solid var(--md-border);
}
.markdown-rendered .cs-output-body { padding: 0; }
.markdown-rendered .cs-output-stream {
  margin: 0;
  padding: 10px 14px;
  border: 0;
  border-radius: 0;
  background: transparent;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 85%;
  line-height: 1.5;
}
.markdown-rendered .cs-output-stderr { color: #fe8019; }
.markdown-rendered .cs-output-empty {
  padding: 10px 14px;
  color: var(--md-muted);
  font-style: italic;
  font-size: 85%;
}
.markdown-rendered .cs-output-img {
  max-width: 100%;
  margin: 8px 14px;
  border-radius: 4px;
}
.markdown-rendered .cs-output-widget {
  width: 100%;
  min-height: 420px;
  border: 0;
  background: #fff;
}
.markdown-rendered .cs-output-raw { opacity: 0.7; }

/* ─── CodeSuite-style code blocks (Shiki highlighting + chrome) ─────────────── */
.markdown-rendered .cs-code {
  margin: 0 0 16px;
  border: 1px solid var(--md-border);
  border-radius: 6px;
  overflow: hidden;
  background-color: var(--md-subtle-bg);
}
.markdown-rendered .cs-code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px 4px 12px;
  background-color: var(--md-table-head);
  border-bottom: 1px solid var(--md-border);
}
.markdown-rendered .cs-code-lang {
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--md-muted);
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}
.markdown-rendered .cs-code-copy {
  font-size: 11px;
  color: var(--md-muted);
  background: transparent;
  border: 1px solid var(--md-border);
  border-radius: 4px;
  padding: 1px 8px;
  cursor: pointer;
  line-height: 1.6;
}
.markdown-rendered .cs-code-copy:hover { color: var(--md-text); border-color: var(--md-muted); }
.markdown-rendered .cs-code-body { overflow: auto; }

/* Reset Shiki's <pre> inside our chrome (override the generic .markdown-rendered pre) */
.markdown-rendered .cs-code-body .shiki {
  margin: 0;
  border: 0;
  border-radius: 0;
  padding: 10px 0;
  background-color: transparent !important;
  font-size: 85%;
  line-height: 1.5;
  counter-reset: cs-line;
}
.markdown-rendered .cs-code-body .shiki code { display: block; width: max-content; min-width: 100%; }
.markdown-rendered .cs-code-body .shiki .line {
  counter-increment: cs-line;
  padding-right: 16px;
}
.markdown-rendered .cs-code-body .shiki .line::before {
  content: counter(cs-line);
  display: inline-block;
  width: 2.5em;
  margin-right: 1em;
  padding-left: 12px;
  text-align: right;
  color: var(--md-muted);
  opacity: 0.45;
  user-select: none;
}
/* Plain fallback (highlighter not ready / unknown language): chrome, no line numbers */
.markdown-rendered .cs-code-body .cs-code-plain {
  padding: 12px 16px;
  white-space: pre;
  color: var(--md-text);
}
.markdown-rendered .cs-code-body .cs-code-plain code { color: var(--md-text); }

/* Dual-theme colour selection. Shiki (defaultColor:false) emits --shiki-dark /
   --shiki-light per token; dark is the viewer default, .nc-light flips to light —
   riding the same class the rest of the viewer uses, with no re-render. */
.markdown-rendered .shiki,
.markdown-rendered .shiki span { color: var(--shiki-dark); }
.nc-light .markdown-rendered .shiki,
.nc-light .markdown-rendered .shiki span { color: var(--shiki-light); }

.markdown-rendered mark {
  background: var(--md-mark-bg);
  color: var(--md-text);
  padding: 0.1em 0.3em;
  border-radius: 3px;
}

.markdown-rendered .task-list-item {
  list-style-type: none;
  position: relative;
}

.markdown-rendered .task-list-item-checkbox {
  appearance: none;
  width: 18px;
  height: 18px;
  border: 2px solid var(--md-checkbox-border);
  border-radius: 4px;
  background: transparent;
  vertical-align: middle;
  margin-right: 8px;
  margin-left: -24px;
  position: relative;
  cursor: pointer;
}

.markdown-rendered .task-list-item-checkbox:disabled {
  cursor: default;
  pointer-events: none;
}

.markdown-rendered .task-list-item-checkbox:checked {
  background: var(--nc-accent);
  border-color: var(--nc-accent);
}

.markdown-rendered .task-list-item-checkbox:checked::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 1px;
  width: 5px;
  height: 10px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.markdown-rendered details {
  margin-top: 0;
  margin-bottom: 16px;
}

.markdown-rendered details summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--md-text);
}

.markdown-rendered details summary:hover {
  color: var(--md-link);
}

@media (max-width: 640px) {
  .markdown-rendered {
    padding: 1rem 1.25rem;
    font-size: 15px;
  }
  .markdown-rendered h1 { font-size: 1.6em; }
  .markdown-rendered h2 { font-size: 1.3em; }
  .markdown-rendered pre { padding: 12px; font-size: 80%; }
}

/* Callout styles — Obsidian-compatible */
.markdown-rendered .callout {
  margin: 0 0 16px;
  border-radius: 6px;
  border: 1px solid;
  overflow: hidden;
}

.markdown-rendered .callout-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-weight: 600;
  font-size: 0.9em;
}

.markdown-rendered .callout-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.markdown-rendered .callout-content {
  padding: 4px 12px 12px;
}

.markdown-rendered .callout-content > :first-child { margin-top: 0; }
.markdown-rendered .callout-content > :last-child { margin-bottom: 0; }

/* Callout color variants */
.markdown-rendered .callout-note { background: rgba(68, 138, 255, 0.08); border-color: rgba(68, 138, 255, 0.3); }
.markdown-rendered .callout-note .callout-title { color: #448aff; }
.markdown-rendered .callout-note .callout-icon { color: #448aff; }

.markdown-rendered .callout-abstract { background: rgba(0, 176, 255, 0.08); border-color: rgba(0, 176, 255, 0.3); }
.markdown-rendered .callout-abstract .callout-title { color: #00b0ff; }
.markdown-rendered .callout-abstract .callout-icon { color: #00b0ff; }

.markdown-rendered .callout-info { background: rgba(0, 176, 255, 0.08); border-color: rgba(0, 176, 255, 0.3); }
.markdown-rendered .callout-info .callout-title { color: #00b0ff; }
.markdown-rendered .callout-info .callout-icon { color: #00b0ff; }

.markdown-rendered .callout-tip,
.markdown-rendered .callout-hint,
.markdown-rendered .callout-important { background: rgba(0, 191, 165, 0.08); border-color: rgba(0, 191, 165, 0.3); }
.markdown-rendered .callout-tip .callout-title,
.markdown-rendered .callout-hint .callout-title,
.markdown-rendered .callout-important .callout-title { color: #00bfa5; }
.markdown-rendered .callout-tip .callout-icon,
.markdown-rendered .callout-hint .callout-icon,
.markdown-rendered .callout-important .callout-icon { color: #00bfa5; }

.markdown-rendered .callout-success,
.markdown-rendered .callout-check,
.markdown-rendered .callout-done { background: rgba(0, 200, 83, 0.08); border-color: rgba(0, 200, 83, 0.3); }
.markdown-rendered .callout-success .callout-title,
.markdown-rendered .callout-check .callout-title,
.markdown-rendered .callout-done .callout-title { color: #00c853; }
.markdown-rendered .callout-success .callout-icon,
.markdown-rendered .callout-check .callout-icon,
.markdown-rendered .callout-done .callout-icon { color: #00c853; }

.markdown-rendered .callout-question,
.markdown-rendered .callout-help,
.markdown-rendered .callout-faq { background: rgba(255, 145, 0, 0.08); border-color: rgba(255, 145, 0, 0.3); }
.markdown-rendered .callout-question .callout-title,
.markdown-rendered .callout-help .callout-title,
.markdown-rendered .callout-faq .callout-title { color: #ff9100; }
.markdown-rendered .callout-question .callout-icon,
.markdown-rendered .callout-help .callout-icon,
.markdown-rendered .callout-faq .callout-icon { color: #ff9100; }

.markdown-rendered .callout-warning,
.markdown-rendered .callout-caution,
.markdown-rendered .callout-attention { background: rgba(255, 145, 0, 0.08); border-color: rgba(255, 145, 0, 0.3); }
.markdown-rendered .callout-warning .callout-title,
.markdown-rendered .callout-caution .callout-title,
.markdown-rendered .callout-attention .callout-title { color: #ff9100; }
.markdown-rendered .callout-warning .callout-icon,
.markdown-rendered .callout-caution .callout-icon,
.markdown-rendered .callout-attention .callout-icon { color: #ff9100; }

.markdown-rendered .callout-danger,
.markdown-rendered .callout-error { background: rgba(255, 82, 82, 0.08); border-color: rgba(255, 82, 82, 0.3); }
.markdown-rendered .callout-danger .callout-title,
.markdown-rendered .callout-error .callout-title { color: #ff5252; }
.markdown-rendered .callout-danger .callout-icon,
.markdown-rendered .callout-error .callout-icon { color: #ff5252; }

.markdown-rendered .callout-failure,
.markdown-rendered .callout-fail,
.markdown-rendered .callout-missing { background: rgba(255, 82, 82, 0.08); border-color: rgba(255, 82, 82, 0.3); }
.markdown-rendered .callout-failure .callout-title,
.markdown-rendered .callout-fail .callout-title,
.markdown-rendered .callout-missing .callout-title { color: #ff5252; }
.markdown-rendered .callout-failure .callout-icon,
.markdown-rendered .callout-fail .callout-icon,
.markdown-rendered .callout-missing .callout-icon { color: #ff5252; }

.markdown-rendered .callout-bug { background: rgba(255, 82, 82, 0.08); border-color: rgba(255, 82, 82, 0.3); }
.markdown-rendered .callout-bug .callout-title { color: #ff5252; }
.markdown-rendered .callout-bug .callout-icon { color: #ff5252; }

.markdown-rendered .callout-example { background: rgba(124, 77, 255, 0.08); border-color: rgba(124, 77, 255, 0.3); }
.markdown-rendered .callout-example .callout-title { color: #7c4dff; }
.markdown-rendered .callout-example .callout-icon { color: #7c4dff; }

.markdown-rendered .callout-quote,
.markdown-rendered .callout-cite { background: rgba(158, 158, 158, 0.08); border-color: rgba(158, 158, 158, 0.3); }
.markdown-rendered .callout-quote .callout-title,
.markdown-rendered .callout-cite .callout-title { color: #9e9e9e; }
.markdown-rendered .callout-quote .callout-icon,
.markdown-rendered .callout-cite .callout-icon { color: #9e9e9e; }

/* Wiki links */
.markdown-rendered .wiki-link {
  color: var(--nc-accent-soft);
  text-decoration: none;
  cursor: pointer;
  border-bottom: 1px solid rgba(196, 181, 253, 0.3);
  transition: border-color 0.15s, color 0.15s;
}
.markdown-rendered .wiki-link:hover {
  color: var(--nc-accent);
  border-bottom-color: rgba(127, 109, 242, 0.7);
}

/* Embedded note placeholders */
.markdown-rendered .embed-placeholder {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  margin: 8px 0;
  border-radius: 8px;
  background: rgba(127, 109, 242, 0.06);
  border: 1px solid rgba(127, 109, 242, 0.15);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.markdown-rendered .embed-placeholder:hover {
  background: rgba(127, 109, 242, 0.12);
  border-color: rgba(127, 109, 242, 0.3);
}
.markdown-rendered .embed-placeholder .embed-icon {
  color: var(--nc-accent);
  flex-shrink: 0;
  display: flex;
}
.markdown-rendered .embed-placeholder .embed-label {
  font-size: 0.7em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--nc-faint);
  flex-shrink: 0;
}
.markdown-rendered .embed-placeholder .embed-title {
  color: var(--nc-accent-soft);
  font-size: 0.9em;
}

/* KaTeX overrides for dark theme */
.markdown-rendered .katex { color: var(--md-text); }
.markdown-rendered .katex-display { margin: 1em 0; overflow-x: auto; overflow-y: hidden; }
</style>

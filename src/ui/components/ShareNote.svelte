<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher();

  interface Contact {
    uid: string;
    name: string;
  }

  export let accessMode: 'public_edit' | 'invited_edit' | 'read_only' = 'read_only';
  export let expiresIn = 86400;
  export let showHelp = false;
  export let theme: 'auto' | 'light' | 'dark' = 'auto';
  export let showHeader = false;
  export let showControls = false;
  export let showChrome = false;
  export let contacts: Contact[] = [];
  export let collaborators: string[] = [];
  export let submitting = false;

  let collabInput = '';

  function addCollaborator(uid: string) {
    if (uid && !collaborators.includes(uid)) {
      collaborators = [...collaborators, uid];
      collabInput = '';
    }
  }

  function removeCollaborator(uid: string) {
    collaborators = collaborators.filter((c) => c !== uid);
  }

  function contactName(uid: string): string {
    const c = contacts.find((ct) => ct.uid === uid);
    return c?.name || uid.substring(0, 12) + '…';
  }

  function handleSubmit() {
    dispatch('share', {
      accessMode,
      expiresIn,
      showHelp,
      theme,
      showHeader,
      showControls,
      showChrome,
      collaborators,
    });
  }

</script>

<div class="share-note">
  <h2 class="share-heading">Share Note</h2>

  <!-- Access Mode -->
  <div class="share-field">
    <span class="share-label">Access mode</span>
    <p class="share-hint">
      View-only and editable modes create a web link. Every mode can also be
      delivered directly to another person's Obsidian by User ID.
    </p>
    <div class="access-options" role="radiogroup" aria-label="Access mode">
      <button
        type="button"
        role="radio"
        aria-checked={accessMode === 'read_only'}
        class="access-option"
        class:selected={accessMode === 'read_only'}
        on:click={() => accessMode = 'read_only'}
      >
        <span class="access-icon">👁</span>
        <span class="access-name">View-only link</span>
        <span class="access-desc">View on the web; UID recipients get a read-only Obsidian mirror</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={accessMode === 'public_edit'}
        class="access-option"
        class:selected={accessMode === 'public_edit'}
        on:click={() => accessMode = 'public_edit'}
      >
        <span class="access-icon">🌐</span>
        <span class="access-name">Editable link</span>
        <span class="access-desc">Anyone with the link can edit on the web or in Obsidian</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={accessMode === 'invited_edit'}
        class="access-option"
        class:selected={accessMode === 'invited_edit'}
        on:click={() => accessMode = 'invited_edit'}
      >
        <span class="access-icon">🔒</span>
        <span class="access-name">Invited collaborators</span>
        <span class="access-desc">Only people you invite can open and edit the note</span>
      </button>
    </div>
  </div>

  <!-- Direct Obsidian delivery -->
  <div class="share-field">
      <span class="share-label">Send directly to Obsidian (optional)</span>
      <p class="share-hint">
        Select contacts or add a Note Colab User ID. The note is delivered to their
        Note Colab plugin without sending the web link. Their auto-accept setting
        decides whether it enters the vault immediately or asks first.
      </p>

      {#if collaborators.length > 0}
        <div class="collab-list">
          {#each collaborators as uid (uid)}
            <div class="collab-chip">
              <span>{contactName(uid)}</span>
              <button class="chip-remove" on:click={() => removeCollaborator(uid)}>×</button>
            </div>
          {/each}
        </div>
      {/if}

      {#if contacts.length > 0}
        <div class="collab-contacts">
          {#each contacts.filter(c => !collaborators.includes(c.uid)) as contact (contact.uid)}
            <button class="contact-btn" on:click={() => addCollaborator(contact.uid)}>
              + {contact.name}
            </button>
          {/each}
        </div>
      {/if}

      <div class="collab-manual">
        <input
          type="text"
          placeholder="Paste user ID to add…"
          bind:value={collabInput}
          class="share-input"
          on:keydown={(e) => { if (e.key === 'Enter') { addCollaborator(collabInput); } }}
        />
        <button
          class="share-btn-small"
          disabled={!collabInput}
          on:click={() => addCollaborator(collabInput)}
        >
          Add
        </button>
      </div>
  </div>

  <!-- Expiry (hidden for invite-only since access is by collaborator status) -->
  {#if accessMode !== 'invited_edit'}
  <div class="share-field">
    <label class="share-label" for="link-expiry">Link expiry</label>
    <select id="link-expiry" bind:value={expiresIn} class="share-select">
      <option value={0}>Never expires</option>
      <option value={3600}>1 hour</option>
      <option value={86400}>24 hours</option>
      <option value={604800}>7 days</option>
      <option value={2592000}>30 days</option>
    </select>
  </div>
  {/if}

  <!-- Web appearance -->
  <div class="share-field">
    <span class="share-label">{accessMode === 'read_only' ? 'Reader view' : 'Web appearance'}</span>
    <p class="share-hint">
      {accessMode === 'read_only'
        ? 'Read-only links open as a clean, distraction-free document. Choose what readers see:'
        : 'Choose the theme used when the note is opened on the web.'}
    </p>

    <div class="reader-theme-row">
      <label class="reader-theme-label" for="reader-theme">Theme</label>
      <select id="reader-theme" bind:value={theme} class="share-select reader-theme-select">
        <option value="auto">Match device</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>

    {#if accessMode === 'read_only'}
    <label class="reader-check">
      <input type="checkbox" bind:checked={showControls} />
      <span>Let readers switch to source / split view</span>
    </label>
    <label class="reader-check">
      <input type="checkbox" bind:checked={showChrome} />
      <span>Show Note Colab info &amp; sync status</span>
    </label>
    <label class="reader-check">
      <input type="checkbox" bind:checked={showHeader} />
      <span>Show top navigation bar</span>
    </label>
    {/if}
  </div>

  <!-- Show Help (hidden for invite-only) -->
  {#if accessMode !== 'invited_edit'}
  <div class="share-field share-toggle-row">
    <label class="share-label" for="show-help">Show help guide to recipient</label>
    <label class="toggle-switch">
      <input type="checkbox" id="show-help" bind:checked={showHelp} />
      <span class="toggle-slider"></span>
    </label>
  </div>
  {/if}

  <!-- Submit -->
  <div class="share-footer">
    <button class="share-btn-primary" on:click={handleSubmit} disabled={submitting}>
      {#if submitting}
        Sharing…
      {:else if accessMode === 'invited_edit'}
        Share with invited collaborators
      {:else}
        Share & copy web link
      {/if}
    </button>
  </div>
</div>

<style>
  .share-note {
    padding: 16px;
    color: var(--text-normal);
    font-size: var(--font-ui-small);
  }

  .share-heading {
    margin: 0 0 16px;
    font-size: var(--font-ui-large);
    font-weight: 600;
  }

  .share-field {
    margin-bottom: 16px;
  }

  .share-label {
    display: block;
    font-size: var(--font-ui-small);
    font-weight: 500;
    margin-bottom: 6px;
    color: var(--text-normal);
  }

  .share-hint {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin: 0 0 8px;
  }

  /* Access mode cards */
  .access-options {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .access-option {
    display: grid;
    grid-template-columns: auto minmax(120px, max-content) minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    width: 100%;
    height: auto;
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    background: var(--background-secondary);
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s, background 0.15s;
    color: var(--text-normal);
    white-space: normal;
  }

  .access-option:hover {
    background: var(--background-modifier-hover);
  }

  .access-option.selected {
    border-color: var(--interactive-accent);
    background: rgba(127, 109, 242, 0.08);
  }

  .access-icon {
    font-size: 18px;
    flex-shrink: 0;
  }

  .access-name {
    font-weight: 600;
    font-size: var(--font-ui-small);
    line-height: 1.3;
  }

  .access-desc {
    min-width: 0;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  @media (max-width: 520px) {
    .access-option {
      grid-template-columns: auto minmax(0, 1fr);
      column-gap: 10px;
    }

    .access-desc {
      grid-column: 2;
    }
  }

  /* Collaborators */
  .collab-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }

  .collab-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--background-modifier-hover);
    border: 1px solid var(--background-modifier-border);
    border-radius: 12px;
    padding: 3px 8px 3px 10px;
    font-size: var(--font-ui-smaller);
  }

  .chip-remove {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 14px;
    padding: 0 2px;
    line-height: 1;
  }

  .chip-remove:hover {
    color: #ef5350;
  }

  .collab-contacts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }

  .contact-btn {
    background: none;
    border: 1px dashed var(--background-modifier-border);
    color: var(--text-muted);
    padding: 3px 10px;
    border-radius: 12px;
    cursor: pointer;
    font-size: var(--font-ui-smaller);
    transition: color 0.15s, border-color 0.15s;
  }

  .contact-btn:hover {
    color: var(--interactive-accent);
    border-color: var(--interactive-accent);
  }

  .collab-manual {
    display: flex;
    gap: 6px;
  }

  .share-input {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
  }

  .share-input:focus {
    border-color: var(--interactive-accent);
    outline: none;
  }

  .share-btn-small {
    padding: 6px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: var(--font-ui-small);
  }

  .share-btn-small:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .share-btn-small:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .share-select {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
  }

  /* Reader view controls */
  .reader-theme-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }

  .reader-theme-label {
    font-size: var(--font-ui-small);
    color: var(--text-normal);
  }

  .reader-theme-select {
    width: auto;
    min-width: 140px;
  }

  .reader-check {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: var(--font-ui-small);
    color: var(--text-normal);
    cursor: pointer;
  }

  .reader-check input {
    flex-shrink: 0;
    cursor: pointer;
  }

  /* Toggle */
  .share-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .share-toggle-row .share-label {
    margin-bottom: 0;
  }

  .toggle-switch {
    position: relative;
    display: inline-block;
    width: 36px;
    height: 20px;
    flex-shrink: 0;
  }

  .toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--background-modifier-border);
    border-radius: 10px;
    transition: background 0.2s;
  }

  .toggle-slider::before {
    content: '';
    position: absolute;
    height: 14px;
    width: 14px;
    left: 3px;
    bottom: 3px;
    background: var(--text-on-accent);
    border-radius: 50%;
    transition: transform 0.2s;
  }

  .toggle-switch input:checked + .toggle-slider {
    background: var(--interactive-accent);
  }

  .toggle-switch input:checked + .toggle-slider::before {
    transform: translateX(16px);
  }

  /* Footer */
  .share-footer {
    padding-top: 8px;
  }

  .share-btn-primary {
    width: 100%;
    padding: 10px 16px;
    border: none;
    border-radius: 6px;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    font-size: var(--font-ui-small);
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .share-btn-primary:hover {
    opacity: 0.9;
  }

  .share-btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher();

  interface LinkInfo {
    shareId: string;
    label: string;
    accessMode: string;
    expiresAt: string | null;
    createdAt: string;
    /** The note's canonical Original link. */
    original: boolean;
    retired: boolean;
  }

  interface Collaborator {
    uid: string;
    canEdit: boolean;
  }

  interface Contact {
    uid: string;
    name: string;
  }

  export let links: LinkInfo[] = [];
  export let collaborators: Collaborator[] = [];
  export let contacts: Contact[] = [];
  export let serverUrl = '';
  export let encryptionKey = '';
  export let loading = true;
  export let loaded = false;
  export let loadError = '';
  /** Owner on a server that supports it; null hides the section. */
  export let liveEncryption: { enabled: boolean } | null = null;
  let confirmLiveEncryption = false;

  let editingLink: string | null = null;
  let editLabel = '';
  let editAccessMode = 'read_only';
  let editExpiresIn = 0;
  let confirmDeleteId: string | null = null;
  let sendingLinkId: string | null = null;
  let sendUid = '';

  // New link form
  let showNewLink = false;
  let newLabel = '';
  let newAccessMode = 'read_only';
  let newExpiresIn = 0;

  // New collaborator
  let showAddCollab = false;
  let newCollabUid = '';
  let confirmRemoveCollab: string | null = null;
  let inviteLinkId = '';
  let confirmReplaceOriginal = false;
  // Opt-in only: never retire the Original link unless the owner asks.
  let replaceOriginal = false;

  // One server request at a time; forms stay open with their input until it succeeds.
  let pending: string | null = null;

  async function request(event: string, detail: Record<string, unknown>, key: string): Promise<boolean> {
    if (pending) return false;
    pending = key;
    try {
      return await new Promise<boolean>((resolve) => dispatch(event, { ...detail, done: resolve }));
    } finally {
      pending = null;
    }
  }

  function formatAccessMode(mode: string): string {
    switch (mode) {
      case 'public_edit': return 'Editable link';
      case 'invited_edit': return 'Invited collaborators';
      case 'read_only': return 'View-only link';
      default: return mode;
    }
  }

  function accessModeClass(mode: string): string {
    switch (mode) {
      case 'public_edit': return 'badge-green';
      case 'invited_edit': return 'badge-blue';
      case 'read_only': return 'badge-yellow';
      default: return '';
    }
  }

  function timeRemaining(expiresAt: string | null): string | null {
    if (!expiresAt) return null;
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m left`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h left`;
    const days = Math.floor(hours / 24);
    return `${days}d left`;
  }

  function buildLink(linkShareId: string): string {
    return `${serverUrl}/s/${linkShareId}#${encryptionKey}`;
  }

  function startEdit(link: LinkInfo) {
    editingLink = link.shareId;
    editLabel = link.label;
    editAccessMode = link.accessMode;
    editExpiresIn = 0;
  }

  function cancelEdit() {
    editingLink = null;
  }

  function contactName(uid: string): string {
    const c = contacts.find((ct) => ct.uid === uid);
    return c?.name || uid.substring(0, 12) + '…';
  }

  async function createLink() {
    if (await request('create-link', { label: newLabel, accessMode: newAccessMode, expiresIn: newExpiresIn || undefined }, 'create')) {
      showNewLink = false;
      newLabel = '';
    }
  }

  async function saveEdit(link: LinkInfo) {
    const saved = await request('update-link', {
      linkShareId: link.shareId,
      label: editLabel,
      // Send access only when it changed: the server rejects any access change on a retired Original link.
      accessMode: editAccessMode === link.accessMode ? undefined : editAccessMode,
      expiresIn: editExpiresIn === -1 ? null : (editExpiresIn || undefined),
    }, `edit:${link.shareId}`);
    if (saved) editingLink = null;
  }

  function startDelete(link: LinkInfo) {
    confirmDeleteId = link.shareId;
    replaceOriginal = false;
  }

  async function deleteLink(link: LinkInfo) {
    const replace = replaceOriginal && originalStillOpen && !link.original;
    if (await request('delete-link', { linkShareId: link.shareId, replaceOriginal: replace }, `delete:${link.shareId}`)) confirmDeleteId = null;
  }

  async function replaceOriginalLink() {
    if (await request('replace-original', {}, 'replace-original')) confirmReplaceOriginal = false;
  }

  async function sendToObsidian(link: LinkInfo) {
    if (await request('send-to-obsidian', { linkShareId: link.shareId, accessMode: link.accessMode, uid: sendUid }, `send:${link.shareId}`)) {
      sendingLinkId = null;
      sendUid = '';
    }
  }

  async function addCollaborator() {
    if (await request('add-collaborator', { uid: newCollabUid }, 'add-collaborator')) {
      showAddCollab = false;
      newCollabUid = '';
    }
  }

  function startRemoveCollaborator(uid: string) {
    confirmRemoveCollab = uid;
    replaceOriginal = false;
  }

  async function removeCollaborator(uid: string) {
    const replace = replaceOriginal && originalStillOpen;
    if (await request('remove-collaborator', { uid, replaceOriginal: replace }, `remove:${uid}`)) confirmRemoveCollab = null;
  }

  // Anyone who held another link to this note can derive the Original link,
  // which keeps working anonymously until the owner deletes or replaces it.
  $: originalLink = links.find((link) => link.original);
  $: originalStillOpen = !!originalLink && !originalLink.retired && originalLink.accessMode !== 'invited_edit';

  $: hasInvitedLink = links.some((link) => link.accessMode === 'invited_edit');
  // A replaced Original reports invited_edit but cannot issue invites.
  $: invitedLinks = links.filter((link) => link.accessMode === 'invited_edit' && !link.retired);
  $: if (!invitedLinks.some((link) => link.shareId === inviteLinkId)) {
    inviteLinkId = invitedLinks[0]?.shareId || '';
  }
</script>

<div class="manage-links">
  {#if loading}
    <div class="ml-loading">Loading…</div>
  {:else}
    {#if loadError}
      <div class="ml-load-error" role="alert">
        <span>{loadError}</span>
        <button class="ml-btn" on:click={() => dispatch('retry')}>Retry</button>
      </div>
    {/if}
    {#if loaded}
    <!-- Links Section -->
    <div class="ml-section">
      <div class="ml-section-header">
        <h3>Share links ({links.length})</h3>
        <button class="ml-btn ml-btn-primary" on:click={() => { showNewLink = !showNewLink; }}>
          {showNewLink ? 'Cancel' : '+ New link'}
        </button>
      </div>

      {#if showNewLink}
        <div class="ml-form">
          <div class="ml-field">
            <label for="new-link-label">Label</label>
            <input id="new-link-label" type="text" placeholder="e.g. Team link" bind:value={newLabel} class="ml-input" />
          </div>
          <div class="ml-field">
            <label for="new-link-access">Access</label>
            <select id="new-link-access" bind:value={newAccessMode} class="ml-select">
              <option value="read_only">View-only link</option>
              <option value="public_edit">Editable link</option>
              <option value="invited_edit">Invited collaborators</option>
            </select>
          </div>
          <div class="ml-field">
            <label for="new-link-expiry">Expiry</label>
            <select id="new-link-expiry" bind:value={newExpiresIn} class="ml-select">
              <option value={0}>Never</option>
              <option value={3600}>1 hour</option>
              <option value={86400}>24 hours</option>
              <option value={604800}>7 days</option>
              <option value={2592000}>30 days</option>
            </select>
          </div>
          <button class="ml-btn ml-btn-primary" disabled={pending !== null} on:click={createLink}>
            {pending === 'create' ? 'Creating…' : 'Create link'}
          </button>
        </div>
      {/if}

      {#if links.length === 0}
        <p class="ml-empty">No links created yet.</p>
      {:else}
        {#each links as link (link.shareId)}
          <div class="ml-link-card">
            {#if editingLink === link.shareId}
              <!-- Edit Mode -->
              <div class="ml-form">
                <div class="ml-field">
                  <label for="edit-label">Label</label>
                  <input id="edit-label" type="text" bind:value={editLabel} class="ml-input" />
                </div>
                {#if link.retired}
                  <p class="ml-hint">A retired link’s access can’t be changed. Create a new link instead.</p>
                {:else}
                <div class="ml-field">
                  <label for="edit-access">Access</label>
                  <select id="edit-access" bind:value={editAccessMode} class="ml-select">
                    <option value="read_only">View-only link</option>
                    <option value="public_edit">Editable link</option>
                    <option value="invited_edit">Invited collaborators</option>
                  </select>
                </div>
                <div class="ml-field">
                  <label for="edit-expiry">New expiry</label>
                  <select id="edit-expiry" bind:value={editExpiresIn} class="ml-select">
                    <option value={0}>No change</option>
                    <option value={3600}>1 hour from now</option>
                    <option value={86400}>24 hours from now</option>
                    <option value={604800}>7 days from now</option>
                    <option value={2592000}>30 days from now</option>
                    <option value={-1}>Remove expiry</option>
                  </select>
                </div>
                {/if}
                <div class="ml-form-actions">
                  <button class="ml-btn ml-btn-primary" disabled={pending !== null} on:click={() => saveEdit(link)}>
                    {pending === `edit:${link.shareId}` ? 'Saving…' : 'Save'}
                  </button>
                  <button class="ml-btn" on:click={cancelEdit}>Cancel</button>
                </div>
              </div>
            {:else}
              <!-- View Mode -->
              <div class="ml-link-header">
                <span class="ml-link-label">{link.label || link.shareId.substring(0, 12)}</span>
                <span class="badge {link.retired ? 'badge-muted' : accessModeClass(link.accessMode)}">
                  {link.retired ? 'Retired' : formatAccessMode(link.accessMode)}
                </span>
              </div>

              <div class="ml-link-meta">
                {#if link.retired}
                  <span>Retired. It no longer opens for people without invited access. You and invited collaborators keep access.</span>
                {:else if link.expiresAt}
                  {@const remaining = timeRemaining(link.expiresAt)}
                  <span class:expired={remaining === 'Expired'}>{remaining}</span>
                {:else}
                  <span>No expiry</span>
                {/if}
              </div>

              <div class="ml-link-actions">
                {#if !link.retired}
                  <button class="ml-btn" on:click={() => dispatch('copy-link', { url: buildLink(link.shareId) })}>
                    Copy link
                  </button>
                {/if}
                {#if link.original && originalStillOpen && !confirmReplaceOriginal}
                  <button class="ml-btn" on:click={() => confirmReplaceOriginal = true}>Replace</button>
                {/if}
                <button class="ml-btn" on:click={() => { sendingLinkId = sendingLinkId === link.shareId ? null : link.shareId; sendUid = ''; }}>
                  Send to Obsidian
                </button>
                <button class="ml-btn" on:click={() => startEdit(link)}>Edit</button>
                {#if confirmDeleteId === link.shareId}
                  <button class="ml-btn ml-btn-danger" disabled={pending !== null} on:click={() => deleteLink(link)}>
                    {pending === `delete:${link.shareId}` ? 'Deleting…' : 'Confirm'}
                  </button>
                  <button class="ml-btn" on:click={() => confirmDeleteId = null}>Cancel</button>
                {:else}
                  <button class="ml-btn ml-btn-danger" on:click={() => startDelete(link)}>Delete</button>
                {/if}
              </div>
              {#if confirmDeleteId === link.shareId && !link.original && originalStillOpen}
                <div class="ml-confirm">
                  <p class="ml-hint">People who had this link may still open the note through the original link.</p>
                  <label class="ml-check">
                    <input type="checkbox" bind:checked={replaceOriginal} />
                    <span>Also replace the original link</span>
                  </label>
                  {#if replaceOriginal}
                    <p class="ml-hint">The original link will stop working for anyone without invited access. A new link with the same settings is created and copied; share it with everyone who should keep access. People on NoteColab 1.25 or older lose access, even through the new link, until they update.</p>
                  {/if}
                </div>
              {/if}
              {#if confirmDeleteId === link.shareId && link.original && originalStillOpen}
                <p class="ml-hint">Deleting stops the original link from working for anyone without invited access. Your other links keep working. People on NoteColab 1.25 or older who opened this note through another link lose access until they update.</p>
              {/if}
              {#if link.original && confirmReplaceOriginal}
                <div class="ml-confirm">
                  <p class="ml-hint">Replacing stops the original link from working for anyone without invited access, including people who got another link to this note. A new link with the same settings is created and copied; share it with everyone who should keep access. People on NoteColab 1.25 or older lose access, even through the new link, until they update.</p>
                  <div class="ml-form-actions">
                    <button class="ml-btn ml-btn-danger" disabled={pending !== null} on:click={replaceOriginalLink}>
                      {pending === 'replace-original' ? 'Replacing…' : 'Replace original link'}
                    </button>
                    <button class="ml-btn" on:click={() => confirmReplaceOriginal = false}>Cancel</button>
                  </div>
                </div>
              {/if}
              {#if sendingLinkId === link.shareId}
                <div class="ml-form">
                  <div class="ml-field">
                    <label for="send-link-uid">Recipient User ID</label>
                    {#if contacts.length > 0}
                      <select id="send-link-uid" bind:value={sendUid} class="ml-select">
                        <option value="">Select a contact…</option>
                        {#each contacts as contact}
                          <option value={contact.uid}>{contact.name} ({contact.uid.substring(0, 8)}…)</option>
                        {/each}
                      </select>
                      <span class="ml-field-or">or</span>
                    {/if}
                    <input
                      id={contacts.length > 0 ? undefined : 'send-link-uid'}
                      type="text"
                      placeholder="Paste User ID"
                      aria-label="Recipient User ID"
                      bind:value={sendUid}
                      class="ml-input"
                    />
                  </div>
                  <button class="ml-btn ml-btn-primary" disabled={!sendUid || pending !== null} on:click={() => sendToObsidian(link)}>
                    {pending === `send:${link.shareId}` ? 'Delivering…' : 'Deliver to Obsidian'}
                  </button>
                  <p class="ml-hint">Their auto-accept setting decides whether the note enters their vault immediately or asks first.</p>
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    {#if hasInvitedLink}
    <!-- Protected collaborators are only meaningful for invite-only links. -->
    <div class="ml-section">
      <div class="ml-section-header">
        <h3>Collaborators ({collaborators.length})</h3>
        <button class="ml-btn ml-btn-primary" on:click={() => { showAddCollab = !showAddCollab; }}>
          {showAddCollab ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {#if showAddCollab}
        <div class="ml-form">
          <div class="ml-field">
            <label for="collab-uid">User ID</label>
            {#if contacts.length > 0}
              <select id="collab-uid" bind:value={newCollabUid} class="ml-select">
                <option value="">Select a contact…</option>
                {#each contacts as contact}
                  <option value={contact.uid}>{contact.name} ({contact.uid.substring(0, 8)}…)</option>
                {/each}
              </select>
              <span class="ml-field-or">or</span>
            {/if}
            <input
              id={contacts.length > 0 ? undefined : 'collab-uid'}
              type="text"
              placeholder="Paste User ID"
              aria-label="Collaborator User ID"
              bind:value={newCollabUid}
              class="ml-input"
            />
          </div>
          <button class="ml-btn ml-btn-primary" disabled={!newCollabUid || pending !== null} on:click={addCollaborator}>
            {pending === 'add-collaborator' ? 'Adding…' : 'Add collaborator'}
          </button>
        </div>
      {/if}

      {#if collaborators.length === 0}
        <p class="ml-empty">No collaborators added.</p>
      {:else}
        {#each collaborators as collab (collab.uid)}
          <div class="ml-collab-card">
            <div class="ml-collab-row">
            <div class="ml-collab-info">
              <span class="ml-collab-name">{contactName(collab.uid)}</span>
              <span class="badge {collab.canEdit ? 'badge-green' : 'badge-yellow'}">
                {collab.canEdit ? 'Can edit' : 'View only'}
              </span>
            </div>
            <div class="ml-collab-actions">
              <button class="ml-btn" disabled={pending !== null} on:click={() => request('resend-collaborator', { uid: collab.uid }, `resend:${collab.uid}`)}>
                {pending === `resend:${collab.uid}` ? 'Resending…' : 'Resend'}
              </button>
              {#if confirmRemoveCollab === collab.uid}
                <button class="ml-btn ml-btn-danger" disabled={pending !== null} on:click={() => removeCollaborator(collab.uid)}>
                  {pending === `remove:${collab.uid}` ? 'Removing…' : 'Confirm'}
                </button>
                <button class="ml-btn" on:click={() => confirmRemoveCollab = null}>Cancel</button>
              {:else}
                <button class="ml-btn ml-btn-danger" aria-label="Remove {contactName(collab.uid)}" on:click={() => startRemoveCollaborator(collab.uid)}>Remove</button>
              {/if}
            </div>
            </div>
            {#if confirmRemoveCollab === collab.uid && originalStillOpen}
              <div class="ml-confirm">
                <p class="ml-hint">{contactName(collab.uid)} may still open the note through the original link.</p>
                <label class="ml-check">
                  <input type="checkbox" bind:checked={replaceOriginal} />
                  <span>Also replace the original link</span>
                </label>
                {#if replaceOriginal}
                  <p class="ml-hint">The original link will stop working for anyone without invited access. A new link with the same settings is created and copied; share it with everyone who should keep access. People on NoteColab 1.25 or older lose access, even through the new link, until they update.</p>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <!-- Invite Links Section -->
    {#if invitedLinks.length > 0}
    <div class="ml-section">
      <div class="ml-section-header">
        <h3>Invite links</h3>
        <button class="ml-btn ml-btn-primary" disabled={pending !== null} on:click={() => request('create-invite-link', { linkShareId: inviteLinkId }, 'invite')}>
          {pending === 'invite' ? 'Creating…' : '+ Generate invite link'}
        </button>
      </div>
      {#if invitedLinks.length > 1}
        <div class="ml-field">
          <label for="invite-link-target">Access link</label>
          <select id="invite-link-target" bind:value={inviteLinkId} class="ml-select">
            {#each invitedLinks as link}
              <option value={link.shareId}>{link.label || link.shareId.substring(0, 12)}</option>
            {/each}
          </select>
        </div>
      {/if}
      <p class="ml-hint">Invite links let people import this note into their Obsidian without needing their User ID.</p>
    </div>
    {/if}
    {/if}

    <!-- Encrypted live editing (owner only, one-way) -->
    {#if liveEncryption}
    <div class="ml-section">
      <div class="ml-section-header">
        <h3>Encrypted live editing</h3>
        {#if !liveEncryption.enabled && !confirmLiveEncryption}
          <button class="ml-btn" disabled={pending !== null} on:click={() => confirmLiveEncryption = true}>Encrypt live editing…</button>
        {/if}
      </div>
      {#if liveEncryption.enabled}
        <p class="ml-hint">The note's text is encrypted while people edit it live. The server still sees who is connected and when, their presence names, and roughly how much is typed. This can't be turned off.</p>
      {:else}
        <p class="ml-hint">Encrypt the note's text while people edit it live, not only when it is saved. The server still sees who is connected and when, their presence names, and roughly how much is typed.</p>
        {#if confirmLiveEncryption}
          <div class="ml-confirm">
            <p class="ml-hint">Collaborators on older NoteColab versions can't edit this note live or save it until they update. This can't be turned off; to undo it, share the content again as a new note.</p>
            <div class="ml-form-actions">
              <button class="ml-btn ml-btn-primary" disabled={pending !== null} on:click={async () => { if (await request('enable-live-e2e', {}, 'live-e2e')) confirmLiveEncryption = false; }}>
                {pending === 'live-e2e' ? 'Encrypting…' : 'Encrypt live editing'}
              </button>
              <button class="ml-btn" on:click={() => confirmLiveEncryption = false}>Cancel</button>
            </div>
          </div>
        {/if}
      {/if}
    </div>
    {/if}
    {/if}
  {/if}
</div>

<style>
  .manage-links {
    padding: 16px;
    color: var(--text-normal);
    font-size: var(--font-ui-small);
  }

  .ml-loading {
    text-align: center;
    padding: 24px;
    color: var(--text-muted);
  }

  .ml-section {
    margin-bottom: 20px;
  }

  .ml-load-error {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: space-between;
    margin-bottom: 12px;
    padding: 8px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    color: var(--text-error);
  }

  .ml-section-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .ml-section-header h3 {
    margin: 0;
    font-size: var(--font-ui-medium);
    font-weight: 600;
  }

  .ml-form {
    padding: 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    background: var(--background-primary);
    margin-bottom: 8px;
  }

  .ml-field {
    margin-bottom: 8px;
  }

  .ml-field label {
    display: block;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin-bottom: 3px;
  }

  .ml-field-or {
    display: block;
    text-align: center;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin: 4px 0;
  }

  .ml-input {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
  }

  .ml-input:focus {
    border-color: var(--interactive-accent);
    outline: none;
  }

  .ml-select {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
  }

  .ml-form-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  .ml-btn {
    background: none;
    border: 1px solid var(--background-modifier-border);
    color: var(--text-muted);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.15s, color 0.15s;
  }

  .ml-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .ml-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ml-btn-primary {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-color: var(--interactive-accent);
  }

  .ml-btn-primary:hover {
    opacity: 0.9;
  }

  .ml-btn-danger {
    color: var(--text-error);
    border-color: rgba(var(--color-red-rgb), 0.3);
  }

  .ml-btn-danger:hover {
    background: rgba(var(--color-red-rgb), 0.1);
    color: var(--text-error);
  }

  .ml-empty {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    padding: 8px 0;
  }

  .ml-hint {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    padding: 4px 0;
    margin: 0;
  }

  .ml-link-card {
    padding: 10px 12px;
    margin-bottom: 6px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    background: var(--background-secondary);
  }

  .ml-link-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }

  .ml-link-label {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .ml-link-meta {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin-bottom: 6px;
  }

  .expired {
    color: var(--text-error);
  }

  .ml-link-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 500;
    white-space: nowrap;
  }

  .badge-green {
    background: rgba(var(--color-green-rgb), 0.15);
    color: var(--color-green);
  }

  .badge-blue {
    background: rgba(var(--color-blue-rgb), 0.15);
    color: var(--color-blue);
  }

  .badge-yellow {
    background: rgba(var(--color-yellow-rgb), 0.15);
    color: var(--color-yellow);
  }

  .badge-muted {
    background: var(--background-modifier-hover);
    color: var(--text-muted);
  }

  .ml-collab-card {
    padding: 8px 12px;
    margin-bottom: 4px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    background: var(--background-secondary);
  }

  .ml-collab-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 8px;
    justify-content: space-between;
  }

  .ml-confirm {
    margin-top: 8px;
  }

  .ml-check {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    cursor: pointer;
  }

  .ml-collab-info {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 160px;
    min-width: 0;
  }

  .ml-collab-name {
    font-weight: 500;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ml-collab-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
</style>

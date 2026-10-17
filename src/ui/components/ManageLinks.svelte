<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher();

  interface LinkInfo {
    shareId: string;
    label: string;
    accessMode: string;
    expiresAt: string | null;
    createdAt: string;
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

  $: hasInvitedLink = links.some((link) => link.accessMode === 'invited_edit');
  $: invitedLinks = links.filter((link) => link.accessMode === 'invited_edit');
  $: if (!invitedLinks.some((link) => link.shareId === inviteLinkId)) {
    inviteLinkId = invitedLinks[0]?.shareId || '';
  }
</script>

<div class="manage-links">
  {#if loading}
    <div class="ml-loading">Loading…</div>
  {:else}
    <!-- Links Section -->
    <div class="ml-section">
      <div class="ml-section-header">
        <h3>Share Links ({links.length})</h3>
        <button class="ml-btn ml-btn-primary" on:click={() => { showNewLink = !showNewLink; }}>
          {showNewLink ? 'Cancel' : '+ New Link'}
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
          <button class="ml-btn ml-btn-primary" on:click={() => { dispatch('create-link', { label: newLabel, accessMode: newAccessMode, expiresIn: newExpiresIn || undefined }); showNewLink = false; newLabel = ''; }}>
            Create Link
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
                <div class="ml-form-actions">
                  <button class="ml-btn ml-btn-primary" on:click={() => { dispatch('update-link', { linkShareId: link.shareId, label: editLabel, accessMode: editAccessMode, expiresIn: editExpiresIn === -1 ? null : (editExpiresIn || undefined) }); editingLink = null; }}>
                    Save
                  </button>
                  <button class="ml-btn" on:click={cancelEdit}>Cancel</button>
                </div>
              </div>
            {:else}
              <!-- View Mode -->
              <div class="ml-link-header">
                <span class="ml-link-label">{link.label || link.shareId.substring(0, 12)}</span>
                <span class="badge {accessModeClass(link.accessMode)}">
                  {formatAccessMode(link.accessMode)}
                </span>
              </div>

              <div class="ml-link-meta">
                {#if link.expiresAt}
                  {@const remaining = timeRemaining(link.expiresAt)}
                  <span class:expired={remaining === 'Expired'}>{remaining}</span>
                {:else}
                  <span>No expiry</span>
                {/if}
              </div>

              <div class="ml-link-actions">
                <button class="ml-btn" on:click={() => dispatch('copy-link', { url: buildLink(link.shareId) })}>
                  Copy Link
                </button>
                <button class="ml-btn" on:click={() => { sendingLinkId = sendingLinkId === link.shareId ? null : link.shareId; sendUid = ''; }}>
                  Send to Obsidian
                </button>
                <button class="ml-btn" on:click={() => startEdit(link)}>Edit</button>
                {#if confirmDeleteId === link.shareId}
                  <button class="ml-btn ml-btn-danger" on:click={() => { dispatch('delete-link', { linkShareId: link.shareId }); confirmDeleteId = null; }}>
                    Confirm
                  </button>
                  <button class="ml-btn" on:click={() => confirmDeleteId = null}>Cancel</button>
                {:else}
                  <button class="ml-btn ml-btn-danger" on:click={() => confirmDeleteId = link.shareId}>Delete</button>
                {/if}
              </div>
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
                    <input type="text" placeholder="Paste User ID" bind:value={sendUid} class="ml-input" />
                  </div>
                  <button
                    class="ml-btn ml-btn-primary"
                    disabled={!sendUid}
                    on:click={() => {
                      dispatch('send-to-obsidian', {
                        linkShareId: link.shareId,
                        accessMode: link.accessMode,
                        uid: sendUid,
                      });
                      sendingLinkId = null;
                      sendUid = '';
                    }}
                  >
                    Deliver to Obsidian
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
            <input type="text" placeholder="Paste user ID" bind:value={newCollabUid} class="ml-input" />
          </div>
          <button class="ml-btn ml-btn-primary" disabled={!newCollabUid} on:click={() => { dispatch('add-collaborator', { uid: newCollabUid }); showAddCollab = false; newCollabUid = ''; }}>
            Add Collaborator
          </button>
        </div>
      {/if}

      {#if collaborators.length === 0}
        <p class="ml-empty">No collaborators added.</p>
      {:else}
        {#each collaborators as collab (collab.uid)}
          <div class="ml-collab-card">
            <div class="ml-collab-info">
              <span class="ml-collab-name">{contactName(collab.uid)}</span>
              <span class="badge {collab.canEdit ? 'badge-green' : 'badge-yellow'}">
                {collab.canEdit ? 'Can edit' : 'View only'}
              </span>
            </div>
            <div class="ml-collab-actions">
              <button class="ml-btn" on:click={() => dispatch('resend-collaborator', { uid: collab.uid })}>
                Resend
              </button>
              {#if confirmRemoveCollab === collab.uid}
                <button class="ml-btn ml-btn-danger" on:click={() => { dispatch('remove-collaborator', { uid: collab.uid }); confirmRemoveCollab = null; }}>
                  Confirm
                </button>
                <button class="ml-btn" on:click={() => confirmRemoveCollab = null}>Cancel</button>
              {:else}
                <button class="ml-btn ml-btn-danger" on:click={() => confirmRemoveCollab = collab.uid}>Remove</button>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Invite Links Section -->
    <div class="ml-section">
      <div class="ml-section-header">
        <h3>Invite Links</h3>
        <button class="ml-btn ml-btn-primary" on:click={() => dispatch('create-invite-link', { linkShareId: inviteLinkId })}>
          + Generate Invite Link
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

  .ml-section-header {
    display: flex;
    align-items: center;
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
    color: #ef5350;
    border-color: rgba(244, 67, 54, 0.3);
  }

  .ml-btn-danger:hover {
    background: rgba(244, 67, 54, 0.1);
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
    color: #ef5350;
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
    background: rgba(76, 175, 80, 0.15);
    color: #66bb6a;
  }

  .badge-blue {
    background: rgba(66, 165, 245, 0.15);
    color: #42a5f5;
  }

  .badge-yellow {
    background: rgba(255, 193, 7, 0.15);
    color: #ffc107;
  }

  .ml-collab-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    margin-bottom: 4px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    background: var(--background-secondary);
  }

  .ml-collab-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ml-collab-name {
    font-weight: 500;
  }

  .ml-collab-actions {
    display: flex;
    gap: 4px;
  }
</style>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher();

  interface NoteLink {
    shareId: string;
    label: string;
    accessMode: string;
    expiresAt: string | null;
    createdAt: string;
  }

  interface Note {
    noteShareId: string;
    title: string | null;
    encryptedTitle?: string | null;
    createdAt: string;
    updatedAt: string;
    links: NoteLink[];
  }

  interface PendingShare {
    id: number;
    shareId: string;
    senderUid: string;
    senderName: string | null;
    encryptedKey: string;
    nonce: string;
    title: string | null;
    encryptedTitle?: string | null;
    createdAt: string;
  }

  interface SharedNote {
    noteId: number;
    title: string | null;
    encryptedTitle?: string | null;
    ownerUid: string;
    shareId: string;
    accessMode: string;
    canEdit: boolean;
    createdAt: string;
    updatedAt: string;
    localOnly?: boolean;
  }

  interface StorageNote {
    noteShareId: string;
    title: string | null;
    encryptedTitle?: string | null;
    createdAt: string;
    updatedAt: string;
    storage: {
      contentBytes: number;
      imageCount: number;
      imageBytes: number;
      yjsBytes: number;
      totalBytes: number;
    };
  }

  interface StorageInfo {
    storageLimit: number;
    totalBytes: number;
    otherBytes?: number;
    usagePercent: number;
    noteCount: number;
    notes: StorageNote[];
  }

  export let loading = true;
  export let notes: Note[] = [];
  export let sharedNotes: SharedNote[] = [];
  export let pendingShares: PendingShare[] = [];
  export let storage: StorageInfo | null = null;
  export let error: string = '';

  let activeTab: 'notes' | 'shared' | 'storage' = 'notes';
  let searchQuery = '';
  let confirmDeleteId: string | null = null;
  let confirmRevokeId: string | null = null;
  let confirmLeaveId: string | null = null;

  $: safePendingShares = Array.isArray(pendingShares) ? pendingShares : [];
  $: safeSharedNotes = Array.isArray(sharedNotes) ? sharedNotes : [];

  $: filteredNotes = (Array.isArray(notes) ? notes : []).filter((n) =>
    !searchQuery || n.title?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  $: pendingCount = safePendingShares.length;

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

  function timeAgo(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diff = now - then;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
  }

  function timeRemaining(expiresAt: string | null): string | null {
    if (!expiresAt) return null;
    const now = Date.now();
    const exp = new Date(expiresAt).getTime();
    const diff = exp - now;
    if (diff <= 0) return 'Expired';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m left`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h left`;
    const days = Math.floor(hours / 24);
    return `${days}d left`;
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function hasExpiredLink(note: Note): boolean {
    return note.links.some((l) => {
      if (!l.expiresAt) return false;
      return new Date(l.expiresAt).getTime() < Date.now();
    });
  }

  function primaryAccessMode(note: Note): string {
    if (note.links.length === 0) return 'read_only';
    return note.links[0].accessMode;
  }
</script>

<div class="notecolab-dashboard">
  <!-- Header -->
  <div class="dashboard-header">
    <div class="header-title">
      <span>Note Colab</span>
    </div>
    <div class="header-actions">
      <button class="action-btn action-share" on:click={() => dispatch('share-current')} title="Share the active note">
        Share current note
      </button>
      <button class="refresh-btn clickable-icon" on:click={() => dispatch('refresh')} title="Refresh">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
      </button>
    </div>
  </div>

  <!-- Tabs -->
  <div class="dashboard-tabs">
    <button
      class="tab-btn"
      class:active={activeTab === 'notes'}
      on:click={() => activeTab = 'notes'}
    >
      My Notes
    </button>
    <button
      class="tab-btn"
      class:active={activeTab === 'shared'}
      on:click={() => activeTab = 'shared'}
    >
      Shared with Me
      {#if pendingCount > 0}
        <span class="pending-badge">{pendingCount}</span>
      {/if}
    </button>
    <button
      class="tab-btn"
      class:active={activeTab === 'storage'}
      on:click={() => activeTab = 'storage'}
    >
      Storage
    </button>
  </div>

  <!-- Loading -->
  {#if loading}
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <span>Loading…</span>
    </div>
  {:else if error}
    <div class="error-state">
      <p class="error-message">{error}</p>
      <button class="action-btn" on:click={() => dispatch('refresh')}>Retry</button>
    </div>
  {:else}

    <!-- My Notes Tab -->
    {#if activeTab === 'notes'}
      <div class="tab-content">
        {#if filteredNotes.length > 0 || searchQuery}
          <div class="search-bar">
            <input
              type="text"
              placeholder="Filter notes…"
              bind:value={searchQuery}
              class="search-input"
            />
          </div>
        {/if}

        {#if filteredNotes.length === 0 && !searchQuery}
          <div class="empty-state">
            <p class="empty-title">No shared notes yet</p>
            <p class="empty-desc">Use the "Share note" command to share a note from your vault.</p>
          </div>
        {:else if filteredNotes.length === 0}
          <div class="empty-state">
            <p class="empty-desc">No notes matching "{searchQuery}"</p>
          </div>
        {:else}
          {#each filteredNotes as note (note.noteShareId)}
            <div class="note-card">
              <div class="note-header">
                <span class="note-title">{note.title || 'Encrypted note'}</span>
                <span class="badge {accessModeClass(primaryAccessMode(note))}">
                  {formatAccessMode(primaryAccessMode(note))}
                </span>
              </div>

              <div class="note-meta">
                <span>{note.links.length} link{note.links.length !== 1 ? 's' : ''}</span>
                <span>·</span>
                <span>{timeAgo(note.updatedAt)}</span>
                {#if hasExpiredLink(note)}
                  <span class="badge badge-red">Expired link</span>
                {/if}
              </div>

              <div class="note-actions">
                <button class="action-btn" on:click={() => dispatch('open-note', { noteShareId: note.noteShareId })} title="Open in vault">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                  Open
                </button>
                <button class="action-btn" on:click={() => dispatch('copy-link', { noteShareId: note.noteShareId })} title="Copy share link">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                  Copy
                </button>
                <button class="action-btn" on:click={() => dispatch('manage-links', { noteShareId: note.noteShareId })} title="Manage links">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                  Links
                </button>
                {#if confirmRevokeId === note.noteShareId}
                  <button class="action-btn action-danger" on:click={() => { dispatch('revoke', { noteShareId: note.noteShareId }); confirmRevokeId = null; }}>
                    Confirm revoke
                  </button>
                  <button class="action-btn" on:click={() => confirmRevokeId = null}>
                    Cancel
                  </button>
                {:else}
                  <button class="action-btn action-danger" on:click={() => confirmRevokeId = note.noteShareId} title="Revoke share">
                    Revoke
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>

    <!-- Shared with Me Tab -->
    {:else if activeTab === 'shared'}
      <div class="tab-content">
        {#if safePendingShares.length > 0}
          <div class="section-label">Pending invitations</div>
          {#each safePendingShares as ps (ps.id)}
            <div class="note-card pending-card">
              <div class="note-header">
                <span class="note-title">{ps.title || 'Encrypted note'}</span>
                <span class="badge badge-purple">Pending</span>
              </div>
              <div class="note-meta">
                <span>From {ps.senderName || (ps.senderUid ? ps.senderUid.substring(0, 12) + '…' : 'Unknown')}</span>
                <span>·</span>
                <span>{ps.createdAt ? timeAgo(ps.createdAt) : ''}</span>
              </div>
              <div class="note-actions">
                <button class="action-btn action-accept" on:click={() => dispatch('import-share', { shareId: ps.shareId, encryptedKey: ps.encryptedKey, nonce: ps.nonce, senderUid: ps.senderUid, id: ps.id })}>
                  Accept & Import
                </button>
                <button class="action-btn action-danger" on:click={() => dispatch('dismiss-share', { id: ps.id })}>
                  Dismiss
                </button>
              </div>
            </div>
          {/each}
        {/if}

        {#if safeSharedNotes.length > 0}
          <div class="section-label">Shared notes</div>
          {#each safeSharedNotes as note (note.shareId)}
            <div class="note-card">
              <div class="note-header">
                <span class="note-title">{note.title || 'Encrypted note'}</span>
                <span class="badge {note.canEdit ? 'badge-green' : 'badge-yellow'}">
                  {note.canEdit ? 'Can edit' : 'View only'}
                </span>
              </div>
              <div class="note-meta">
                <span>{note.localOnly
                  ? 'Imported into this vault'
                  : `Owner ${note.ownerUid ? note.ownerUid.substring(0, 12) + '…' : 'Unknown'}`}</span>
                <span>·</span>
                <span>{formatAccessMode(note.accessMode)}</span>
                <span>·</span>
                <span>Updated {timeAgo(note.updatedAt)}</span>
              </div>
              <div class="note-actions">
                <button class="action-btn" on:click={() => dispatch('open-note', { noteShareId: note.shareId })} title="Open in vault">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                  Open
                </button>
                {#if !note.localOnly && confirmLeaveId === note.shareId}
                  <button class="action-btn action-danger" on:click={() => { dispatch('leave-share', { shareId: note.shareId }); confirmLeaveId = null; }}>
                    Confirm remove
                  </button>
                  <button class="action-btn" on:click={() => confirmLeaveId = null}>Cancel</button>
                {:else if !note.localOnly}
                  <button class="action-btn action-danger" on:click={() => confirmLeaveId = note.shareId}>
                    Remove from list
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        {/if}

        {#if safePendingShares.length === 0 && safeSharedNotes.length === 0}
          <div class="empty-state">
            <p class="empty-title">No shared notes</p>
            <p class="empty-desc">When someone shares a note with you, it will appear here.</p>
          </div>
        {/if}
      </div>

    <!-- Storage Tab -->
    {:else if activeTab === 'storage'}
      <div class="tab-content">
        {#if storage}
          <div class="storage-overview">
            <div class="storage-label">
              <span>Storage used</span>
              <span>{formatBytes(storage.totalBytes)} / {formatBytes(storage.storageLimit)}</span>
            </div>
            <div class="progress-bar">
              <div
                class="progress-fill"
                class:progress-warn={storage.usagePercent > 80}
                class:progress-danger={storage.usagePercent > 95}
                style="width: {Math.min(storage.usagePercent, 100)}%"
              ></div>
            </div>
            <div class="storage-count">{storage.noteCount} note{storage.noteCount !== 1 ? 's' : ''}</div>
          </div>

          {#if storage.notes.length > 0 || (storage.otherBytes || 0) > 0}
            <div class="section-label">Per-note breakdown</div>
            {#if (storage.otherBytes || 0) > 0}
              <div class="note-card">
                <div class="note-header">
                  <span class="note-title">Other (keys & pending shares)</span>
                  <span class="storage-size">{formatBytes(storage.otherBytes || 0)}</span>
                </div>
              </div>
            {/if}
            {#each storage.notes as sn (sn.noteShareId)}
              <div class="note-card">
                <div class="note-header">
                  <span class="note-title">{sn.title || 'Encrypted note'}</span>
                  <span class="storage-size">{formatBytes(sn.storage.totalBytes)}</span>
                </div>
                <div class="note-meta">
                  <span>Content: {formatBytes(sn.storage.contentBytes)}</span>
                  {#if sn.storage.imageCount > 0}
                    <span>·</span>
                    <span>{sn.storage.imageCount} image{sn.storage.imageCount !== 1 ? 's' : ''}: {formatBytes(sn.storage.imageBytes)}</span>
                  {/if}
                  {#if sn.storage.yjsBytes > 0}
                    <span>·</span>
                    <span>Sync: {formatBytes(sn.storage.yjsBytes)}</span>
                  {/if}
                </div>
                <div class="note-actions">
                  {#if confirmDeleteId === sn.noteShareId}
                    <button class="action-btn action-danger" on:click={() => { dispatch('delete-note', { noteShareId: sn.noteShareId }); confirmDeleteId = null; }}>
                      Confirm delete
                    </button>
                    <button class="action-btn" on:click={() => confirmDeleteId = null}>Cancel</button>
                  {:else}
                    <button class="action-btn action-danger" on:click={() => confirmDeleteId = sn.noteShareId}>
                      Delete from server
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          {/if}
        {:else}
          <div class="empty-state">
            <p class="empty-desc">Storage information unavailable.</p>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .notecolab-dashboard {
    padding: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    color: var(--text-normal);
    font-size: var(--font-ui-small);
  }

  .dashboard-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .header-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: var(--font-ui-medium);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .action-btn.action-share {
    color: var(--text-on-accent);
    background: var(--interactive-accent);
    border-color: var(--interactive-accent);
  }

  .action-btn.action-share:hover {
    color: var(--text-on-accent);
    background: var(--interactive-accent-hover);
  }

  .refresh-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
  }

  .refresh-btn:hover {
    color: var(--text-normal);
    background: var(--background-modifier-hover);
  }

  .dashboard-tabs {
    display: flex;
    border-bottom: 1px solid var(--background-modifier-border);
    padding: 0 8px;
    flex-shrink: 0;
    position: relative;
    z-index: 1;
  }

  .tab-btn {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    padding: 8px 12px;
    cursor: pointer;
    font-size: var(--font-ui-small);
    display: flex;
    align-items: center;
    gap: 6px;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover {
    color: var(--text-normal);
  }

  .tab-btn.active {
    color: var(--interactive-accent);
    border-bottom-color: var(--interactive-accent);
  }

  .pending-badge {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: 600;
    min-width: 16px;
    text-align: center;
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 48px 16px;
    color: var(--text-muted);
  }

  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 48px 16px;
    color: var(--text-muted);
  }

  .error-message {
    color: var(--color-red);
    text-align: center;
  }

  .loading-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--background-modifier-border);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .tab-content {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    min-height: 0;
  }

  .search-bar {
    padding: 4px 0 8px;
  }

  .search-input {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    outline: none;
  }

  .search-input:focus {
    border-color: var(--interactive-accent);
  }

  .empty-state {
    text-align: center;
    padding: 32px 16px;
    color: var(--text-muted);
  }

  .empty-title {
    font-weight: 600;
    margin-bottom: 4px;
    color: var(--text-normal);
  }

  .empty-desc {
    font-size: var(--font-ui-smaller);
  }

  .section-label {
    font-size: var(--font-ui-smaller);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 8px 4px 4px;
  }

  .note-card {
    padding: 10px 12px;
    margin-bottom: 4px;
    border-radius: 6px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
  }

  .note-card:hover {
    background: var(--background-modifier-hover);
  }

  .pending-card {
    border-left: 3px solid var(--interactive-accent);
  }

  .note-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }

  .note-title {
    font-weight: 600;
    font-size: var(--font-ui-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 500;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .badge-green {
    background: rgba(76, 175, 80, 0.15);
    color: var(--color-green, #4caf50);
  }

  .badge-blue {
    background: rgba(33, 150, 243, 0.15);
    color: var(--color-blue, #2196f3);
  }

  .badge-yellow {
    background: rgba(255, 152, 0, 0.15);
    color: var(--color-yellow, #ff9800);
  }

  .badge-red {
    background: rgba(244, 67, 54, 0.15);
    color: var(--color-red, #f44336);
    margin-left: 4px;
  }

  .badge-purple {
    background: rgba(156, 39, 176, 0.15);
    color: var(--color-purple, #9c27b0);
  }

  .note-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .note-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .action-btn {
    background: none;
    border: 1px solid var(--background-modifier-border);
    color: var(--text-muted);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: background 0.15s, color 0.15s;
  }

  .action-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .action-accept {
    border-color: rgba(76, 175, 80, 0.4);
    color: var(--color-green, #4caf50);
  }

  .action-accept:hover {
    background: rgba(76, 175, 80, 0.15);
  }

  .action-danger {
    color: var(--color-red, #f44336);
    border-color: rgba(244, 67, 54, 0.3);
  }

  .action-danger:hover {
    background: rgba(244, 67, 54, 0.1);
  }

  /* Storage */
  .storage-overview {
    padding: 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    background: var(--background-secondary);
    margin-bottom: 8px;
  }

  .storage-label {
    display: flex;
    justify-content: space-between;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin-bottom: 6px;
  }

  .progress-bar {
    width: 100%;
    height: 6px;
    background: var(--background-modifier-border);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--interactive-accent);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .progress-warn {
    background: var(--color-yellow);
  }

  .progress-danger {
    background: var(--color-red);
  }

  .storage-count {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin-top: 4px;
  }

  .storage-size {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    font-weight: normal;
    flex-shrink: 0;
  }
</style>

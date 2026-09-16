<template>
  <div class="marketing-scroll">
    <section class="marketing-hero">
      <div class="marketing-container marketing-hero-grid">
        <div>
          <p class="marketing-kicker">Collaboration for Obsidian</p>
          <h1>Share the note.<br>Keep the vault.</h1>
          <p class="marketing-lede">Publish a clean reading link, invite someone to edit, or work together live. Your Markdown stays in Obsidian.</p>
          <div class="marketing-actions">
            <a :href="installUrl" class="marketing-button marketing-button-primary">Install from Community Plugins</a>
            <NuxtLink to="/help" class="marketing-button">See how it works</NuxtLink>
          </div>
        </div>
        <figure class="product-capture">
          <img src="/images/sharing-in-obsidian.png" alt="Note Colab sharing controls in Obsidian, with view-only, editable, and invited access" width="984" height="768">
          <figcaption>Choose access, updates, and expiry inside Obsidian.</figcaption>
        </figure>
      </div>
    </section>

    <ClientOnly>
      <section v-if="recentNotes.length" class="recent-notes">
        <div class="marketing-container">
          <div class="recent-notes-head"><h2>Open a recent note</h2><button class="text-button" @click="clearHistory">Clear history</button></div>
          <div class="recent-grid">
            <a v-for="note in recentNotes" :key="note.shareId" :href="note.url" class="recent-card">
              <strong>{{ note.title }}</strong>
              <span>{{ note.accessMode === 'read_only' ? 'View only' : 'Editable' }} · {{ getTimeRemaining(note.expiresAt) }}</span>
            </a>
          </div>
        </div>
      </section>
    </ClientOnly>

    <section class="marketing-section">
      <div class="marketing-container">
        <div class="marketing-section-heading">
          <h2>One note, the right kind of access.</h2>
          <p>Note Colab is for the moment a note needs to leave your vault. Use a simple link for readers, an editable link for quick collaboration, or named invitations when access should be specific.</p>
        </div>
        <div class="feature-grid">
          <article class="feature-card"><span class="feature-number">01</span><h3>Publish for reading</h3><p>Send a focused web page to anyone with the complete link. Add an expiry and revoke it when the work is done.</p></article>
          <article class="feature-card"><span class="feature-number">02</span><h3>Edit together</h3><p>Collaborate in Obsidian or the browser with live updates, presence, and shared cursors.</p></article>
          <article class="feature-card"><span class="feature-number">03</span><h3>Publish a folder</h3><p>Share a folder and its Markdown files. Keep its index current as files are added, edited, and renamed.</p></article>
        </div>
      </div>
    </section>

    <section class="marketing-section marketing-section-muted">
      <div class="marketing-container">
        <div class="marketing-section-heading">
          <h2>From install to first share.</h2>
          <p>No terminal and no separate desktop application. The plugin asks before connecting to the hosted service, then keeps sharing controls inside Obsidian.</p>
        </div>
        <div class="steps">
          <article class="step"><div><h3>Install Note Colab</h3><p>In Obsidian, open Settings → Community plugins → Browse, then search for “Note Colab”.</p></div></article>
          <article class="step"><div><h3>Connect when you are ready</h3><p>Review the short first-use explanation, then connect to the hosted service. No email address or password is required for the first share.</p></div></article>
          <article class="step"><div><h3>Choose the audience</h3><p>Run “Note Colab: Share note”, choose view-only, editable, or invited access, and send the resulting link.</p></div></article>
        </div>
      </div>
    </section>

    <section class="marketing-section">
      <div class="marketing-container">
        <div class="marketing-section-heading">
          <h2>Security described plainly.</h2>
          <p>Current clients encrypt REST-stored Markdown, titles, and supported images before upload. Live collaboration is different: decrypted Yjs text is visible to the relay while the room is active.</p>
        </div>
        <div class="marketing-callout">
          <h3>Know what the server can see</h3>
          <p>The service can see share metadata and live collaboration content. Older notes may retain legacy plaintext titles until updated by a current owner client. Note Colab is not described as wholly zero-knowledge or end-to-end encrypted.</p>
          <p><NuxtLink to="/security">Read the security model</NuxtLink> before sharing sensitive material.</p>
        </div>
      </div>
    </section>

    <section class="marketing-section marketing-section-muted">
      <div class="marketing-container marketing-section-heading" style="margin-bottom: 0">
        <h2>Open source, portable links.</h2>
        <div>
          <p>The plugin, API, relay, and web client are Apache-2.0 licensed. You can use the hosted service at notecolab.com or connect the plugin to a compatible server you trust.</p>
          <div class="marketing-actions">
            <a href="https://github.com/felixleopold/notecolab" class="marketing-button">View source on GitHub</a>
            <NuxtLink to="/privacy" class="marketing-button">Privacy details</NuxtLink>
          </div>
        </div>
      </div>
    </section>
    <MarketingFooter />
  </div>
</template>

<script setup lang="ts">
const installUrl = 'obsidian://show-plugin?id=notecolab'
const { recentNotes, load, clearHistory, getTimeRemaining } = useRecentNotes()

onMounted(load)

useHead({
  title: 'Note Colab | Share and collaborate from Obsidian',
  meta: [{ name: 'description', content: 'Share Markdown notes as clean web pages or collaborate live from Obsidian and the browser.' }],
})
</script>

<style scoped>
.product-capture { margin: 0; min-width: 0; }
.product-capture img { display: block; width: 100%; height: auto; border: 1px solid var(--border-color, #ddd); border-radius: 14px; }
.product-capture figcaption { margin-top: 12px; color: var(--text-secondary, #667085); font-size: 13px; text-align: center; }
</style>

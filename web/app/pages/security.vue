<template>
  <div class="marketing-scroll">
    <section class="marketing-page-hero"><div class="marketing-container marketing-narrow"><p class="marketing-kicker">Security</p><h1>Where trust begins and ends.</h1><p class="marketing-lede">Note Colab protects stored note content while being explicit about what the live relay and service operator can see.</p></div></section>
    <div class="marketing-container marketing-narrow marketing-page-content">
      <section class="prose-section">
        <h2>The short version</h2>
        <ul>
          <li>Current clients encrypt REST-stored Markdown, titles, and supported images with AES-256-GCM before upload.</li>
          <li>The note key is carried after <code>#</code> in the share URL, which browsers do not include in HTTP requests.</li>
          <li>Live Yjs collaboration content is decrypted and visible to the relay while a room is active.</li>
          <li>Share metadata is visible to the server. Legacy notes may retain plaintext titles until updated by a current owner client.</li>
        </ul>
        <p>These boundaries mean Note Colab is not wholly zero-knowledge or end-to-end encrypted.</p>
      </section>
      <section class="prose-section">
        <h2>What the service receives</h2>
        <table class="data-table">
          <thead><tr><th>Data path</th><th>What the server or relay receives</th></tr></thead>
          <tbody>
            <tr><td>Stored note body and title</td><td>AES-256-GCM ciphertext from current clients.</td></tr>
            <tr><td>Supported stored images</td><td>AES-256-GCM ciphertext. Filenames and MIME types remain metadata.</td></tr>
            <tr><td>Live collaboration</td><td>Decrypted Yjs text, operations, and collaborator state while the room is active.</td></tr>
            <tr><td>Share records</td><td>Identifiers, access modes, timestamps, sizes, expiry, and collaborator identifiers.</td></tr>
          </tbody>
        </table>
      </section>
      <section class="prose-section">
        <h2>Links and access</h2>
        <p>A complete view-only or editable link is a bearer capability. Anyone who receives it may use its granted access and can copy decrypted content. Public-edit links also allow changes. Expiry and revocation reduce exposure but cannot recall information a recipient already copied.</p>
        <p>Plugin and web credentials authorize account actions. Do not share API keys. Browser sessions are independently revocable. Optional provider sign-in authenticates an account, but it cannot derive the password-based vault key or silently replace the plugin credential and X25519 key. Protect your Obsidian vault and backups because plugin data and shared-note frontmatter contain credentials or note keys.</p>
      </section>
      <section class="prose-section">
        <h2>Operational trust</h2>
        <p>TLS protects credentials, ciphertext, live collaboration text, and metadata in transit. It does not hide live text from the relay endpoint. Use the hosted service only if you trust its operator, or connect the plugin to a compatible server you trust.</p>
        <p>The public Obsidian plugin is available for inspection at <a href="https://github.com/felixleopold/notecolab">github.com/felixleopold/notecolab</a>.</p>
      </section>
      <div class="marketing-callout"><h3>Responsible disclosure</h3><p><a href="https://github.com/felixleopold/notecolab/issues">Open a GitHub issue</a> without sensitive details to arrange a private report. Do not post credentials, complete share links, note keys, or private content.</p></div>
    </div>
    <MarketingFooter />
  </div>
</template>

<script setup lang="ts">
useHead({ title: 'Security | Note Colab', meta: [{ name: 'description', content: 'The Note Colab encryption, live-relay, metadata, and credential trust boundaries.' }] })
</script>

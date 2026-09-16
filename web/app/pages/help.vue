<template>
  <div class="marketing-scroll">
    <section class="marketing-page-hero"><div class="marketing-container marketing-narrow"><p class="marketing-kicker">Help</p><h1>Share your first note.</h1><p class="marketing-lede">The shortest path from a local Markdown file to a useful link.</p></div></section>
    <div class="marketing-container marketing-narrow marketing-page-content">
      <section class="prose-section">
        <h2>Install and connect</h2>
        <ol>
          <li>In Obsidian, open <strong>Settings → Community plugins</strong>.</li>
          <li>Select <strong>Browse</strong>, search for <strong>Note Colab</strong>, then install and enable it.</li>
          <li>Review the first-use explanation and select <strong>Connect to notecolab.com</strong>. No email address or password is required.</li>
        </ol>
        <p>If you self-host, open <strong>Settings → Note Colab</strong>, enter the server origin without <code>/api/v1</code>, then connect. A different server creates a separate identity.</p>
      </section>
      <section class="prose-section">
        <h2>Create a share</h2>
        <ol>
          <li>Open a Markdown note.</li>
          <li>Open the command palette with <strong>Ctrl/Cmd+P</strong>.</li>
          <li>Run <strong>Note Colab: Share note</strong>.</li>
          <li>Choose view-only, editable, or invited access. Set an expiry if the access mode supports it.</li>
          <li>Select the share action and send the complete link, including the part after <code>#</code>.</li>
        </ol>
      </section>
      <section class="prose-section">
        <h2>Sign in and recover an account</h2>
        <p>You can use your User ID and Note Colab password on the web. If your server advertises Google or GitHub, you can also link that provider from plugin Settings or the dashboard. Each login creates an independent browser session that you can revoke without signing out your other devices.</p>
        <p>Provider sign-in does not unlock encrypted notes or replace a plugin installation. A new browser still needs your Note Colab password to derive the vault key. Restoring the plugin still requires the saved User ID and password, and explicitly replaces the old plugin credential and device encryption key.</p>
      </section>
      <section class="prose-section">
        <h2>Choose an access mode</h2>
        <table class="data-table">
          <thead><tr><th>Mode</th><th>Use it when</th><th>Who can open it</th></tr></thead>
          <tbody>
            <tr><td>View-only link</td><td>You want a clean reader or a locked, updating copy in another vault.</td><td>Anyone with the complete link.</td></tr>
            <tr><td>Editable link</td><td>A small group needs to edit without an account invitation.</td><td>Anyone with the complete link.</td></tr>
            <tr><td>Invited collaborators</td><td>Access should be tied to named Note Colab identities.</td><td>People you explicitly invite on the same server.</td></tr>
          </tbody>
        </table>
      </section>
      <section class="prose-section">
        <h2>Open and manage shared notes</h2>
        <ul>
          <li>Open a link in the browser to read or edit according to its permission.</li>
          <li>Run <strong>Note Colab: Import shared note</strong> to bring a link into Obsidian.</li>
          <li>Run <strong>Manage shared links</strong> to create, copy, expire, or revoke individual links.</li>
          <li>Run <strong>Revoke note share</strong> to remove the server copy and disable its links.</li>
          <li>Keep the generated <code>colab_*</code> frontmatter. It is how the plugin reconnects to the share.</li>
        </ul>
      </section>
      <section class="prose-section">
        <h2>Publish a folder</h2>
        <p>Run <strong>Note Colab: Share folder</strong>, enter a vault-relative folder path, choose read-only or editable access, then review the file list before publishing. Markdown files and supported embedded images are included recursively.</p>
        <p>Run the command again for the same folder to publish additions, edits, and renames or resume a partial failure. A local deletion removes the file from the next folder index but does not delete its remote share. Revoke old remote notes individually when needed.</p>
      </section>
      <section class="prose-section">
        <h2>Troubleshooting</h2>
        <h3>The share command is unavailable</h3><p>Make sure a Markdown file is open and active.</p>
        <h3>A collaborator cannot accept an invitation</h3><p>Invited access requires both identities to be on the server hosting the note. Ordinary links can be opened across servers.</p>
        <h3>Typing disappears while another sync plugin is active</h3><p>Update SimpleSync to version 0.1.28 or later on affected devices, then test with a disposable note.</p>
        <h3>Connection fails</h3><p>Check the Server URL in Note Colab settings and try again. The <NuxtLink to="/status">status page</NuxtLink> shows current hosted-service readiness.</p>
      </section>
      <div class="marketing-callout"><h3>Still stuck?</h3><p><a href="https://github.com/felixleopold/notecolab/issues">Open a GitHub issue</a>. Do not include private notes, complete share links, API keys, or recovery material.</p></div>
    </div>
    <MarketingFooter />
  </div>
</template>

<script setup lang="ts">
useHead({ title: 'Help | Note Colab', meta: [{ name: 'description', content: 'Install Note Colab, share a note, choose access, and solve common problems.' }] })
</script>

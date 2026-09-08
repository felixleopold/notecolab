# Note Colab

Share an Obsidian note as a clean web page, send it directly to another vault,
or edit it together in real time.

Note Colab works immediately with the hosted service at
[notecolab.com](https://notecolab.com). You do not need an email address or
password to share your first note.

## Your first five minutes

1. Install and enable **Note Colab** in Obsidian.
2. Follow the short first-use guide. Note Colab connects automatically and
   creates an anonymous identity for the hosted service.
3. Open the note you want to share.
4. Open the command palette with **Ctrl/Cmd+P** and run **Note Colab: Share
   note**. You can also open the Note Colab dashboard from the ribbon and select
   **Share current note**.
5. Choose who should have access, then copy and send the link.

That is all you need to start. If anything feels confusing or stops you from
using Note Colab, please [tell me on
GitHub](https://github.com/felixleopold/notecolab/issues). Feature requests are
welcome too.

## Install

### From Obsidian's Community plugins directory

1. Open **Settings → Community plugins**.
2. Turn off Restricted mode if Obsidian asks you to.
3. Select **Browse**, search for **Note Colab**, and select **Install**.
4. Select **Enable**.

### Manual installation

1. Download `main.js` and `manifest.json` from the [latest GitHub
   release](https://github.com/felixleopold/notecolab/releases/latest).
2. Create `<vault>/.obsidian/plugins/notecolab/`.
3. Put both files in that folder.
4. Reload Obsidian and enable **Note Colab** under **Settings → Community
   plugins**.

## Share a note

Open a Markdown note, then run **Note Colab: Share note** from the command
palette or select **Share current note** in the Note Colab dashboard.

Choose the access that fits what you want to do:

| Access | Who can open it | What they can do |
| --- | --- | --- |
| **View-only link** | Anyone with the link | Read the note on the web. Direct recipients receive a locked copy in Obsidian that stays updated. |
| **Editable link** | Anyone with the link | Edit together in a browser or after importing the note into Obsidian. |
| **Invited collaborators** | People you invite | Edit after signing in with an identity on the same Note Colab server. |

For a view-only or editable link, you can also choose an expiry time and adjust
the web reader's appearance. To send a note directly to another vault, select a
trusted contact or paste the recipient's User ID.

Select **Share & copy web link** or **Share with invited collaborators** when
you are ready. Note Colab copies the resulting link so you can send it using
your preferred messaging app.

Note Colab adds `colab_*` properties to shared-note frontmatter. Keep these
properties in the note. They identify the server copy and contain the
information the plugin needs to reconnect securely.

## Open a note someone shared

- **Web link:** Open the link in a browser. No Obsidian installation is needed
  to read a view-only note or join an editable session.
- **Share link in Obsidian:** Run **Note Colab: Import shared note** and paste
  the link.
- **Direct delivery:** Accept the notification in Obsidian. You can enable
  **Auto-accept shared notes** in settings if you want future deliveries to
  enter the vault without confirmation.

A directly delivered view-only note is a mirror. It stays synchronized with the
owner's version and cannot be edited accidentally. Run **Create editable copy
of read-only note** to make an independent local copy.

If a link belongs to a different Note Colab server, the plugin shows the server
name and asks you to trust it before connecting. Direct invitations only work
when both people have identities on the server hosting the note.

## Collaborate and manage shares

Editable notes synchronize while they are open. Use **Stop share sync** to stop
the live connection without removing the share. Use **Revoke note share** to
remove the server copy and disable its links.

Open the dashboard from the ribbon or run **Note Colab: Open dashboard** to:

- share the active note;
- see notes you own and notes shared with you;
- copy or revoke links;
- manage collaborators;
- review storage use;
- remove server copies you no longer need.

Run **Note Colab: Manage shared links** while viewing a shared note to create
separate links with different permissions, expiry times, labels, or reader
appearance. Revoking one link does not revoke the others.

## Your identity and settings

Open **Settings → Note Colab** to find your User ID, sharing defaults, trusted
contacts, and storage information.

- Your User ID lets another Note Colab user invite you directly.
- An optional public username makes your User ID easier for collaborators to
  recognize.
- Trusted-contact aliases are private to your vault.
- A Web password is optional unless you want to use the server's web dashboard.

Save your full User ID and set a Web password before buying storage. Together,
they can restore the same identity, notes, and plan after reinstalling the
plugin or moving to another vault.

Changing **Server URL** creates a separate identity on the new server. It does
not move shares, contacts, or account settings between servers.

## Troubleshooting

- **Share current note does nothing:** Make sure a Markdown note is open and
  active, then try **Note Colab: Share note** from the command palette.
- **Automatic connection fails:** Open **Settings → Note Colab**, confirm the
  Server URL, and try connecting again.
- **The note is already shared:** Run **Note Colab: Manage shared links** to
  copy its existing link or create another one.
- **A recipient cannot accept an invitation:** Confirm that both users are
  connected to the same Note Colab server. Ordinary view-only and editable
  links can be opened across servers.

## Privacy essentials

- Current clients encrypt stored Markdown, titles, and supported embedded images
  on your device before upload.
- The decryption key is stored after `#` in a share link. Keep the complete link
  private and send it only to intended recipients.
- Anyone with a view-only link can read and copy the shared content. Anyone with
  an editable link can also change it.
- Live collaboration text is visible to the collaboration relay while a room is
  active. Do not treat live collaboration as a zero-knowledge channel.
- Share metadata, including identifiers, permissions, timestamps, sizes,
  collaborators, image filenames, and MIME types, is visible to the server.
- Older shares may retain a plaintext title until a current owner client updates
  them.
- Note Colab stores its server credential and private key in Obsidian plugin
  data, and stores note keys in shared-note frontmatter. Protect your vault and
  its backups accordingly.
- The plugin has no telemetry or advertising.

Use a server you trust and always use HTTPS.

## Use another server

Note Colab can connect to a compatible self-hosted service:

1. Open **Settings → Note Colab**.
2. Enter the server origin, such as `https://notes.example.com`. Do not append
   `/api/v1`.
3. Select **Connect** and enter a registration code if the server requires one.
4. Confirm that a new User ID appears, then test a share.

The server must implement the Note Colab HTTP and WebSocket contract. Identities
and direct invitations are scoped to one server.

## Feedback and support

Please [open a GitHub
issue](https://github.com/felixleopold/notecolab/issues) to report a bug, request
a feature, or explain what is holding you back from using Note Colab. Do not
include private notes, complete share links, API keys, or other credentials.

## Development

Use a separate test vault for plugin development.

```sh
npm ci
npm test
npm run build
```

Copy `main.js` and `manifest.json` into
`<test-vault>/.obsidian/plugins/notecolab/`, then reload Obsidian.

## License

The public plugin is available under the Apache License 2.0. See `LICENSE` in
the repository root.

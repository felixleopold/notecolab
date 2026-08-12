# Note Colab

Share an Obsidian note as a clean web page, send it directly to another vault,
or edit it together in real time.

Note Colab encrypts stored note content on your device and works with either the
hosted service at [notecolab.com](https://notecolab.com) or a compatible server
you control.

## What you can do

- Create expiring, view-only links for notes and embedded images.
- Create editable links for live collaboration in a browser or Obsidian.
- Invite specific Note Colab users instead of publishing an editable link.
- Deliver a note directly to another user's Obsidian vault.
- Receive an updating read-only mirror, then make a separate editable copy when
  you need one.
- Manage links, collaborators, shared notes, and storage from one dashboard.
- Use the hosted service without creating an email-and-password account, or
  connect the plugin to a compatible self-hosted backend.

## Install

### From Obsidian's Community plugins directory

1. Open **Settings → Community plugins** in Obsidian.
2. Turn off Restricted mode if Obsidian asks you to.
3. Select **Browse**, search for **Note Colab**, and select **Install**.
4. Select **Enable**.

### Manual installation

1. Download `main.js` and `manifest.json` from the [latest GitHub
   release](https://github.com/felixleopold/notecolab/releases/latest).
2. Create `<vault>/.obsidian/plugins/notecolab/`.
3. Put both downloaded files in that folder.
4. Reload Obsidian, then enable **Note Colab** under **Settings → Community
   plugins**.

## Set up Note Colab

Note Colab uses `https://notecolab.com` by default. On a fresh installation it
connects automatically and creates an anonymous identity for that server; no
email address is required. A short onboarding guide then walks you through
sharing your first note.

1. Follow the onboarding guide, or open a note and run **Note Colab: Share
   note** from the command palette.
2. Open **Settings → Note Colab** if you want to review your connection or
   change sharing defaults.
3. Copy your **User ID** if you want other people to invite you directly. You
   can also add an optional public username to make that ID easier to recognise.
4. Choose the default access mode and link expiry you want for new shares.
5. Optional: add people under **Trusted contacts** using their User IDs. A
   contact alias is private to your vault.
6. Optional: turn on **Auto-accept shared notes** only if you want notes sent to
   your User ID to enter your vault without a confirmation prompt.

That is all you need for sharing from Obsidian. The **Web dashboard** password
is optional; set one only if you also want to open and manage your shared notes
on the configured server's website.

> Changing **Server URL** creates a new identity on the new server. It does not
> move your existing shares, contacts, or web-dashboard setup between servers.

## Share your first note

1. Open the note you want to share.
2. Open the command palette with **Ctrl/Cmd+P** and run **Note Colab: Share
   note**, or open the
   Note Colab dashboard from the ribbon.
3. Choose an access mode:

   | Mode | Who can open it | What they can do |
   |------|-----------------|------------------|
   | **View-only link** | Anyone with the link | Read it on the web; direct recipients receive a locked, updating copy in Obsidian. |
   | **Editable link** | Anyone with the link | Edit together on the web or after importing it into Obsidian. |
   | **Invited collaborators** | People you add by User ID or who accept the invite link | Open and edit it while signed in to the same Note Colab server. |

4. For a direct Obsidian delivery, select a trusted contact or paste the
   recipient's User ID. This is optional for view-only and editable links.
5. For a link, choose its expiry and web appearance.
6. Select **Share & copy web link** or **Share with invited collaborators**.
   Invite-only sharing copies a single-server invite link that you can send to
   another user on that server.

Note Colab adds `colab_*` properties to the note's frontmatter. Keep them in the
shared note: they identify the server copy, its current link, and the key needed
to reconnect.

Editable shares begin syncing while the note is open. **Stop share sync** stops
the live connection without revoking the link. **Revoke note share** removes
the server copy and its links.

## Open a note someone shared

- **In a browser:** open a view-only or editable link normally. The part after
  `#` contains the decryption key and stays in the browser.
- **In Obsidian:** run **Note Colab: Import shared note** and paste the link.
- **Direct delivery:** Note Colab asks you to accept or decline unless
  **Auto-accept shared notes** is enabled.

A directly delivered view-only note is a mirror: Note Colab refreshes it from
the owner's version and prevents accidental edits. Use **Create editable copy
of read-only note** to make an independent local note, or **Delete read-only
note and stop updates** to remove the mirror.

If a link belongs to a different Note Colab server, the plugin names that host
and asks you to trust it before connecting. View-only and editable links are
portable between servers. Direct invitations are not: both people must have an
identity on the server that hosts the note.

## Manage shares

Open the Note Colab dashboard from the ribbon or run **Note Colab: Open
dashboard**. From there you can inspect notes you own and notes shared with you,
copy or revoke links, manage collaborators, and delete server copies to free
storage.

For the active note, **Note Colab: Manage shared links** lets you create separate
links with different access, expiry, labels, and reader appearance. Revoking
one link does not revoke the others.

## How it works

Think of a share as three pieces:

1. **The note copy** lives on the configured server. Note Colab encrypts its
   title, Markdown body, and supported embedded images before uploading them.
2. **The share link** identifies the server and permission. Its URL fragment
   (the part after `#`) contains the note key. Browsers do not send fragments in
   HTTP requests, so the key is not included in the request to the server.
3. **Live collaboration** uses a Yjs document so everyone can merge concurrent
   edits. Live Yjs updates contain decrypted note text and are visible to the
   collaboration relay while a room is active. Live collaboration therefore has a
   different privacy boundary from stored REST shares.

Each server creates its own anonymous User ID and authentication key for the
plugin. For direct delivery, Note Colab uses the recipient's public key to wrap
the note key so only that recipient can open it. There is no identity federation
between servers. The plugin pins each server-and-user public key on first use and
blocks unexpected changes. You can compare or explicitly reset a pinned key in
**Settings → Note Colab → Trusted contacts** after verifying the fingerprint
with that person outside Note Colab. First use still trusts the chosen server's
directory response.

## Hosted service and storage

The default hosted service includes a free storage allowance. If that server
offers larger plans, the current allowance, price, and upgrade action appear
under **Settings → Note Colab → Plan & storage**. Plans are server-defined: a
self-hosted server can use different limits or offer unlimited storage with no
billing.

## Connect to your own backend

This public repository intentionally contains only the Obsidian plugin. The
hosted backend, database, web reader, and deployment configuration are separate.
You can still use your own service if it implements the Note Colab HTTP and
WebSocket contract.

At a high level, a compatible deployment needs:

- one public HTTPS origin for the web reader, `/api/v1/*`, and `/ws/*`;
- persistent storage for users, encrypted note payloads, links, and images;
- `GET /api/v1/ping` for connection checks and `GET /api/v1/info` for server
  name, registration mode, plans, and feature discovery;
- TLS, a CORS policy that permits `app://obsidian.md`, and a registration policy
  of `open`, `invite`, or `closed`;
- an optional web frontend if recipients should be able to open links outside
  Obsidian.

After deploying it:

1. Verify that `https://your-domain.example/api/v1/ping` returns a successful
   response.
2. In **Settings → Note Colab**, enter the origin only, such as
   `https://your-domain.example`—do not append `/api/v1`.
3. Select **Connect**. Note Colab prompts for a registration code when the server
   is invite-only; a closed server must be provisioned by its administrator.
4. Confirm that a new User ID appears, then create and open a test share before
   relying on the deployment.

Set a Web password and save the full User ID somewhere safe. This is strongly
recommended before buying storage: **Restore account** can use them to transfer
the same identity, notes, and plan to a replacement plugin installation. Without
them, a reset or lost device may leave the account and paid storage inaccessible.

## Privacy and security

For sharing, registration, and collaboration, the plugin connects to the
configured server and to a different share-link origin only after you approve
it. Selecting an advertised upgrade may open that server's checkout provider.
The plugin has no telemetry or advertising.

Important boundaries:

- Stored note bodies, titles, and supported embedded images are encrypted on
  the client with AES-256-GCM.
- The plugin reads and writes Markdown files, frontmatter, and supported image
  embeds in your vault as needed to share, import, mirror, and synchronize them.
- To find shared notes and their local encryption keys, the dashboard and key
  sync scan Markdown-file metadata across the vault. Note Colab does not upload
  unrelated note contents.
- Copy actions write the selected User ID, fingerprint, or share link to the
  system clipboard. The plugin does not read clipboard contents.
- Live Yjs updates are readable by the relay while a room is active.
- Link holders can decrypt the shared note, and editable-link holders can change
  it. Recipients can always copy plaintext they are allowed to read.
- Share metadata—including identifiers, permissions, timestamps, sizes,
  collaborators, image filenames, and MIME types—is visible to the server.
- The plugin stores its server credential and private key in Obsidian plugin
  data, and stores note keys in shared-note frontmatter. Anyone who can read the
  vault or plugin data may be able to use those credentials or decrypt shares.
- Older shares created by earlier clients may retain a plaintext title until a
  current owner client updates them.
- The public repository contains the plugin source, but the hosted service and
  its deployment are separate and are not included.

Use a server you trust, use HTTPS, and do not treat live collaboration as a
zero-knowledge channel.

## Development

Use a separate test vault for plugin development.

```sh
npm ci
npm test
npm run build
```

Copy `main.js` and `manifest.json` into
`<test-vault>/.obsidian/plugins/notecolab/`, then reload Obsidian.

## Support

For bugs and feature requests, [open an
issue](https://github.com/felixleopold/notecolab/issues). Please do not include
private notes, complete share links, API keys, or other credentials.

## License

The public release includes the plugin's license in the repository-root
`LICENSE` file.

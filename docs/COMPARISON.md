# Choosing sharing or vault sync

Reviewed 16 September 2026 against the projects' own documentation. This is a
comparison of documented scope, not a performance, security, or reliability
benchmark. Plans and capabilities can change.

| Project | Where it is strong | Tradeoff relative to Note Colab |
| --- | --- | --- |
| [Relay](https://github.com/no-instructions/Relay) | Folder-oriented collaboration, Yjs CRDTs, offline editing, live cursors, and support for Canvas and broader attachments. Its setup guidance explains creating a relay, joining it, and adding folders. | Better suited to a shared workspace. Note Colab centers on individual browser reading/editing links and direct delivery into Obsidian. Our folder support is Markdown plus supported images, not Relay's full document and attachment model. |
| [Share Note](https://github.com/alangrainger/share-note) | Publishing the rendered Obsidian view, including theme CSS, Dataview output, images, and links between published notes. Help and service-status links are prominent. | Prefer it when fidelity to the vault's rendered appearance is the priority. Note Colab renders shared Markdown in its own browser interface and adds collaborative editing; it does not promise to reproduce every plugin's rendering. |
| [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) | Vault synchronization, conflict handling, end-to-end encryption, and self-hosted CouchDB/object-storage options. It also documents optional peer-to-peer synchronization and its limitations. | Prefer it for control over synchronization infrastructure and whole-vault data. Operating that infrastructure adds setup work. Note Colab focuses on selected content and recipients, and its live relay can see collaboration text. |
| [Remotely Save](https://github.com/remotely-save/remotely-save) | Synchronization through existing cloud storage, optional encryption, scheduled/manual sync, and documented conflict handling. | Useful when an existing storage provider is the desired destination. Scheduled file synchronization serves a different need from shared browser editing with live cursors. Some storage providers and advanced conflict handling are paid features. |

## What we adopted

Relay's clear account, sharing, and plan presentation informed our onboarding and
yearly plan cards. Its local-first collaboration approach reinforces the need for
durable client checkpoints and reconnect tests, rather than relying only on a
live socket. We added encrypted checkpoints, version-checked server saves,
relative-position cursors, and recovery of a previous stored version when quota
permits. Those mechanisms do not establish equal real-world reliability.

Share Note's focused publishing experience informed explicit snapshot versus
updating-note choices, a preview before publishing, a cleaner reader, and visible
help/status resources. Folder publication includes an encrypted index and asks
recipients before importing new files. It does not automatically delete a
recipient's local files when the owner removes an index entry.

LiveSync and Remotely Save show the value of documented storage, conflict, and
recovery behavior. We publish our protocol, security limits, self-hosting setup,
and source so these choices are inspectable. We do not add every storage backend
or turn Note Colab into a general vault-sync tool.

## Trust comes from verifiable behavior

A shell installer, unclear operator identity, thin documentation, inaccessible
server source, and broad encryption claims make a new sharing service harder to
evaluate. Our response is Community Plugins installation, named support contact,
real screenshots, public application source and tests, explicit encryption limits,
and observable service checks. None of these substitutes for an independent audit
or a long operational track record.

Keep backups and test combinations of synchronization plugins in a disposable
vault. Multiple independent writers can still conflict at the filesystem boundary.
For Note Colab's exact guarantees and limits, read the
[security model](../SECURITY-CONSIDERATIONS.md), [protocol](PROTOCOL.md), and
[hosting policy proposal](HOSTING-POLICY.md).

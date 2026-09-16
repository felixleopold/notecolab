# NoteColab security model and accepted limitations

This is the canonical description of NoteColab's current security properties.

## Security boundary at a glance

NoteColab has two different content paths:

| Path | What the server or relay receives |
|------|-----------------------------------|
| REST note body (`notes.encrypted_content`) | AES-256-GCM ciphertext for data written by current clients |
| REST note title (`notes.title_enc`) | AES-256-GCM ciphertext for data written by current clients |
| REST image (`note_images.encrypted_data`) | AES-256-GCM ciphertext for data written by current clients |
| Live Yjs operations and awareness | Decrypted CRDT text and collaborator state, plaintext to the relay |

The client generates a random 256-bit note key. REST note bodies, titles, and
images use AES-256-GCM with a fresh 12-byte IV per encryption operation. The
share URL carries the key after `#`; URL fragments are not included in HTTP
requests. For invite-only shares, the same note key is wrapped to each recipient
with `tweetnacl` `nacl.box` (X25519/XSalsa20-Poly1305).

This provides client-encrypted REST storage for new data. It does **not** make
the entire service, relay, or live-collaboration feature zero-knowledge or
end-to-end encrypted. Public copy must preserve that distinction.

## Legacy title caveat

Current clients send `encryptedTitle` and stop sending a plaintext `title`.
When an owner with the note key opens or updates a legacy note, the client can
backfill `encryptedTitle`; the API then clears `notes.title` and updates pending
shares to use the encrypted title.

Older database rows can still contain plaintext titles until that client-driven
backfill occurs. The server cannot encrypt them in a bulk migration because it
does not have each note key. APIs and clients retain plaintext `title` as legacy
fallback metadata, so operators with database access may see those old titles.
Image filenames and MIME types, share identifiers, access modes, timestamps,
owner/collaborator identifiers, and usage sizes are also server-visible
metadata.

## Live collaboration

Yjs operates on decrypted note text. The WebSocket relay applies and broadcasts
those updates in an in-memory `Y.Doc`, so the relay process can inspect live note
text. The room is destroyed when its final connection closes.

The API no longer exposes the dormant plaintext Yjs snapshot routes. Clients
re-encrypt the current body and update the REST ciphertext for persistence.
On upgrade, the database migration securely deletes legacy `yjs_state` rows and
truncates the active WAL. The empty table remains for schema compatibility, but
no HTTP route reads or writes it. Older backups may still contain snapshots and
must age out under the operator's retention policy.

Room access control reduces outsider access but does not hide content from the
relay:

- Owners and authenticated collaborators are authorized with a plugin or web
  API key. Their write permission follows ownership or `collaborators.can_edit`.
- Anonymous clients for a current room must present the HKDF-derived room token
  once `notes.room_token_hash` has been set, plus a valid non-expired link.
  Servers store only SHA-256 of the room token.
- `public_edit` links grant write; `read_only` links grant read. The relay ignores
  Yjs document updates from read-only peers.
- `invited_edit` requires an authenticated collaborator; an anonymous invite
  link is not enough.
- Legacy notes without `room_token_hash` retain a compatibility fallback:
  non-expired non-invite links can grant access without proof of the room token.
- `WS_REQUIRE_AUTH=true` adds a server-wide WebSocket upgrade gate requiring a
  valid account API key, disabling anonymous link-based WebSocket use.
- `MAX_WS_CONNECTIONS` and `MAX_WS_PER_ROOM` bound relay connections.
- WebSocket frames are capped above the maximum valid note size, and signaling
  messages use a separate smaller cap.

### Foreground presence and public usernames

Foreground presence is a separate, ephemeral roster on the authorized Yjs
socket. It is visible in plaintext to the relay and authorized participants in
the same room, including anonymous link readers. Account identity comes from
the socket credential; clients report only active/background state and client
kind. The optional public username (`users.display_name`) is shared, falling
back to `Participant` or `Guest`, never a UID. Names are bounded plain text and
refreshed during authorization checks, so removing a name updates connected
rosters. Opaque room-scoped IDs deduplicate authenticated accounts without
exposing global identifiers; anonymous connections cannot be deduplicated as
people. Multiple accounts and false foreground reports remain possible, so
presence is never an authorization or attention signal.

Only opted-in clients receive or appear in rosters. Older clients keep their
existing synchronization behavior. Presence-only sockets use the same grants
but neither receive nor publish document/awareness state. Active leases expire
in 60 seconds (a 10-second sweep bounds cleanup); disconnect removes presence,
and transport ping/pong detects dead sockets. Each refresh receives a roster
acknowledgement for client liveness checks. Messages are capped at 256 bytes and
40 per 10 seconds per connection. Before sending a roster, the relay rechecks
current note/link grants and the original account credential, including expiry,
logout and rotation; revoked sockets close. Presence never changes write rights.
The roster stays in memory and adds no database writes or activity history.
Legacy Yjs awareness remains independent and is not trusted for roster identity.

## Public-edit write capability

Current note and link IDs contain 128 random bits. Public REST writes additionally
require a domain-separated HKDF capability derived from the note key and canonical
room ID; the server stores only its SHA-256 hash. The capability is sent as
`X-NoteColab-Write-Token` for content and image writes. Existing 32-bit links
remain compatible while their owner opens them in a current client, which stores
the new capability; legacy lookups and writes have dedicated throttles during
that migration.

A client following a link to another origin uses an explicitly anonymous API
client and omits its configured/home server API key from both HTTP headers and
WebSocket query parameters. The note-key capabilities still preserve portable
read-only and public-edit links without federation.

For direct UID delivery, the plugin pins the X25519 public key returned for each
server-origin and UID on first use. A later key change fails closed before the
plugin wraps or unwraps a note key. Settings shows a SHA-512-derived fingerprint
and requires an explicit pin reset for legitimate account recovery. This is
trust on first use: it detects later directory substitution, but the first lookup
remains controlled by the server and should be verified with the contact through
another channel when the threat warrants it.

## Authentication and key lifecycle

### Plugin identity

On a fresh installation, onboarding explains the service before an explicit
Connect action registers an account. Sharing can also initiate that connection. Existing plugin data and
custom server choices do not trigger automatic registration. Connecting to a
different server remains an explicit Settings action. Registration creates an
anonymous UID and a 256-bit random API key. The server
stores its SHA-256 hash; the Obsidian plugin stores the raw credential in its
settings. Plugin identity keys intentionally do not expire. The settings action
**Rotate API key** calls `POST /api/v1/auth/rotate-key`, immediately replaces the
server-side hash, saves the returned key locally, and leaves notes and web
sessions intact. A lost raw key cannot be reconstructed. If the user previously
set a password and retained their UID, `POST /api/v1/auth/recover-plugin` can
instead verify that password, issue a replacement plugin key, replace the X25519
public key, and keep the same account, notes, storage plan, and billing history.
The previous plugin key becomes invalid immediately. Recovery is limited to 10
attempts per IP-and-UID pair per 15 minutes.

The plugin also stores its X25519 secret key and, when web vault access is set
up, a derived vault key. Note frontmatter stores per-note sharing keys. Anyone
who can read the vault or plugin `data.json` may therefore recover credentials
or decrypt shared notes; vault sync providers are part of this trust boundary.

### Web login

Web passwords are hashed server-side with scrypt and a random salt. A successful
password or OAuth login issues a separate, revocable account session that
expires after 30 days. Sessions are independent: signing in on another browser
does not invalidate existing browsers or the plugin identity key. Users can list
their active sessions and revoke one without revoking the others. Expired keys
return `401` with `code: "session_expired"`. A legacy single web-session hash is
still accepted for compatibility with sessions issued before this migration.
Changing the account password clears that legacy credential and revokes other
modern browser sessions. When a modern browser changes the password, its own
session stays valid long enough to rewrap and upload vault keys. A password
change authenticated by the plugin key revokes every browser session but does
not rotate or invalidate the plugin key.

OAuth is optional and provider discovery advertises only fully configured
providers. The server uses a fixed configured callback origin, a hashed random
state, PKCE, and a short-lived client proof. Completion is one-use and releases
the NoteColab session only to the initiating client. Provider access tokens are
used transiently and are not stored. Account identity is the provider's stable
public subject identifier, never its email address. Linking requires an already
authenticated NoteColab account, revalidates that initiating credential at the
callback, and rejects a provider identity attached to another account. OAuth
starts are limited to 20 per IP per 10 minutes.

OAuth proves control of a NoteColab account, not knowledge of its encryption
recovery secret. It cannot derive the browser vault key, rotate the plugin API
key, or replace the plugin X25519 key. Existing encrypted notes remain locked in
a new browser until the user supplies the existing NoteColab password. Plugin
recovery remains the explicit UID-and-password flow and rotates the old plugin
credential and device keypair.

`POST /api/v1/auth/logout` revokes the presented account session. The web client
also removes the raw key and UID from `localStorage` and the vault key from
`sessionStorage`. Plugin keys cannot be logged out through this endpoint.

The browser keeps the web API key in `localStorage` and a password-derived vault
key in `sessionStorage`. JavaScript executing in the NoteColab origin can access
them, the URL-fragment note key, and displayed plaintext. The rendered Markdown
path is sanitized, but a future same-origin XSS or compromised web build remains
a high-impact client threat.

### Vault and pending-share keys

The web vault key is derived client-side with PBKDF2-SHA256 (100,000 iterations)
from the password and a server-stored random salt. It encrypts note keys before
they are saved in `vault_keys`; the vault key itself is not sent to the server.
Pending invite keys are wrapped to the recipient with `nacl.box`. Field-size,
batch, and quota limits apply to both storage areas.

## Registration, CORS, and rate limits

`REGISTRATION` controls self-registration:

- `open` (default): anyone can register, subject to the in-memory per-IP limit
  of 20 registrations per hour.
- `invite`: a matching `REGISTRATION_SECRET` must be supplied as
  `inviteCode` in the JSON body or `X-Registration-Secret`. The plugin uses the
  body form after reading `/api/v1/info`.
- `closed`: self-registration returns `403 registration_closed`; an operator
  provisions accounts through the admin API.

Login is limited in memory to 10 attempts per IP per 15 minutes. Plugin recovery
is limited to 10 attempts per IP-and-UID pair per 15 minutes. OAuth start is
limited to 20 attempts per IP per 10 minutes, before a pending attempt is stored.
These maps reset on process restart and rely on the deployment's forwarding
headers for the client IP.

Invite links use 256-bit bearer tokens. Public invite lookup returns only the
encrypted title, the permission-bearing share ID (plus a deprecated compatibility
alias), and expiry. Lookup is limited to 30 requests per IP per minute; legacy
32-bit tokens are limited to 5. Accept is limited to 10 requests per IP and per
account per minute. Legacy tokens retain a bounded migration grace period and
then return `invite_token_retired`.

`CORS_ORIGINS` is a comma-separated allowlist for web origins. It defaults to
the hosted web origin; `app://obsidian.md` is always included. CORS allows
`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`, with `Content-Type` and
`Authorization` and `X-NoteColab-Write-Token` request headers. Because
`X-Registration-Secret` is not in that
browser CORS header allowlist, cross-origin browser registration should send
`inviteCode` in the JSON body. CORS is a browser boundary, not authentication;
non-browser clients are governed by endpoint access checks.

## Quotas and billing availability

New installations default to 10 MiB and five distinct named collaborators on
Free, and 512 MiB and twenty on Pro. Existing plan rows keep their storage
configuration; existing accounts retain unlimited named collaborator entitlement.
Self-hosters can change either value; a quota of `0` or less is unlimited.
Quota accounting charges growth to the note owner and includes REST note
ciphertext, encrypted CRDT checkpoints, encrypted images, vault-key rows, and
pending-share key material. Oversized or over-quota writes return `413`; quota
responses include `code: "quota_exceeded"`. Shrinking data remains allowed, and
a downgrade does not delete existing data. Named recipients count once across
an owner’s notes; public link visitors do not consume seats. All grant paths
enforce the owner’s limit server-side. Reducing a limit preserves existing grants.
At most one previous encrypted snapshot is retained for recovery and counts
toward the owner quota. If it cannot fit, it is discarded so users can still
reduce their storage usage. It is not a long-term backup.

Paid upgrades are available only when `checkoutAvailable` is true, which
requires both `BILLING_ENABLED=true` and a configured
`BILLING_CHECKOUT_URL`. Clients must treat `/api/v1/info` and
`/api/v1/billing/info` as the current source of truth for hosted availability,
rather than relying on a static documentation claim.

The self-hosting billing endpoints are provider-agnostic configuration hooks.
The webhook is disabled without `BILLING_WEBHOOK_SECRET`, authenticates the
caller with that shared secret, requires an explicit verified-paid signal for a
Pro grant, and deduplicates non-empty provider references. Operators remain
responsible for selecting a provider, verifying its signatures in an adapter,
and defining payment operations before enabling billing.

The proposed [hosting policy](docs/HOSTING-POLICY.md) honors paid periods and
requires dated notices and export windows before any retirement or quota-related
removal. Automatic retention deletion is not implemented. The policy remains a
draft until operator, payment, notice, export, and legal review requirements are met.

## Other accepted limitations

- Anyone with a complete share URL has its note key. URL history, clipboard
  managers, screenshots, browser extensions, referrer mistakes in future code,
  or link forwarding can disclose it.
- Read-only links remain bearer capabilities. Expiry/revocation and room tokens
  constrain access, but an authorized recipient can always copy decrypted content.
- Public-edit allows anyone holding the complete link (and therefore able to
  derive the room and REST-write capabilities) to change the note.
- Share and collaborator metadata remain visible to the server.
- Password strength bounds offline resistance of the password hash and
  password-derived vault key.
- TLS is required to protect API keys, ciphertext traffic, Yjs plaintext, and
  metadata in transit. TLS does not conceal Yjs plaintext from the endpoint
  relay.
- The WebRTC signaling endpoint carries peer-discovery metadata and is
  unauthenticated unless `WS_REQUIRE_AUTH=true`.

## Security-document review checklist

For every change touching crypto, sharing, auth, WebSockets, storage, billing,
deployment configuration, or security-facing UI:

- [ ] Trace the behavior in client, API, schema, and deployment defaults.
- [ ] Separate REST ciphertext guarantees from relay-visible Yjs operations and
      snapshots; do not use blanket zero-knowledge or end-to-end claims.
- [ ] Check new-data behavior and legacy-data fallback/migration behavior.
- [ ] Verify room-token, account-token, link-mode, expiry, and read/write rules.
- [ ] Verify web-session expiry/logout and plugin-key rotation behavior.
- [ ] Verify registration modes, CORS headers/origins, rate limits, quota
      accounting, and the exact capability flags returned by `/api/v1/info`.
- [ ] Present paid upgrades only when `checkoutAvailable` is true; never invent
      a provider, secret, or production configuration.
- [ ] Update this file, [the protocol](docs/PROTOCOL.md), [self-hosting
      guidance](docs/SELF-HOSTING.md), README, and affected product copy together.
- [ ] Run focused API/plugin/web checks for every code or component touched.

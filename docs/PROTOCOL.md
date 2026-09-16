# NoteColab Plugin ↔ Server Protocol

This document is the contract between the **NoteColab Obsidian plugin** (the
client) and a **NoteColab-compatible server** (the backend). The plugin ships in
the Obsidian community store and is open; the reference server in `api/` is one
implementation. Anyone can run their own server — point the plugin's **Server
URL** setting at it and everything works, as long as the server implements the
endpoints below.

The two halves are deliberately decoupled:

- The plugin only ever talks to the server over the HTTP + WebSocket API here.
- REST note encryption happens in the clients. The server stores encrypted note
  bodies, titles, and images for new data and does not receive note keys in HTTP
  requests. Yjs live operations are a documented plaintext exception.
- The server is free to add its own concerns (quotas, billing, rate limiting)
  behind these endpoints — see [Plans, quota & billing](#plans-quota--billing).

> **Versioning.** `GET /api/v1/info` returns `protocolVersion` (currently `1`).
> All routes are under `/api/v1`. Breaking changes bump the version.

---

## Conventions

- **Base URL**: whatever the user sets as *Server URL* (e.g.
  `https://notecolab.example.com`). All paths below are relative to it.
- **Auth**: `Authorization: Bearer <apiKey>`. The API key is issued by
  `POST /api/v1/auth/register` and identifies a user. Clients must bind it to
  that server origin and omit it when following a share hosted elsewhere.
- **Encoding**: JSON request/response bodies. Binary payloads (encrypted note
  content and images) are **base64** strings inside JSON.
- **IDs**:
  - `uid` — a user's stable identifier (hex). Safe to share with collaborators.
  - `shareId` — a share *link* id (128-bit / 32 hex chars for current links;
    legacy links used 32-bit / 8 hex chars). A note can have many links.
  - `roomId` — the canonical note id used for the Yjs collaboration room
    (returned as `roomId` from `GET /notes/:shareId`).
- **Errors**: non-2xx responses carry `{ "error": "human message" }`. Some carry
  an extra machine-readable `code`, including `quota_exceeded` and
  `session_expired`.

---

## Encryption and relay-visibility model

A compliant server must treat all note material as opaque:

1. The client generates a random AES-256-GCM key per note.
2. It encrypts the note body, note title, and every embedded image with that key.
3. The key is placed in the share URL **fragment** (`…/s/<id>#<key>`). Fragments
   are never sent to the server.
4. For invite-only sharing, the note key is re-encrypted per recipient with
   X25519 (the sender's secret key + the recipient's public key) and stored as a
   *pending share*. Only the recipient can decrypt it.

For those REST fields, the server stores ciphertext and routes it. New-data
clients must not send plaintext bodies, titles, or images. Legacy rows may still
carry plaintext `title` for read compatibility; current owner clients backfill
`encryptedTitle`, clear the plaintext field, and otherwise treat a legacy title
as fallback metadata. A server cannot encrypt legacy titles by itself because it
does not have the note key.

Live collaboration is not content-encrypted from the relay. Clients apply Yjs
to decrypted note text, so WebSocket updates and awareness data are readable by
the relay while a room is active. Room tokens control who may join; they do not
encrypt Yjs content. Consequently,
implementations must not describe the complete service or live collaboration as
zero-knowledge or end-to-end encrypted.

---

## Identity is server-local (no federation)

A `uid` and its public key exist only on the deployment where the account was
registered. Every identity lookup — `GET /auth/public-key/:uid`, the
`collaborators` list, and the pending-share key exchange — is resolved against
**that single server's** database. There is no cross-server identity or
directory protocol.

Consequences a compliant client should assume:

- **`invited_edit` sharing requires the recipient to be registered on the same
  deployment as the note.** The X25519 key exchange encrypts the note key to the
  recipient's public key, which the sender can only fetch from the note's origin
  server. A recipient on a different server cannot be resolved and cannot be
  invited.
- **`read_only` and `public_edit` links are portable.** They authorize by
  `shareId`, plus key-derived room/write capabilities where required, not by
  account. The read endpoints (`GET /notes/:shareId`, `…/meta`, `…/images`) and
  the Yjs relay therefore work for a client presenting the link — including one
  whose configured server is a *different* deployment. Such a client should
  resolve the base URL from the link's own origin, not from its configured
  server.

---

## Auth

### `POST /api/v1/auth/register`
Create an anonymous user. Body (optional): `{ "publicKey": "<base64 X25519>" }`.
Returns `{ "uid", "apiKey" }`. Store both; the API key is shown only once.
This plugin identity key intentionally does not expire: it is the anonymous
account credential. Rotate it with `/auth/rotate-key` if it may be compromised.

A server may restrict who can register (see `registration` on `/api/v1/info`):
- **`open`** — anyone may register, subject to the server's per-IP rate limit.
- **`invite`** — supply the invite code as the `X-Registration-Secret` header or
  an `inviteCode` body field. A wrong/missing code returns
  `403 { "code": "invite_required" }`.
- **`closed`** — self-registration is disabled and always returns
  `403 { "code": "registration_closed" }`; users are provisioned out-of-band.

A private server may additionally require a valid `token` (API key) query
param on the `/ws/*` WebSocket upgrade; strangers get the handshake refused.

### `POST /api/v1/auth/public-key`  *(auth)*
`{ "publicKey": "<base64>" }` → `{ "ok": true }`. Upload/replace the user's
X25519 public key (used for invite-only key exchange).

### `GET /api/v1/auth/public-key/:uid`
`→ { "publicKey", "displayName" }` or `404`. Look up a user's public key so you
can encrypt a note key for them.

Current plugin clients scope this directory entry to the server origin and UID,
pin the X25519 key on first use, and reject later changes until the user explicitly
resets the pin after comparing its fingerprint out of band. This client behavior
does not authenticate the first server response and adds no wire fields.

### `POST /api/v1/auth/set-password`  *(auth)*
`{ "password", "displayName?" }` → `{ "ok": true, "vaultSalt": "<base64>" }`.
Enables web-dashboard login and returns the PBKDF2 salt used to derive the
"vault key" that wraps note keys for web access. A string `displayName`, when
supplied, uses the same trimmed 2–40 character policy as `PATCH /auth/me`; `null`
removes it. The change clears the legacy web credential and revokes other
modern browser sessions. A
modern session making the request remains valid so it can rewrap and upload
vault keys. A plugin-key request revokes all browser sessions and leaves the
plugin key unchanged.

### `POST /api/v1/auth/login`
`{ "uid", "password" }` → `{ "uid", "apiKey", "displayName", "vaultSalt" }`.
Issues an independent, revocable account-session API key that expires after 30
days. Other browser sessions and the plugin credential remain valid.

### OAuth account access

- `GET /api/v1/auth/oauth/providers` returns only configured providers as
  `{ "providers": [{ "id", "name" }] }`.
- `POST /api/v1/auth/oauth/start` accepts `{ "provider", "intent": "login" |
  "link", "clientKind": "web" | "plugin", "clientProofHash", "inviteCode?" }`.
  Linking requires authentication. The response contains a short-lived
  `{ "attemptId", "authorizationUrl", "expiresAt" }`; open the URL in the
  system browser.
- `GET /api/v1/auth/oauth/callback/:provider` is the fixed provider callback.
  The server validates state and PKCE, uses the provider's public subject as the
  identity, and never puts a NoteColab bearer token in the redirect URL.
- `POST /api/v1/auth/oauth/complete` accepts `{ "attemptId", "clientProof" }`.
  Completion is one-use and proof-bound. A login returns a new account session;
  a link returns `{ "ok": true, "linkedProvider" }`.
- `GET /api/v1/auth/identities` and `DELETE
  /api/v1/auth/identities/:provider` list and unlink sign-in methods.
- `GET /api/v1/auth/sessions` and `DELETE /api/v1/auth/sessions/:id` list and
  revoke independent browser sessions.
- `POST /api/v1/auth/unlock` accepts `{ "password" }` and returns the existing
  vault salt only after password verification.

OAuth authenticates the account only. It does not recover the password-derived
vault key and does not rotate or replace the plugin API key or X25519 key.

### `POST /api/v1/auth/recover-plugin`
`{ "uid", "password", "publicKey" }` →
`{ "uid", "apiKey", "displayName", "vaultSalt" }`.
Transfers an existing account to a replacement plugin installation. The server
verifies the account password, rotates the single active plugin API key, and
replaces the X25519 public key while preserving the user row, notes, plan,
storage, vault keys, and billing history. The old plugin credential stops
working. Pending invitations encrypted to the lost X25519 private key may need
to be resent. Invalid account, missing password setup, and wrong password all
return the same `401` response.

### `POST /api/v1/auth/logout`  *(auth, web key only)*
Revokes the presented account-session API key. `→ { "ok": true }`. Presenting
the plugin identity key returns `400`.

### `POST /api/v1/auth/rotate-key`  *(auth, plugin key only)*
Replaces the plugin identity key and returns `{ "apiKey" }` once. Presenting a
web-session key returns `403`.

### `GET /api/v1/auth/me`  *(auth)*
Profile + plan + storage:
```json
{
  "uid": "…", "displayName": null, "hasPassword": false, "hasVaultKeys": false,
  "createdAt": "…",
  "plan": "free", "planExpiresAt": null,
  "storage": { "usedBytes": 0, "limitBytes": 10485760, "unlimited": false, "usagePercent": 0 }
}
```

### `PATCH /api/v1/auth/me`  *(auth)*
`{ "username": "Public name" }` sets the optional 2–40 character username;
`{ "username": null }` removes it. Returns `{ "ok": true, "username" }`.
The name is returned as `displayName` during UID/public-key lookup. Clients may
replace it with a local contact alias that is never uploaded.

### Vault keys  *(auth)*
- `GET /api/v1/auth/vault-keys` → `{ "keys": [{ "note_share_id", "encrypted_key" }] }`
- `POST /api/v1/auth/vault-keys` `{ "keys": [{ "noteShareId", "encryptedKey" }] }` → `{ "ok", "count" }`
- `DELETE /api/v1/auth/vault-keys` → `{ "ok" }`

These store note AES keys, themselves encrypted with the user's vault key, so the
web dashboard can open notes after login. Still opaque to the server.

---

## Notes

### `POST /api/v1/notes/share`  *(auth)*
Create a note + its first share link.
```json
{ "encryptedTitle?": "<base64>", "encryptedContent": "<base64>", "accessMode?": "read_only|public_edit|invited_edit",
  "expiresIn?": 86400, "collaborators?": ["<uid>", …] }
```
→ `{ "shareId", "expiresAt" }`. `expiresIn` is seconds; ignored for
`invited_edit`. `title` is accepted only for legacy clients; new clients send
`encryptedTitle`. May return `413` (see [quota](#storage-quota-enforcement)).

### `GET /api/v1/notes/:shareId`  *(optional auth)*
Fetch a note's encrypted content via any of its links.
```json
{ "shareId", "roomId", "title", "encryptedTitle", "ownerUid", "encryptedContent", "accessMode", "canEdit",
  "expiresAt", "createdAt", "updatedAt", "contentVersion", "encryptedCrdt" }
```
`canEdit` reflects the caller's rights for this exact link. `shareId` is the
permission-bearing link ID while `roomId` is the canonical Yjs room; clients
must preserve both when they differ. `ownerUid` lets clients distinguish an
owner source note from a recipient mirror and label local imports.

### `GET /api/v1/notes/:shareId/meta`  *(optional auth)*
Metadata only (no content): `{ share_id, title, encryptedTitle, access_mode,
expires_at, created_at, updated_at, owner_uid }`. `410` if expired, `403` if
invite-only and the caller isn't allowed.

### `PATCH /api/v1/notes/:shareId`  *(owner/collaborator auth or public-edit capability)*
`{ "encryptedContent?", "encryptedCrdt?", "baseVersion?", "encryptedTitle?", "title?", "collaborators?" }` → `{ "ok", "contentVersion" }`. Edit rights
required (owner, `public_edit` link with `X-NoteColab-Write-Token`, or
`invited_edit` collaborator with edit).
`encryptedTitle`/`title`/`collaborators` are owner-only. Supplying
`encryptedTitle` clears legacy plaintext `title`. May return `413`.

Current clients send the `baseVersion` read with the encrypted body. A stale
version returns `409 { code: "snapshot_conflict", current: { contentVersion,
encryptedContent, encryptedCrdt } }` without replacing content. Clients decrypt
and merge the Yjs checkpoint before retrying. `encryptedCrdt` is an encrypted
Yjs state update and must accompany `encryptedContent`; both count toward quota.
Legacy clients may omit `baseVersion` and remain compatible, but their writes do
not have conflict protection. A legacy body-only write clears the stored CRDT
checkpoint so it cannot later overwrite the newer body.

When `encryptedCrdt` is absent or cannot be decrypted, current clients derive a
temporary Yjs seed ID from the first six bytes of
`SHA-256(UTF8(JSON.stringify(["notecolab-seed-v1", roomId, contentVersion, decryptedBody])))`,
interpreting those bytes as one big-endian base-256 integer. They insert the
body into a temporary `Y.Doc` with that client ID, apply its encoded update to
the working document, then destroy the temporary document. Normal edits always
use the working document's own random client ID. This gives simultaneous first
loads one immutable baseline without reusing a deterministic identity for edits.

### `GET /api/v1/notes/:shareId/history` *(owner or editor)*
Returns `{ currentVersion, revisions: [{ contentVersion, encryptedContent,
encryptedCrdt, createdAt }] }`. At most one previous encrypted version is retained within the owner quota.
When it cannot fit, optional history is discarded before rejecting a write,
so reducing current content remains possible.
Link expiry and invite permissions apply; view-only recipients cannot retrieve
history. Editable-link holders can read previous content with the same note key.
This is recovery assistance, not a backup or a complete change log.

### `DELETE /api/v1/notes/:shareId`  *(auth, owner)*
Delete the note and everything attached (links, images, any legacy Yjs state,
collaborators). `→ { "ok" }`.

### `GET /api/v1/notes/mine`  *(auth)*
All notes the caller owns, each with its links.

### `GET /api/v1/notes/mine/storage`  *(auth)*
Per-note storage breakdown plus the account total and quota:
```json
{ "plan": "free", "planExpiresAt": null, "storageLimit": 10485760, "unlimited": false,
  "totalBytes": 1234, "otherBytes": 42, "usagePercent": 0, "noteCount": 1, "notes": [ … ] }
```
`storageLimit <= 0` / `unlimited: true` means no quota.
`otherBytes` is the caller's quota-counted storage that is not attributable to a
single note, currently vault keys and pending-share key-exchange rows.

### `GET /api/v1/notes/shared-with-me`  *(auth)*
Notes where the caller is a collaborator.

### Share links  *(auth, owner)*
- `GET /api/v1/notes/:shareId/links`
- `POST /api/v1/notes/:shareId/links` `{ accessMode?, expiresIn?, label? }`
- `PATCH /api/v1/notes/links/:linkShareId` `{ accessMode?, expiresIn?, label? }`
- `DELETE /api/v1/notes/links/:linkShareId` (can't delete the last link)

### Collaborators  *(auth, owner)*
- `GET /api/v1/notes/:shareId/collaborators` → `{ collaborators: [{ uid, canEdit }] }`
- `POST /api/v1/notes/:shareId/collaborators` `{ uid, canEdit? }`
- `DELETE /api/v1/notes/:shareId/collaborators/:uid`

### Images
- `POST /api/v1/notes/:shareId/images` *(owner/collaborator auth or public-edit capability)* `{ filename, encryptedData, mimeType? }`. May return `413`.
- `GET /api/v1/notes/:shareId/images` → `{ images: [{ filename, mimeType }] }`
- `GET /api/v1/notes/:shareId/images/:filename` → `{ encryptedData, mimeType }`

### Pending shares (direct Obsidian delivery)
- `POST /api/v1/notes/:shareId/pending-shares` *(auth, owner)*
  `{ shares: [{ recipientUid, encryptedKey, nonce, encryptedTitle? }], encryptedTitle?, title? }`
- `GET /api/v1/notes/pending-shares/mine` *(auth)* returns the exact delivered
  `shareId` and its `accessMode`, so the plugin can explain whether the import
  is a read-only mirror or an editable sync.
- `POST /api/v1/notes/pending-shares/:id/ack` / `…/dismiss` *(auth)*
  `dismiss` revokes collaborator access only for an `invited_edit` delivery;
  `ack` only deletes the pending row after import.

### Invite links
- `POST /api/v1/notes/:shareId/invite-links` *(auth, owner)* `{ label?, maxUses?, expiresIn? }` → `{ token, expiresAt }`
- `GET /api/v1/notes/invite/:token` *(public)* → `{ encryptedTitle, shareId, noteShareId, expiresAt }`
- `POST /api/v1/notes/invite/:token/accept` *(auth)* → `{ ok, shareId, noteShareId }`
  where `shareId` is the exact invite-only link targeted when the invite was
  created, not merely the note's canonical room ID. `noteShareId` is a
  deprecated alias carrying the same value, kept so clients released before
  this change keep resolving the invite; drop it once no ≤1.25.x client is in use.
- `GET` / `DELETE /api/v1/notes/:shareId/invite-links[/:token]` *(auth, owner)*.
  The list also returns `token_version` and `legacy_valid_until` (see below).

An invite token is a **bearer credential**: anyone holding it can read the public
lookup and, once authenticated, accept the invite. So:

- **Entropy.** Tokens are 256-bit (`randomBytes(32)`, base64url, 43 chars).
  Current note/link share IDs are 128-bit (32 hex chars); legacy 32-bit IDs are
  retained behind dedicated throttling while they migrate.
- **Pre-accept metadata.** The public lookup returns only the E2E-encrypted
  title (undecryptable without the key in the link fragment), the exact
  permission-bearing share ID (plus its deprecated compatibility alias), and
  the invite's own expiry. It no longer returns the sender's display name/UID
  or any plaintext title.
- **Rate limits.** Lookup: 30/min per IP (5/min per IP for legacy-format
  tokens). Accept: 10/min per IP *and* per account. Over the limit →
  `429 { "code": "rate_limited" }` with `Retry-After`.
- **Expiry / revocation / uses.** Past `expires_at` → `410`. Deleting the link
  revokes it → `404`, indistinguishable from a token that never existed.
  `used_count >= max_uses` → `410`; the counter is incremented under a
  conditional `UPDATE` inside a transaction, so concurrent accepts can never
  exceed `max_uses`.
- **Legacy tokens.** Invites issued before this change used 8 hex chars (32
  bits). The migration stamps them `token_version = 1` with a
  `legacy_valid_until` deadline (`INVITE_LEGACY_GRACE_DAYS`, default 30 days
  from the first migrated start-up). Inside the window they behave exactly as
  before; after it, both routes return
  `410 { "code": "invite_token_retired" }` and the owner must issue a new link.
  The owner's own `expires_at` is never modified — the effective deadline is
  whichever comes first.

---

## Sessions  *(auth)*

- `POST /api/v1/sessions/create` `{ type: "fleeting"|"persistent", shareId? }` → `{ roomId, type }`
- `GET /api/v1/sessions/:roomId` → `{ room_id, type, created_at, ended_at, share_id }` (`410` if ended)
- `DELETE /api/v1/sessions/:roomId` *(creator only)* → `{ ok }`

---

## WebSockets

### Yjs relay — `GET /ws/yjs/:roomId`
Real-time CRDT sync. `:roomId` is the note's canonical `notes.share_id`. The
wire protocol is `y-websocket`-compatible: a `varUint` message type (`0` = sync,
`1` = awareness) followed by the corresponding `y-protocols` payload. On connect
the server sends sync step 1 and current awareness. These operations apply to
decrypted note text and are plaintext to the relay; the room token below is
access control, not content encryption.

Protocol v1 uses two domain-separated capabilities derived from the note AES
key. Clients SHOULD derive the room token below and an equivalent REST write
token using `info = utf8("rest-write-token:v1:" + roomId)`:

```
ikm  = raw 32 bytes of the note key (base64url-decoded)
rt   = HKDF-SHA256(
         ikm,
         salt = utf8("notecolab"),
         info = utf8("yjs-room-token:v1:" + roomId),
         length = 32 bytes
       )
       encoded base64url without padding
```

Connect with query params:

- `rt`: room token. Required once `notes.room_token_hash` is set.
- `token`: API key. Grants owner/collaborator access.
- `link`: the share-link id being used by the caller.

Servers store only `sha256(rt)`, never the note key or raw room token. Clients
that own a note SHOULD set the token with:

### `PUT /api/v1/notes/:shareId/room-token`  *(auth, owner only)*
`:shareId` may be any link for the note. Body:

```json
{ "roomToken": "<base64url, 20..100 chars>", "writeToken": "<base64url, 20..100 chars>" }
```

Stores `sha256(roomToken)` and `sha256(writeToken)` on the note and returns
`{ "ok": true }`. Older clients may omit `writeToken`; this does not clear an
already stored hash. Public-edit REST writes present the raw derived write token
as `X-NoteColab-Write-Token`.

Grant resolution on WebSocket connect:

1. Missing note closes `1008 "Note not found"`.
2. A valid `token` grants write to the owner, write to edit-capable collaborators,
   and read to read-only collaborators, without requiring a room token.
3. Otherwise, if a room-token hash is set, `rt` must hash to it or the socket closes
   `1008 "Room token required"`. Legacy notes with no hash skip only this step.
4. Otherwise, `link` must belong to the note and not be expired. `public_edit`
   grants write, `read_only` grants read, and `invited_edit` grants nothing
   without an authenticated collaborator token.
5. Legacy fallback for notes with no room-token hash: if no `link` is sent, any
   non-expired non-invited link grants read; a non-expired `public_edit` link
   grants write.
6. No grant closes `1008 "Access denied"`.

The relay also honors note/link expiry. Owners authenticated by `token` bypass
note-level expiry the same way REST routes do.

Read-only peers remain connected and receive updates, but syncStep2/update
messages from them are ignored. syncStep1 and awareness are allowed for all
granted peers.

**Limits**: `MAX_WS_CONNECTIONS` total and `MAX_WS_PER_ROOM` per room; over-limit
connections close with code `1013`.

### Foreground presence (optional extension)

Message type `4` is a `varUint` followed by a JSON `varString`. The client opts
in by sending `{ "active": true, "client": "web" }`, where `active` is a boolean
and `client` is `web` or `obsidian`. No other fields are accepted. Identity and
public username are derived from the authenticated socket, never supplied by the
client. Foreground clients refresh every 20 seconds; background transitions
send `active: false` without stopping document synchronization.

The server replies to every accepted presence message and broadcasts changes to
other opted-in connections in that room:

```json
{
  "selfId": "opaque-room-participant-id",
  "participants": [
    { "id": "opaque-room-participant-id", "name": "Public username", "client": "web" }
  ]
}
```

`participants` includes the recipient when any of their account's connections is
active. Authenticated connections for the same account count once; the first
active connection supplies the displayed client label. Anonymous sockets count
separately and use `Guest`. Accounts without a public username use `Participant`.
IDs are opaque and room-scoped, last only for the room's in-memory lifetime, and
must not be used as credentials. Names are plain text, limited to 40 characters,
and refreshed when checking current authorization. No UID is disclosed.

Only foreground notes count: clients check document visibility and window focus;
Obsidian additionally checks the active note in that window. This is a
client-reported convenience, not proof of attention. An active lease expires
after 60 seconds without refresh, checked on roster updates and a 10-second
sweep. Disconnect removes presence immediately; transport ping/pong checks run
every 30 seconds. Clients clear their roster on disconnect and should reconnect
if a presence reply is absent for 60 seconds. Presence packets are capped at 256
bytes and 40 messages per connection per 10 seconds. Invalid messages close with
`1008`. Note/link authorization and the original account credential are
rechecked before roster disclosure, including periodic sweeps; revoked clients
are closed. Presence never grants document write permission.

The optional query `presence=1` creates a presence-only connection under the same
room authorization. It receives no initial sync or awareness and no document or
awareness broadcasts, and its sync/awareness messages are ignored. This supports
Obsidian read-only mirrors without joining their document to the live CRDT.

Older clients receive no type-4 frames until they opt in, continue synchronizing,
and are excluded from the foreground count. New clients on servers that do not
implement this extension must show presence as unavailable, not infer a count
from legacy awareness. Presence and names are ephemeral relay-visible metadata,
visible to authorized room participants including anonymous link readers; they
are not written to storage or an activity log.

### WebRTC signaling — `GET /ws/signal/:roomId`
Peer discovery for optional P2P fleeting sessions.

---

## Capability discovery & info

### `GET /api/v1/info`  *(public)*
What the plugin reads to adapt to a server it has never seen:
```json
{
  "name": "NoteColab",
  "protocolVersion": 1,
  "billingEnabled": true,
  "checkoutAvailable": true,
  "proPrice": "€0.99 / year",
  "plans": {
    "free": { "name": "Free", "description": null, "quotaBytes": 10485760 },
    "basic": { "name": "Basic", "description": "100 MB storage", "quotaBytes": 104857600 },
    "pro": { "name": "Pro", "description": "512 MB storage", "quotaBytes": 536870912 },
    "supporter": { "name": "Supporter", "description": "Priority feature requests", "quotaBytes": 0 }
  },
  "registration": { "mode": "open", "inviteRequired": false }
}
```
`registration.mode` is `open` \| `invite` \| `closed` (default `open`). When
`invite`, the plugin prompts for a code and sends it to `/auth/register`; when
`closed`, it tells the user the server is private. Absent ⇒ treat as `open`.

### Service checks

- `GET /api/v1/ping` → `{ status: "ok", time }` proves the API process is responding.
- `GET /api/v1/ready` → `{ status: "ok" }` performs a side-effect-free SQLite read and
  returns `503 { status: "unavailable" }` when the database is unavailable.
- `GET /api/v1/status` → connection stats.

---

## Plans, quota & billing

A server may meter storage per user. This is **optional** — a server can offer
unlimited storage and skip billing entirely (set the free quota to unlimited).

### Storage quota enforcement
Every write that grows a user's footprint (`/notes/share`, `PATCH /notes/:id`,
image upload) is checked against the **owner's** quota. A note's
footprint = encrypted content + encrypted images. Legacy stored Yjs rows remain
counted until removed. When an
upload would exceed the quota the server responds:

```http
413 Payload Too Large
{
  "error": "Storage limit reached (9.8 MB of 10 MB used). Free up space …",
  "code": "quota_exceeded",
  "plan": "free",
  "usedBytes": 10276044,
  "limitBytes": 10485760
}
```

Clients should detect `code === "quota_exceeded"` and always surface a
free-up-space path. They may offer an upgrade only when
`checkoutAvailable === true`. A `413` **without** that code means the single
payload exceeded a fixed per-request cap.

> Quotas of `<= 0` mean unlimited; the server then never returns
> `quota_exceeded`.

### Billing  *(only when configured)*

`billingEnabled` is the master switch; `checkoutAvailable` is true only when it
is enabled and a checkout URL is configured. Clients must present paid upgrades
as unavailable unless `checkoutAvailable` is true. The public hosted deployment
currently reports both values as false, and no provider has been selected.

- `GET /api/v1/billing/info` *(optional auth)* — same shape as `/info`, plus the
  caller's `plan`, `planExpiresAt`, `recoveryConfigured`, and `storage` when
  authenticated. Clients should strongly recommend setting a password and
  retaining the UID before checkout, but may allow the user to continue after
  an explicit account-loss warning.
- `POST /api/v1/billing/checkout` *(auth)* → `{ "url", "plan", "price" }`. The
  client opens `url` in a browser. `503` if billing/checkout isn't configured.
- `POST /api/v1/billing/webhook` — called by the payment provider (or your
  adapter) to upgrade a user after payment. See
  [SELF-HOSTING.md](./SELF-HOSTING.md#billing) for the contract and how to wire a
  provider. Not called by the plugin.

The plugin never assumes a payment provider; it just opens the `url` checkout
returns. That keeps the **public plugin** independent of any **private** billing
setup.

---

## Implementing your own server

Minimum viable server for the plugin to work:

1. `POST /auth/register` and the `Authorization: Bearer` scheme.
2. Notes CRUD: `POST /notes/share`, `GET/PATCH/DELETE /notes/:shareId`,
   `GET /notes/mine`, `GET /notes/mine/storage`.
3. Images: `POST/GET /notes/:shareId/images[...]`.
4. The `/ws/yjs/:roomId` relay (reuse `y-websocket` server code).
5. `GET /api/v1/info` advertising `protocolVersion: 1` and your plans.

Everything else (invite links, pending shares, vault keys, sessions, billing) is
additive — implement what your users need. Return `unlimited` storage and
`billingEnabled: false` if you don't want quotas or payments.

The reference implementation lives in [`../api`](../api). See
[SELF-HOSTING.md](./SELF-HOSTING.md) to run it.


## Folder indexes and snapshot publishing

Folder publishing uses existing encrypted notes. An encrypted JSON index has
`kind: "notecolab-folder"`, `version: 1`, `name`, `publishedAt`, and `entries`
containing `{ path, shareUrl }`. Each child URL includes its own fragment key;
the index and its child capabilities are encrypted together before upload.
Clients validate relative Markdown paths, reject duplicates and traversal, and
require child URLs to share the index origin. A folder link grants access to all
included child links. The server does not inspect or enumerate this structure.

The optional local `colab_update_mode: snapshot` property disables automatic
owner publication for view-only snapshots. It does not create a new server
access mode. Existing clients and links retain their behavior.

## Collaborator allowances and hosting policy

Each public plan includes `collaboratorLimit` (`0` means unlimited) and
`collaboratorScope: "owner_named_recipients"`. Authenticated billing info includes
`collaborators: { limit, used, requested, ok, plan }`, accounting for legacy account
overrides. Count distinct named recipients across notes owned by the account,
excluding the owner. Anonymous link visitors do not use seats. Creation,
replacement, direct grants, and invite acceptance return `403` with
`code: "collaborator_limit"`, `limit`, `used`, `requested`, and `plan` when the
operation would exceed the allowance. Failure must not consume an invitation.
Existing grants survive downgrades; replacing/removing recipients remains possible.

`hostingPolicy` advertises the draft policy version and minimum notice/export
windows, not an active deletion job. See [the hosting policy](HOSTING-POLICY.md).

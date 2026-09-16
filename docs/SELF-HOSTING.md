# Self-hosting a NoteColab server

The public repository includes the plugin, [API](../api), [web client](../web),
and portable deployment templates. No NoteColab-hosted login or billing service
is required for a self-hosted deployment. This guide covers deployment, access
control, storage, billing, and routine operations.

If you only want to *use* NoteColab, you don't need any of this — install the
plugin and keep the default Server URL. This is for people who want to host the
backend themselves.

> The wire contract between plugin and server is documented in
> [PROTOCOL.md](./PROTOCOL.md). Any server implementing it works with the plugin.

---

## 1. Run the server

### Docker (public repository)

Use Node.js 22 for local development. For hosting, clone the public repository,
point your hostname at the host, and allow incoming ports 80 and 443:

```bash
git clone https://github.com/felixleopold/notecolab.git
cd notecolab
cp .env.example .env
# Set ADMIN_SECRET to a long random secret; set SITE_HOST to your hostname.
# Set PUBLIC_URL and CORS_ORIGINS to https://your-hostname.
scripts/check-permissions.sh --fix
APP_UID=$(id -u) APP_GID=$(id -g) docker compose -f compose.yml up -d --build --wait
```

The portable Compose file runs the API, web client, and Caddy. Caddy provisions
TLS for `SITE_HOST` and proxies `/api/*` and `/ws/*` to the API. Persistent data
lives at `NOTECOLAB_DATA_PATH` (default `./data`). Prepare custom data paths with
the same unprivileged owner and restrictive permissions; the permission helper
checks the default `data/` path. Back up the database using the procedure below.
Do not expose the API directly without a TLS proxy.

### Without Docker

```bash
(cd api && npm ci && npm run build)
(cd web && npm ci && npm run build)

# Run these as separate supervised processes:
DATABASE_PATH=/var/lib/notecolab/notecolab.db PORT=8787 node api/dist/index.js
NUXT_PUBLIC_API_URL=https://your-domain.example node web/.output/server/index.mjs
```

Create the database directory with the same restrictive ownership and modes
described below. Put both long-running commands under your service manager and
proxy them through HTTPS as described for the Compose deployment.

---

## 2. Point the plugin at your server

In Obsidian → **Settings → NoteColab**: set **Server URL** to your domain and
click **Connect**. The plugin validates `/api/v1/ping`, then registers a fresh
user against your server. (Changing the URL clears the old server's credentials,
so connect intentionally.)

### Sharing across servers

Accounts are **per-server**: registering points the plugin at one deployment, and
user identities (UIDs + public keys) only exist on that server. There is no
federation, so a user on your server cannot **invite** a user on a different
server to a note — invite-only sharing needs both parties registered on the same
deployment.

What *does* cross server boundaries is a **portable share link**
(`…/s/<shareId>#<key>`), because it carries its own host and key:

- Anyone can open a `read_only` or `public_edit` link in the browser regardless of
  which server they use — `/s/:shareId#key` loads the origin server's web app.
- The Obsidian plugin can likewise import and live-collaborate on such a link even
  when its configured **Server URL** is a different deployment; it resolves the
  API + relay from the link's origin after a one-time trust prompt.

So the practical rule: **invite-only = same server; read-only / public-edit links
travel anywhere.**

---

## 3. Environment variables

Compose reads these deployment values from `.env`:

| Variable | Default | What it does |
|----------|---------|--------------|
| `PUBLIC_URL` | `https://notecolab.com` | Public HTTPS origin passed to the web application. |
| `CORS_ORIGINS` | hosted-service origins | Comma-separated web origins allowed by the API. `app://obsidian.md` is always allowed. |
| `NOTECOLAB_DATA_PATH` | `./data` | Host directory bind-mounted at `/app/data`. |
| `APP_UID` / `APP_GID` | `1000` / `1000` | Numeric account used by the API container. Set these to the unprivileged deployment user's IDs. |

The API supports the following runtime values. The checked-in Compose file
passes all of them except `DATABASE_PATH` and `PORT`, which are intentionally
fixed to `/app/data/notecolab.db` and `8787` inside the container.

| Variable | Default | What it does |
|----------|---------|--------------|
| `ADMIN_SECRET` | — | Bearer secret for the `/api/v1/admin/*` endpoints. Unset ⇒ admin API disabled. |
| `DATABASE_PATH` | `./data/notecolab.db` | SQLite path when running without Compose. |
| `PORT` | `8787` | API + WebSocket port when running without Compose. |
| `SERVER_NAME` | `NoteColab` | Friendly name shown on `/api/v1/info`. |
| `OAUTH_CALLBACK_ORIGIN` | — | Fixed public HTTPS origin for OAuth callbacks. OAuth stays disabled when unset or invalid. |
| `OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET` | — | Enables Google only when both values and the callback origin are set. |
| `OAUTH_GITHUB_CLIENT_ID` / `OAUTH_GITHUB_CLIENT_SECRET` | — | Enables GitHub only when both values and the callback origin are set. |
| `MAX_WS_CONNECTIONS` | `200` | Global live-collab connection cap. |
| `MAX_WS_PER_ROOM` | `20` | Per-note live-collab connection cap. |
| `MAX_SIGNAL_CONNECTIONS` | `200` | Global WebRTC signaling connection cap. |

### Access control (closed-server mode)

By default the server is **open**: anyone who points the plugin at it gets a
fresh account and quota'd storage — this is what the reference server wants.
Self-hosters who want a *private* instance can lock signup down. All three
knobs default to today's open behavior, so existing deployments are unaffected.

| Variable | Default | What it does |
|----------|---------|--------------|
| `REGISTRATION` | `open` | `open` \| `invite` \| `closed`. See below. |
| `REGISTRATION_SECRET` | — | Shared invite code required when `REGISTRATION=invite`. Unset ⇒ invite mode rejects everyone. |
| `WS_REQUIRE_AUTH` | `false` | When `true`, the WebSocket upgrade (`/ws/yjs/*` **and** `/ws/signal/*`) requires a valid per-user API key. |
| `INVITE_LEGACY_GRACE_DAYS` | `30` | How long note-invite links issued before the 256-bit token change keep working. Read **once**, when the server first migrates the `invite_links` table; the deadline is then stored per row, so changing it later doesn't move existing links. `0` retires them immediately. |

- **`open`** — anyone can `POST /api/v1/auth/register` (default; guarded only by a
  per-IP rate limit).
- **`invite`** — `/api/v1/auth/register` requires the invite code, sent either as the
  `X-Registration-Secret` header or an `inviteCode` body field. The plugin
  detects this via `GET /api/v1/info` and **prompts the user for the code** on
  Connect. Wrong/missing code ⇒ `403 { code: "invite_required" }`.
- **`closed`** — `/api/v1/auth/register` always returns `403 { code:
  "registration_closed" }`. Provision users with the admin API instead:

  ```bash
  curl -X POST https://your-server/api/v1/admin/users \
    -H "Authorization: Bearer $ADMIN_SECRET" \
    -H "Content-Type: application/json" -d '{}'
  # → { "uid": "...", "apiKey": "..." }   (hand these to the user)
  ```

The registration mode is advertised on `GET /api/v1/info` as
`registration: { mode, inviteRequired }` so the plugin can adapt automatically.

### Optional Google and GitHub login

OAuth is disabled by default. Set `OAUTH_CALLBACK_ORIGIN` to the exact public
origin, without a path or trailing slash, then configure one or both provider
credential pairs. Register these exact callback URLs with the provider:

```text
https://your-domain.example/api/v1/auth/oauth/callback/google
https://your-domain.example/api/v1/auth/oauth/callback/github
```

The API advertises only providers whose ID and secret are both present. Do not
add provider buttons manually. The portable Compose deployment passes `.env`
through to the API; the maintainer Compose file maps the same variables
explicitly. Restart the API after changing credentials and confirm discovery at
`GET /api/v1/auth/oauth/providers` before testing a real login.

OAuth uses state, PKCE, a fixed callback origin, and a short-lived one-use
completion bound to the initiating client proof. Provider access tokens are not
stored. Login creates a separate revocable 30-day browser session, so logging in
on one device does not sign out another. Linking preserves the existing UID,
notes, shares, plan, plugin credential, and X25519 key. An identity already
linked to another UID is rejected.

OAuth is not encryption recovery. A returning browser still needs the existing
NoteColab password to derive its vault key. Restoring a plugin installation still
requires the UID and password and explicitly rotates that plugin credential and
device keypair. Test both login and linking with provider test accounts before
announcing either provider to users.

`WS_REQUIRE_AUTH` is complementary: closing registration makes the whole REST
API private (every endpoint already needs a per-user key), but the WebSocket
layer has two doors that stay open otherwise — the WebRTC signaling server
(`/ws/signal/*`, no auth of its own) and the legacy Yjs relay path (grants
access on a readable share link alone). Gating the upgrade on a valid bearer key
closes both at once. The plugin and web already send the key as the `token`
query param, so authenticated collaboration keeps working; only anonymous
share-link access over WebSocket is refused — which is exactly what a private
server wants.

Foreground presence uses the same authorized WebSocket endpoint and connection
limits. Read-only Obsidian notes use a presence-only connection while selected,
without enabling live document synchronization. No database migration or new
environment variable is needed. Upgrade the API before clients to enable the
participant roster; older clients retain synchronization but do not contribute
to the foreground count. Presence is held in relay memory and disappears on
disconnect or expiry. Do not log presence payloads as activity history. See
[the protocol](PROTOCOL.md) for heartbeat and expiry behavior.

**Completely private server recipe** (pairs with the unlimited-storage setup
below):

```bash
REGISTRATION=closed          # or invite + REGISTRATION_SECRET=<code>
WS_REQUIRE_AUTH=true
FREE_PLAN_BYTES=0            # unlimited storage, no upgrade prompts
ADMIN_SECRET=<a long secret> # needed to provision users in closed mode
```

### Storage quotas

| Variable | Default | What it does |
|----------|---------|--------------|
| `FREE_PLAN_BYTES` | `10485760` (10 MB) | Initial free-tier storage per user. **Set to `0` for unlimited**. |
| `PRO_PLAN_BYTES` | `536870912` (0.5 GB) | Initial paid-tier storage per user. |

These variables seed the `free` and `pro` plans when the plans table is first
created. After that, edit plans at `/admin`; changes are stored in SQLite and
take effect in quota checks immediately.

Quota is enforced on every upload that grows a user's footprint and counts
encrypted note content and CRDT checkpoints, retained revisions, images, stored
vault keys, and pending shares. Over-quota uploads get `413` with `code:
"quota_exceeded"`.
Downgrades never delete data — they just block further growth until the user
frees space or upgrades.

**Want a private server with no limits?** Set `FREE_PLAN_BYTES=0` and leave
billing off. Done.

---

## Billing

Billing is **off by default**. Turn it on only if you want to charge for a paid
plan. Plans and their checkout links are managed at `/admin`. The initial
`free` and `pro` rows are seeded from the environment variables below.

| Variable | Default | What it does |
|----------|---------|--------------|
| `BILLING_ENABLED` | `false` | Master switch. Off ⇒ upgrades are shown as unavailable and `/billing/checkout` returns 503. |
| `BILLING_CHECKOUT_URL` | — | The payment link to open. The server appends `?client_reference_id=<uid>`. |
| `BILLING_WEBHOOK_SECRET` | — | Shared secret the webhook caller must present. Unset ⇒ webhook disabled. |
| `STRIPE_WEBHOOK_SECRET` | — | Stripe endpoint signing secret (`whsec_…`) for the direct Stripe webhook. |
| `PRO_PLAN_PRICE` | `€5 / year` | Display string shown to users. |
| `PRO_PLAN_DURATION_DAYS` | `365` | How long one payment grants Pro. Renewals stack from the current expiry. |

### How the flow works

1. **Checkout** — the plugin/web calls `POST /api/v1/billing/checkout` with the
   selected plan ID. The server returns that plan's checkout URL with `client_reference_id=<uid>`
   appended. The client opens it in a browser. The user pays at the provider.
2. **Webhook** — after a successful payment, the provider (or a tiny adapter you
   run) calls `POST /api/v1/billing/webhook`. The server verifies the secret,
   finds the user by uid, sets the configured plan, and stamps `plan_expires_at`.

The UI enables its upgrade action only when `/api/v1/info` reports
`checkoutAvailable: true`, which requires `BILLING_ENABLED=true` and an active
non-default plan with a checkout URL. Enabling only the master switch is not enough.

### Direct Stripe webhook

Point Stripe at:

```text
POST https://your-server/api/v1/billing/stripe/webhook
```

Set `STRIPE_WEBHOOK_SECRET` to that endpoint's `whsec_…` secret and subscribe to
`checkout.session.completed`. NoteColab verifies the signature against the
untouched body, enforces Stripe's five-minute timestamp tolerance, and grants a
plan only when `payment_status` is `paid`. This follows Stripe's
[raw-body signature verification guidance](https://docs.stripe.com/webhooks/signature).
It maps a payment to a plan using, in order:

1. Payment Link metadata `plan_id=<your-plan-id>` (Stripe
   [copies Payment Link metadata to the Checkout Session](https://docs.stripe.com/api/payment-link/object)).
2. The plan's `stripePaymentLinkId` value, such as `plink_…`.
3. The sole configured checkout plan, when exactly one exists.

Stripe Payment Links [carry the appended `client_reference_id` into the completed
Checkout Session](https://docs.stripe.com/payment-links/url-parameters). Configure
either metadata or the Payment Link ID when you offer more than one paid plan.

### Webhook contract

```http
POST /api/v1/billing/webhook
Authorization: Bearer <BILLING_WEBHOOK_SECRET>      # or  X-Webhook-Secret: <secret>
Content-Type: application/json

{
  "uid": "<user uid>",        // or "clientReferenceId", or Stripe data.object.client_reference_id
  "plan": "pro",              // required configured plan ID
  "paid": true,               // REQUIRED for a non-default plan
  "durationDays": 365,        // optional; defaults to the plan term; null = permanent
  "provider": "stripe",       // optional, for the audit trail
  "providerRef": "cs_123"     // optional, used for idempotency (deduped on repeat)
}
```

**The shared secret authenticates the caller; it is not proof of payment.** So a
non-default upgrade is only granted when the request carries `"paid": true`.

Set this only from a component you trust to have confirmed the payment. For
Stripe, prefer the direct signature-verifying endpoint above.

A paid-plan request without that signal is ignored with `400`. This prevents
forwarding a non-payment event (e.g. `checkout.session.expired`, a `$0`/setup
session, or an async `unpaid` checkout) from granting a plan for free. Grants of
the configured default plan need no paid signal. The webhook also requires
`BILLING_ENABLED=true`.

The generic endpoint remains useful for another provider adapter. It is not a
Stripe endpoint and does not verify `Stripe-Signature`.

### Granting Pro manually

With `ADMIN_SECRET` set:

```bash
curl -X POST https://your-server/api/v1/admin/users/<uid>/plan \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"plan":"pro","durationDays":365}'   # durationDays: 0 or null = permanent; plan:"free" to downgrade
```

Every grant (webhook or admin) is recorded in the `subscriptions` table for
auditing and renewal math.

### Deleting a user

With `ADMIN_SECRET` set:

```bash
curl -X DELETE https://your-server/api/v1/admin/users/<uid> \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

This removes the user, their owned notes and cascaded note data, plus
collaborator and pending-share rows keyed directly by that UID.

---

## Admin API

All under `/api/v1/admin/*`, `Authorization: Bearer <ADMIN_SECRET>`:

The private web dashboard is available at `/admin`. Enter `ADMIN_SECRET` there;
it is kept in session storage for the current tab. The dashboard provides user
provisioning/deletion, plan assignment, storage stats, and plan creation/editing.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/stats` | GET | DB + storage stats |
| `/notes` | GET | All notes with storage breakdown |
| `/users` | GET | Per-user storage **and plan** |
| `/users` | POST | Provision a user directly → `{ uid, apiKey }` (for `REGISTRATION=closed`) |
| `/notes/:id` | DELETE | Delete a note |
| `/users/:uid` | DELETE | Delete a user and their owned/collaboration rows |
| `/users/:uid/plan` | POST | Grant/revoke a plan |
| `/purge-stale?days=N` | POST | Delete notes not updated in N days |
| `/vacuum` | POST | Reclaim disk space |

---

## Operational notes

- **Persistence is client-driven.** The Yjs relay holds room state in memory;
  the durable current note body and CRDT checkpoint live as ciphertext in
  `notes.encrypted_content` and `notes.encrypted_crdt`. Upgrades purge obsolete
  plaintext `yjs_state` snapshots from the active database. Older backups may
  still contain them, so expire pre-upgrade backups according to your retention
  policy. Keep the SQLite file on a persistent volume and back it up.
- **Cleanup cron** runs every 5 min: deletes notes past their explicit expiry, expired
  authentication handoffs, and ended sessions; `VACUUM`s daily. Age alone does not
  delete unexpired notes. It does not automatically delete content for plan expiry
  or service retirement.
- **Security**: see [../SECURITY-CONSIDERATIONS.md](../SECURITY-CONSIDERATIONS.md).
  Serve over HTTPS — note keys live in URL fragments and must never transit
  plaintext channels.

### Filesystem permissions

Run deployment as a dedicated, unprivileged host account. The required modes
are `0600` for `.env`, the SQLite DB/WAL/SHM files and retained backups, and
`0700` for `data/`, `backups/`, and their subdirectories. The Compose service
uses `APP_UID`/`APP_GID` to run the API as that account and starts it with
`umask 077`, so newly created SQLite sidecar files stay private.

One time, before the first hardened deployment:

```bash
cd /path/to/note-colab
APP_UID=$(id -u) scripts/check-permissions.sh --fix
APP_UID=$(id -u) scripts/check-permissions.sh --check
```

The script never reads file contents, changes ownership, or removes/moves
historical databases. It refuses symlinks, unexpected file types, root
deployment, and paths owned by another UID. If ownership differs, stop and
identify every copy before using a narrowly targeted `chown`; do not make the
files world-accessible to work around it. Retained SQLite copies beside the
checkout and files under `backups/` are checked in place.

For a private online backup, use SQLite's backup command rather than copying
only the live `.db` file while WAL mode is active:

```bash
umask 077
mkdir -p -m 700 backups
sqlite3 data/notecolab.db ".backup 'backups/notecolab-$(date +%Y%m%d-%H%M%S).db'"
scripts/check-permissions.sh --check
```

Keep the backup retention policy explicit. Review and archive/delete obsolete
copies separately only after confirming they are no longer needed; deployment
never does this automatically.

### Readiness and deployment checks

The API container health check calls `GET /api/v1/ready`, which reads SQLite's
schema catalog without mutating user data. `docker compose up --wait` waits for
that check and for the remaining containers to start. Then use the included
smoke-test script to check the public homepage, `/api/v1/info`, and that an
unauthenticated `/api/v1/notes/mine` request returns `401`.

Manual checks:

```bash
docker compose ps
curl --fail --max-time 15 https://your-server/api/v1/ready
PUBLIC_URL=https://your-server scripts/smoke-test.sh
sqlite3 data/notecolab.db 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
```

`integrity_check` should print `ok`; `foreign_key_check` should print no rows.

### Rollback and recovery

For an application-only rollback, check out the previously known-good revision
and rerun Compose with the same deployment UID/GID. Do not replace or downgrade
the database merely because a readiness check failed:

```bash
git checkout <known-good-revision>
APP_UID=$(id -u) APP_GID=$(id -g) \
  docker compose up -d --build --wait --wait-timeout 120 api web
PUBLIC_URL=https://your-server scripts/smoke-test.sh
```

Before restoring data, stop the API and move the failed database plus all of its
`-wal`/`-shm` sidecars together into a new private quarantine directory. A
self-contained backup must be installed as the only database; never leave old
sidecars beside it. Verify the selected backup, re-run the permission check,
then start and validate:

```bash
docker compose stop api
recovery_dir="backups/recovery-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$recovery_dir"
for path in data/notecolab.db data/notecolab.db-wal data/notecolab.db-shm; do
  [ ! -e "$path" ] || mv -- "$path" "$recovery_dir/"
done
install -m 600 /path/to/verified-backup.db data/notecolab.db
test ! -e data/notecolab.db-wal
test ! -e data/notecolab.db-shm
APP_UID=$(id -u) scripts/check-permissions.sh --check
sqlite3 data/notecolab.db 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
APP_UID=$(id -u) APP_GID=$(id -g) \
  docker compose up -d --wait --wait-timeout 120 api web
PUBLIC_URL=https://your-server scripts/smoke-test.sh
```

If ownership is uncertain, the backup is incomplete, or integrity checks fail,
leave the API stopped and investigate rather than risking data loss.

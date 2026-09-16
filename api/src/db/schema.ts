import Database from 'better-sqlite3';
import { migratePlanLimits } from '../collaboration-limits.js';
import { migrateAccounts } from '../account-migration.js';
import { join } from 'path';
import {
  BILLING_CHECKOUT_URL,
  FREE_QUOTA_BYTES,
  PRO_DURATION_DAYS,
  PRO_PRICE,
  PRO_QUOTA_BYTES,
} from '../plans.js';
import { legacyInviteGraceDays } from '../invites.js';

const DB_PATH = process.env.DATABASE_PATH || join(process.cwd(), 'data', 'notecolab.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

export function isDatabaseReady(database?: Database.Database): boolean {
  const row = (database ?? getDb())
    .prepare('SELECT COUNT(*) AS schemaEntries FROM sqlite_schema')
    .get() as { schemaEntries: number };
  return Number.isInteger(row.schemaEntries) && row.schemaEntries >= 0;
}

export function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL UNIQUE,
      api_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      share_id TEXT NOT NULL UNIQUE,
      title TEXT,
      encrypted_content BLOB,
      encrypted_crdt BLOB,
      content_version INTEGER NOT NULL DEFAULT 1,
      room_token_hash TEXT DEFAULT NULL,
      write_token_hash TEXT DEFAULT NULL,
      access_mode TEXT NOT NULL DEFAULT 'read_only' CHECK(access_mode IN ('public_edit', 'invited_edit', 'read_only')),
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS collaborators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_uid TEXT NOT NULL,
      can_edit INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(note_id, user_uid)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
      creator_uid TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('fleeting', 'persistent')),
      room_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS yjs_state (
      note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      doc_update BLOB,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notes_share_id ON notes(share_id);
    CREATE INDEX IF NOT EXISTS idx_notes_expires_at ON notes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_room_id ON sessions(room_id);
    CREATE INDEX IF NOT EXISTS idx_collaborators_note_uid ON collaborators(note_id, user_uid);

    CREATE TABLE IF NOT EXISTS note_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      encrypted_data BLOB NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(note_id, filename)
    );

    CREATE INDEX IF NOT EXISTS idx_note_images_note_filename ON note_images(note_id, filename);

    -- Share links: multiple links per note with independent access control and expiry
    CREATE TABLE IF NOT EXISTS share_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      share_id TEXT NOT NULL UNIQUE,
      label TEXT DEFAULT '',
      access_mode TEXT NOT NULL DEFAULT 'read_only' CHECK(access_mode IN ('public_edit', 'invited_edit', 'read_only')),
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_share_links_share_id ON share_links(share_id);
    CREATE INDEX IF NOT EXISTS idx_share_links_note_id ON share_links(note_id);
  `);

  // Current clients persist only encrypted REST content. Remove snapshots from
  // the retired plaintext Yjs route, overwriting their SQLite pages and
  // truncating the WAL so the deleted text is not left in the active database.
  // The empty table remains for rollback/schema compatibility.
  const legacyYjsRows = db.prepare('SELECT COUNT(*) AS count FROM yjs_state').get() as { count: number };
  if (legacyYjsRows.count > 0) {
    const previousSecureDelete = db.pragma('secure_delete', { simple: true }) as number;
    try {
      db.pragma('secure_delete = ON');
      db.exec('DELETE FROM yjs_state');
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.pragma(`secure_delete = ${previousSecureDelete}`);
    }
  }

  // Migrate existing notes into share_links (one-time, for notes without a link row)
  const needsMigration = db.prepare(
    "SELECT COUNT(*) as count FROM notes WHERE share_id NOT IN (SELECT share_id FROM share_links)"
  ).get() as { count: number };

  if (needsMigration.count > 0) {
    db.prepare(`
      INSERT OR IGNORE INTO share_links (note_id, share_id, label, access_mode, expires_at, created_at)
      SELECT id, share_id, 'Original', access_mode, expires_at, created_at FROM notes
      WHERE share_id NOT IN (SELECT share_id FROM share_links)
    `).run();
  }

  // Add room token hash to notes (key-derived proof for Yjs relay access).
  const noteCols = db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
  const noteColNames = noteCols.map((c) => c.name);
  if (!noteColNames.includes('room_token_hash')) {
    db.exec("ALTER TABLE notes ADD COLUMN room_token_hash TEXT DEFAULT NULL");
  }
  if (!noteColNames.includes('write_token_hash')) {
    db.exec("ALTER TABLE notes ADD COLUMN write_token_hash TEXT DEFAULT NULL");
  }
  if (!noteColNames.includes('title_enc')) {
    db.exec("ALTER TABLE notes ADD COLUMN title_enc TEXT DEFAULT NULL");
  }
  if (!noteColNames.includes('encrypted_crdt')) {
    db.exec("ALTER TABLE notes ADD COLUMN encrypted_crdt BLOB DEFAULT NULL");
  }
  if (!noteColNames.includes('content_version')) {
    db.exec("ALTER TABLE notes ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1");
  }

  // Encrypted checkpoints make accidental replacement recoverable without
  // giving the server access to note text or live Yjs state. Retention is
  // enforced by the write route.
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      encrypted_content BLOB,
      encrypted_crdt BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(note_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_note_revisions_note_version
      ON note_revisions(note_id, version DESC);
  `);

  // Add password_hash and display_name to users (for optional web login)
  const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const colNames = userCols.map((c) => c.name);
  if (!colNames.includes('password_hash')) {
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT NULL");
  }
  if (!colNames.includes('display_name')) {
    db.exec("ALTER TABLE users ADD COLUMN display_name TEXT DEFAULT NULL");
  }
  if (!colNames.includes('last_seen_at')) {
    db.exec("ALTER TABLE users ADD COLUMN last_seen_at TEXT DEFAULT NULL");
  }
  if (!colNames.includes('web_api_key_hash')) {
    db.exec("ALTER TABLE users ADD COLUMN web_api_key_hash TEXT DEFAULT NULL");
  }
  if (!colNames.includes('web_api_key_expires_at')) {
    db.exec("ALTER TABLE users ADD COLUMN web_api_key_expires_at TEXT DEFAULT NULL");
  }
  if (!colNames.includes('public_key')) {
    db.exec("ALTER TABLE users ADD COLUMN public_key TEXT DEFAULT NULL");
  }
  if (!colNames.includes('vault_salt')) {
    db.exec("ALTER TABLE users ADD COLUMN vault_salt TEXT DEFAULT NULL");
  }
  // Billing: which storage plan the user is on and when it lapses.
  // 'free' | 'pro'. plan_expires_at NULL = no expiry (free, or permanent grant).
  const addedPlanColumn = !colNames.includes('plan');
  if (addedPlanColumn) {
    db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
  }
  if (!colNames.includes('plan_expires_at')) {
    db.exec("ALTER TABLE users ADD COLUMN plan_expires_at TEXT DEFAULT NULL");
  }

  // Subscriptions: an audit trail of plan grants (payments, admin actions,
  // renewals). The authoritative current plan lives on users.plan; this table
  // records how the user got there so renewals and refunds are traceable.
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'webhook',  -- 'webhook' | 'admin'
      provider TEXT,                            -- e.g. 'stripe', 'kofi'
      provider_ref TEXT,                        -- provider payment/session id (idempotency)
      starts_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_provider_ref
      ON subscriptions(provider_ref) WHERE provider_ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      quota_bytes INTEGER NOT NULL,
      price_label TEXT,
      duration_days INTEGER,
      checkout_url TEXT,
      stripe_payment_link_id TEXT UNIQUE,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_one_default
      ON plans(is_default) WHERE is_default = 1;
  `);

  const planCols = db.prepare("PRAGMA table_info(plans)").all() as { name: string }[];
  if (!planCols.some((column) => column.name === 'description')) {
    db.exec("ALTER TABLE plans ADD COLUMN description TEXT DEFAULT NULL");
  }

  db.prepare(`
    INSERT OR IGNORE INTO plans
      (id, name, quota_bytes, price_label, duration_days, checkout_url, active, is_default, sort_order)
    VALUES ('free', 'Free', ?, NULL, NULL, NULL, 1, 1, 0)
  `).run(FREE_QUOTA_BYTES);
  db.prepare(`
    INSERT OR IGNORE INTO plans
      (id, name, quota_bytes, price_label, duration_days, checkout_url, active, is_default, sort_order)
    VALUES ('pro', 'Pro', ?, ?, ?, ?, 1, 0, 10)
  `).run(PRO_QUOTA_BYTES, PRO_PRICE, PRO_DURATION_DAYS, BILLING_CHECKOUT_URL || null);

  // One-time grandfather: the first time quotas are introduced (the `plan`
  // column was just added), any existing user whose stored footprint already
  // exceeds the new free cap is granted permanent Pro. This is so that turning
  // on quotas never strands data users uploaded under the old (unlimited/500 MB)
  // terms — they keep working; only *new* growth past their (now Pro) limit is
  // blocked. New sign-ups get the default 'free'. Skipped when the free tier is
  // already unlimited (FREE_QUOTA_BYTES <= 0). To instead grandfather *every*
  // pre-existing user, drop the `WHERE used > ?` filter.
  if (addedPlanColumn && FREE_QUOTA_BYTES > 0) {
    const usageRows = db.prepare(`
      SELECT u.id AS id,
        COALESCE((SELECT SUM(LENGTH(encrypted_content)) FROM notes WHERE user_id = u.id), 0)
        + COALESCE((SELECT SUM(LENGTH(ni.encrypted_data)) FROM note_images ni
                      JOIN notes n ON ni.note_id = n.id WHERE n.user_id = u.id), 0) AS used
      FROM users u
    `).all() as { id: number; used: number }[];

    const grant = db.prepare("UPDATE users SET plan = 'pro', plan_expires_at = NULL WHERE id = ?");
    const audit = db.prepare(
      "INSERT INTO subscriptions (user_id, plan, source, provider) VALUES (?, 'pro', 'admin', 'grandfather')",
    );
    const grandfather = db.transaction(() => {
      for (const u of usageRows) {
        if (u.used > FREE_QUOTA_BYTES) {
          grant.run(u.id);
          audit.run(u.id);
        }
      }
    });
    grandfather();
  }

  // Vault keys: note AES keys encrypted with user's PBKDF2-derived vault key
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      note_share_id TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, note_share_id)
    );

    CREATE INDEX IF NOT EXISTS idx_vault_keys_user ON vault_keys(user_id);
  `);

  // Pending shares: encrypted key exchange for auto-import
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      share_id TEXT NOT NULL,
      recipient_uid TEXT NOT NULL,
      sender_uid TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      nonce TEXT NOT NULL,
      title TEXT,
      dismissed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(share_id, recipient_uid)
    );

    CREATE INDEX IF NOT EXISTS idx_pending_shares_recipient ON pending_shares(recipient_uid, dismissed);
  `);

  const pendingShareCols = db.prepare("PRAGMA table_info(pending_shares)").all() as { name: string }[];
  const pendingShareColNames = pendingShareCols.map((c) => c.name);
  if (!pendingShareColNames.includes('title_enc')) {
    db.exec("ALTER TABLE pending_shares ADD COLUMN title_enc TEXT DEFAULT NULL");
  }

  // Invite links: token-based invite for users without UIDs
  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      link_share_id TEXT,
      created_by_uid TEXT NOT NULL,
      label TEXT DEFAULT '',
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_invite_links_token ON invite_links(token);
    CREATE INDEX IF NOT EXISTS idx_invite_links_note ON invite_links(note_id);
  `);

  const inviteCols = db.prepare("PRAGMA table_info(invite_links)").all() as { name: string }[];
  if (!inviteCols.some((column) => column.name === 'link_share_id')) {
    db.exec('ALTER TABLE invite_links ADD COLUMN link_share_id TEXT');
  }

  // Invite tokens went from 32 bits to 256 bits. Links already handed out can't
  // be re-issued, so instead of breaking
  // them silently they are stamped as `token_version = 1` and given a bounded
  // grace period (INVITE_LEGACY_GRACE_DAYS, default 30) after which they stop
  // resolving with a distinct `invite_token_retired` error. The owner's own
  // `expires_at` is left untouched; the effective deadline is whichever comes
  // first. Rows created from here on are version 2 and never expire this way.
  if (!inviteCols.some((c) => c.name === 'token_version')) {
    db.exec("ALTER TABLE invite_links ADD COLUMN token_version INTEGER NOT NULL DEFAULT 2");
    db.exec("ALTER TABLE invite_links ADD COLUMN legacy_valid_until TEXT DEFAULT NULL");
    db.prepare(
      "UPDATE invite_links SET token_version = 1, legacy_valid_until = datetime('now', ?)"
    ).run(`+${legacyInviteGraceDays()} days`);
  }
  migratePlanLimits(db);
  migrateAccounts(db);
}

export function closeDb() {
  if (db) {
    db.close();
  }
}

import type Database from 'better-sqlite3';

/**
 * Account and OAuth tables are kept separate from the base content schema so
 * authentication can evolve without coupling note migrations to providers.
 */
export function migrateAccounts(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, provider_subject),
      UNIQUE(user_id, provider)
    );

    CREATE INDEX IF NOT EXISTS idx_account_identities_user
      ON account_identities(user_id);

    CREATE TABLE IF NOT EXISTS account_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      client_label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_account_sessions_user
      ON account_sessions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_account_sessions_expiry
      ON account_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS oauth_attempts (
      id TEXT PRIMARY KEY,
      state_hash TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      intent TEXT NOT NULL CHECK(intent IN ('login', 'link')),
      client_kind TEXT NOT NULL CHECK(client_kind IN ('web', 'plugin')),
      client_proof_hash TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      initiating_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      initiating_key_type TEXT CHECK(initiating_key_type IN ('plugin', 'web', 'session')),
      initiating_credential_hash TEXT,
      initiating_session_id TEXT,
      completed_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      registration_allowed INTEGER NOT NULL DEFAULT 0,
      initiating_ip TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'complete', 'failed', 'consumed')),
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_attempts_expiry
      ON oauth_attempts(expires_at);
  `);

  const attemptColumns = new Set(
    (db.prepare('PRAGMA table_info(oauth_attempts)').all() as { name: string }[])
      .map((column) => column.name),
  );
  if (!attemptColumns.has('initiating_key_type')) {
    db.exec("ALTER TABLE oauth_attempts ADD COLUMN initiating_key_type TEXT CHECK(initiating_key_type IN ('plugin', 'web', 'session'))");
  }
  if (!attemptColumns.has('initiating_credential_hash')) {
    db.exec('ALTER TABLE oauth_attempts ADD COLUMN initiating_credential_hash TEXT');
  }
  if (!attemptColumns.has('initiating_session_id')) {
    db.exec('ALTER TABLE oauth_attempts ADD COLUMN initiating_session_id TEXT');
  }
}

import type Database from 'better-sqlite3';
import { getDb } from '../db/schema.js';

export function cleanupExpiredData(db: Database.Database) {
  // 1. Delete notes with explicit expiry that have expired
  const expired = db.prepare(`
    DELETE FROM notes WHERE expires_at IS NOT NULL AND julianday(expires_at) < julianday('now')
  `).run();

  if (expired.changes > 0) {
    console.log(`[cleanup] Removed ${expired.changes} expired note(s)`);
  }

  // Unexpired notes are retained until a notified retention policy is implemented.
  // Age alone must never delete content during a paid period or export window.
  db.prepare("DELETE FROM oauth_attempts WHERE julianday(expires_at) < julianday('now', '-1 day')").run();
  db.prepare("DELETE FROM account_sessions WHERE julianday(expires_at) < julianday('now', '-30 days') OR julianday(revoked_at) < julianday('now', '-30 days')").run();

  // 3. Clean up ended sessions older than 24h
  db.prepare(`
    DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < datetime('now', '-1 day')
  `).run();
}

export function startCleanupCron() {
  // Cleanup every 5 minutes
  const cleanupInterval = 5 * 60 * 1000;
  // VACUUM once a day
  const vacuumInterval = 24 * 60 * 60 * 1000;

  const cleanup = () => {
    try {
      const db = getDb();

      cleanupExpiredData(db);
    } catch (err) {
      console.error('[cleanup] Error:', err);
    }
  };

  const vacuum = () => {
    try {
      const db = getDb();
      const beforePages = (db.prepare('PRAGMA page_count').get() as any).page_count;
      const pageSize = (db.prepare('PRAGMA page_size').get() as any).page_size;

      db.exec('VACUUM');

      const afterPages = (db.prepare('PRAGMA page_count').get() as any).page_count;
      const reclaimed = (beforePages - afterPages) * pageSize;
      if (reclaimed > 0) {
        console.log(`[vacuum] Reclaimed ${(reclaimed / 1024 / 1024).toFixed(2)} MB`);
      }
    } catch (err) {
      console.error('[vacuum] Error:', err);
    }
  };

  // Run cleanup immediately, then on interval
  cleanup();
  setInterval(cleanup, cleanupInterval);

  // Run vacuum after 1 minute (let startup settle), then daily
  setTimeout(() => {
    vacuum();
    setInterval(vacuum, vacuumInterval);
  }, 60 * 1000);
}

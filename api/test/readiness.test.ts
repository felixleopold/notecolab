import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { isDatabaseReady } from '../src/db/schema.js';

test('database readiness performs a safe SQLite read', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE readiness_fixture (id INTEGER PRIMARY KEY)');
  assert.equal(isDatabaseReady(db), true);
  db.close();
  assert.throws(() => isDatabaseReady(db), /database connection is not open/);
});

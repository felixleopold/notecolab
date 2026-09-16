import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'notecolab-registration-limit-'));
process.env.DATABASE_PATH = join(dataDir, 'test.db');

test('registration permits 20 accounts per IP and returns retry timing after that', async (t) => {
  const [{ closeDb }, { default: auth, REGISTRATION_LIMIT, resetRegistrationRateLimits }] = await Promise.all([
    import('../src/db/schema.js'),
    import('../src/routes/auth.js'),
  ]);
  t.after(() => {
    resetRegistrationRateLimits();
    closeDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  for (let index = 0; index < REGISTRATION_LIMIT; index++) {
    const response = await auth.request('/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '192.0.2.1',
      },
      body: JSON.stringify({ publicKey: `test-public-key-${index}` }),
    });
    assert.equal(response.status, 200, `registration ${index + 1} should succeed`);
  }

  const blocked = await auth.request('/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '192.0.2.1',
    },
    body: JSON.stringify({ publicKey: 'blocked-public-key' }),
  });

  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.deepEqual(await blocked.json(), { error: 'Too many registrations — try again later' });
});

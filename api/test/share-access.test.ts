import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { legacyShareRateLimit, resetLegacyShareRateLimits } from '../src/share-access.ts';

function testApp() {
  const app = new Hono();
  app.get('/:shareId', legacyShareRateLimit, (c) => c.json({ ok: true }));
  return app;
}

test('legacy share reads are throttled without touching current IDs', async () => {
  resetLegacyShareRateLimits();
  const app = testApp();
  const headers = { 'x-forwarded-for': '192.0.2.10' };

  for (let i = 0; i < 120; i++) {
    assert.equal((await app.request('/deadbeef', { headers })).status, 200);
  }
  assert.equal((await app.request('/deadbeef', { headers })).status, 429);

  for (let i = 0; i < 200; i++) {
    assert.equal(
      (await app.request('/0123456789abcdef0123456789abcdef', { headers })).status,
      200,
    );
  }
});

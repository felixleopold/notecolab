import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validStripeSignature } from '../src/routes/billing.js';

test('Stripe signatures cover the untouched payload and reject stale deliveries', () => {
  const now = Date.UTC(2026, 7, 9, 12, 0, 0);
  const timestamp = Math.floor(now / 1000);
  const payload = '{"type":"checkout.session.completed"}';
  const secret = 'whsec_test_secret';
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const header = `t=${timestamp},v1=${signature}`;

  assert.equal(validStripeSignature(payload, header, secret, now), true);
  assert.equal(validStripeSignature(`${payload} `, header, secret, now), false);
  assert.equal(validStripeSignature(payload, header, secret, now + 301_000), false);
});

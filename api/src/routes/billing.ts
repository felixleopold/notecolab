import { checkCollaboratorCapacity } from '../collaboration-limits.js';
import { Hono } from 'hono';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { getDb } from '../db/schema.js';
import { authMiddleware, optionalAuthMiddleware } from './middleware.js';
import { grantPlan, getQuotaStatus, loadUserPlan } from '../quota.js';
import {
  BILLING_ENABLED,
  BILLING_WEBHOOK_SECRET,
  STRIPE_WEBHOOK_SECRET,
  checkoutPlans,
  getPlan,
  publicPlanInfo,
} from '../plans.js';
import type { AppEnv } from '../env.js';

const billing = new Hono<AppEnv>();

billing.get('/info', optionalAuthMiddleware, (c) => {
  const db = getDb();
  const info = publicPlanInfo(db);
  const user = c.get('user');
  if (!user) return c.json(info);
  const status = getQuotaStatus(db, loadUserPlan(db, user.id));
  const recovery = db.prepare('SELECT password_hash IS NOT NULL AS configured FROM users WHERE id = ?')
    .get(user.id) as { configured: number };
  const currentPlan = getPlan(db, status.plan);
  if (currentPlan && !info.plans[currentPlan.id]) {
    info.plans[currentPlan.id] = {
      id: currentPlan.id, name: currentPlan.name, description: currentPlan.description, quotaBytes: currentPlan.quotaBytes,
      priceLabel: currentPlan.priceLabel, durationDays: currentPlan.durationDays,
      checkoutAvailable: false, isDefault: currentPlan.isDefault,
      collaboratorLimit: currentPlan.collaboratorLimit, collaboratorScope: 'owner_named_recipients',
    };
  }
  const nextPlan = checkoutPlans(db).find((plan) =>
    plan.id !== status.plan && (plan.quotaBytes <= 0 || (status.limitBytes > 0 && plan.quotaBytes > status.limitBytes))
  ) ?? null;
  return c.json({
    ...info,
    checkoutAvailable: !!nextPlan,
    upgradePlanId: nextPlan?.id ?? null,
    plan: status.plan,
    planExpiresAt: status.planExpiresAt,
    recoveryConfigured: !!recovery.configured,
    collaborators: checkCollaboratorCapacity(db, user.id, []),
    storage: {
      usedBytes: status.usedBytes,
      limitBytes: status.limitBytes,
      unlimited: status.unlimited,
      usagePercent: status.usagePercent,
    },
  });
});

billing.post('/checkout', authMiddleware, async (c) => {
  if (!BILLING_ENABLED) return c.json({ error: 'Billing is disabled on this server' }, 503);
  const db = getDb();
  const body = await c.req.json<{ planId?: string }>().catch(() => ({} as { planId?: string }));
  const offered = checkoutPlans(db);
  const plan = body.planId ? offered.find((candidate) => candidate.id === body.planId) : offered[0];
  if (!plan?.checkoutUrl) return c.json({ error: 'That plan is not available for checkout' }, 400);

  let url: string;
  try {
    const checkout = new URL(plan.checkoutUrl);
    checkout.searchParams.set('client_reference_id', c.get('user').uid);
    url = checkout.toString();
  } catch {
    return c.json({ error: 'Server checkout URL is misconfigured' }, 500);
  }
  return c.json({ url, plan: plan.id, price: plan.priceLabel });
});

interface PaymentInput {
  uid?: string;
  clientReferenceId?: string;
  plan?: string;
  paid?: boolean;
  durationDays?: number | null;
  provider?: string;
  providerRef?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

function fulfillPayment(body: PaymentInput) {
  const db = getDb();
  const stripeObject = body.data?.object;
  const uid = body.uid || body.clientReferenceId || stripeObject?.client_reference_id;
  if (typeof uid !== 'string' || !uid) return { status: 400 as const, body: { error: 'Missing uid / client_reference_id' } };
  if (!body.plan) return { status: 400 as const, body: { error: 'Missing plan' } };
  const plan = getPlan(db, body.plan);
  if (!plan) return { status: 400 as const, body: { error: 'Unknown plan' } };
  if (!plan.isDefault && body.paid !== true) {
    return { status: 400 as const, body: { error: 'No verified payment signal; upgrade ignored' } };
  }
  const user = db.prepare('SELECT id FROM users WHERE uid = ?').get(uid) as { id: number } | undefined;
  if (!user) return { status: 404 as const, body: { error: 'User not found' } };
  const providerRef = body.providerRef || (typeof stripeObject?.id === 'string' ? stripeObject.id : null);
  if (providerRef) {
    const seen = db.prepare('SELECT id FROM subscriptions WHERE provider_ref = ?').get(providerRef) as { id: number } | undefined;
    if (seen) return { status: 200 as const, body: { ok: true, deduped: true } };
  }
  const result = grantPlan(db, user.id, plan.id, {
    durationDays: body.durationDays === undefined ? plan.durationDays : body.durationDays,
    source: 'webhook',
    provider: body.provider ?? null,
    providerRef,
  });
  return { status: 200 as const, body: { ok: true, uid, plan: result.plan, planExpiresAt: result.planExpiresAt } };
}

billing.post('/webhook', async (c) => {
  if (!BILLING_ENABLED) return c.json({ error: 'Billing is disabled on this server' }, 503);
  if (!BILLING_WEBHOOK_SECRET) return c.json({ error: 'Webhook is not configured' }, 503);
  const provided = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') || c.req.header('X-Webhook-Secret') || '';
  const actual = createHash('sha256').update(provided).digest();
  const expected = createHash('sha256').update(BILLING_WEBHOOK_SECRET).digest();
  if (!timingSafeEqual(actual, expected)) return c.json({ error: 'Invalid webhook secret' }, 403);
  const body = await c.req.json<PaymentInput>().catch(() => ({}));
  const result = fulfillPayment(body);
  return c.json(result.body, result.status);
});

export function validStripeSignature(payload: string, header: string, secret: string, now = Date.now()): boolean {
  const parts = header.split(',').map((part) => part.trim().split('=', 2));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  });
}

// Stripe calls this endpoint directly. Signature verification happens against
// the untouched request text before parsing, with Stripe's five-minute replay window.
billing.post('/stripe/webhook', async (c) => {
  if (!BILLING_ENABLED) return c.json({ error: 'Billing is disabled on this server' }, 503);
  if (!STRIPE_WEBHOOK_SECRET) return c.json({ error: 'Stripe webhook is not configured' }, 503);
  const payload = await c.req.text();
  const signature = c.req.header('Stripe-Signature') || '';
  if (!validStripeSignature(payload, signature, STRIPE_WEBHOOK_SECRET)) {
    return c.json({ error: 'Invalid Stripe signature' }, 400);
  }
  let event: PaymentInput;
  try { event = JSON.parse(payload) as PaymentInput; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  if (event.type !== 'checkout.session.completed') return c.json({ received: true, ignored: true });
  const session = event.data?.object;
  if (session?.payment_status !== 'paid') return c.json({ received: true, ignored: true });

  const db = getDb();
  const metadata = session?.metadata as Record<string, unknown> | undefined;
  const metadataPlan = typeof metadata?.plan_id === 'string' ? metadata.plan_id : null;
  const paymentLink = typeof session?.payment_link === 'string' ? session.payment_link : null;
  const matched = paymentLink
    ? checkoutPlans(db).find((plan) => plan.stripePaymentLinkId === paymentLink)
    : null;
  const fallback = checkoutPlans(db).length === 1 ? checkoutPlans(db)[0] : null;
  const planId = metadataPlan || matched?.id || fallback?.id;
  if (!planId) return c.json({ error: 'Could not map Stripe payment to a plan' }, 400);

  const result = fulfillPayment({
    ...event,
    uid: typeof session?.client_reference_id === 'string' ? session.client_reference_id : undefined,
    plan: planId,
    paid: true,
    provider: 'stripe',
    providerRef: typeof session?.id === 'string' ? session.id : undefined,
  });
  return c.json(result.body, result.status);
});

export default billing;

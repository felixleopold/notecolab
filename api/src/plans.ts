import type Database from 'better-sqlite3';

export type PlanId = string;

export interface PlanConfig {
  id: PlanId;
  name: string;
  description: string | null;
  quotaBytes: number;
  collaboratorLimit: number;
  priceLabel: string | null;
  durationDays: number | null;
  checkoutUrl: string | null;
  stripePaymentLinkId: string | null;
  active: boolean;
  isDefault: boolean;
  sortOrder: number;
}

const MB = 1024 * 1024;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

// These values seed the database on first migration. After that, plans are
// managed through the admin API/dashboard and survive restarts and deploys.
export const FREE_QUOTA_BYTES = envInt('FREE_PLAN_BYTES', 10 * MB);
export const PRO_QUOTA_BYTES = envInt('PRO_PLAN_BYTES', 512 * MB);
export const PRO_PRICE = process.env.PRO_PLAN_PRICE || '€5 / year';
export const PRO_DURATION_DAYS = envInt('PRO_PLAN_DURATION_DAYS', 365);
export const BILLING_CHECKOUT_URL = process.env.BILLING_CHECKOUT_URL || '';
export const BILLING_ENABLED = envBool('BILLING_ENABLED', false);
export const BILLING_WEBHOOK_SECRET = process.env.BILLING_WEBHOOK_SECRET || '';
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  quota_bytes: number;
  collaborator_limit?: number;
  price_label: string | null;
  duration_days: number | null;
  checkout_url: string | null;
  stripe_payment_link_id: string | null;
  active: number;
  is_default: number;
  sort_order: number;
}

function mapPlan(row: PlanRow): PlanConfig {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    quotaBytes: row.quota_bytes,
    collaboratorLimit: row.collaborator_limit ?? 0,
    priceLabel: row.price_label,
    durationDays: row.duration_days,
    checkoutUrl: row.checkout_url,
    stripePaymentLinkId: row.stripe_payment_link_id,
    active: row.active === 1,
    isDefault: row.is_default === 1,
    sortOrder: row.sort_order,
  };
}

export function listPlans(db: Database.Database, activeOnly = false): PlanConfig[] {
  const where = activeOnly ? 'WHERE active = 1' : '';
  return (db.prepare(`SELECT * FROM plans ${where} ORDER BY sort_order, id`).all() as PlanRow[]).map(mapPlan);
}

export function getPlan(db: Database.Database, id: string | null | undefined): PlanConfig | null {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
  return row ? mapPlan(row) : null;
}

export function getDefaultPlan(db: Database.Database): PlanConfig {
  const row = db.prepare('SELECT * FROM plans WHERE is_default = 1 ORDER BY sort_order LIMIT 1').get() as PlanRow | undefined;
  if (row) return mapPlan(row);
  const first = db.prepare('SELECT * FROM plans ORDER BY sort_order, id LIMIT 1').get() as PlanRow | undefined;
  if (!first) throw new Error('No plans are configured');
  return mapPlan(first);
}

export function effectivePlan(
  db: Database.Database,
  plan: string | null | undefined,
  planExpiresAt: string | null | undefined,
): PlanConfig {
  const configured = getPlan(db, plan);
  if (!configured) return getDefaultPlan(db);
  if (configured.isDefault || !planExpiresAt || new Date(planExpiresAt).getTime() > Date.now()) {
    return configured;
  }
  return getDefaultPlan(db);
}

export function isUnlimited(quotaBytes: number): boolean {
  return quotaBytes <= 0;
}

export function checkoutPlans(db: Database.Database): PlanConfig[] {
  if (!BILLING_ENABLED) return [];
  return listPlans(db, true).filter((plan) => !plan.isDefault && !!plan.checkoutUrl);
}

export function checkoutAvailable(db: Database.Database): boolean {
  return checkoutPlans(db).length > 0;
}

export function publicPlanInfo(db: Database.Database) {
  const plans = Object.fromEntries(listPlans(db, true).map((plan) => [plan.id, {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    quotaBytes: plan.quotaBytes,
    collaboratorLimit: plan.collaboratorLimit,
    collaboratorScope: 'owner_named_recipients' as const,
    priceLabel: plan.priceLabel,
    durationDays: plan.durationDays,
    checkoutAvailable: BILLING_ENABLED && !plan.isDefault && !!plan.checkoutUrl,
    isDefault: plan.isDefault,
  }]));
  const upgradePlan = checkoutPlans(db)[0] ?? null;
  return {
    billingEnabled: BILLING_ENABLED,
    checkoutAvailable: checkoutAvailable(db),
    // Kept for older clients while they migrate to upgradePlan/plans.
    proPrice: upgradePlan?.priceLabel ?? PRO_PRICE,
    upgradePlanId: upgradePlan?.id ?? null,
    hostingPolicy: {
      version: '2026-09-16',
      path: '/terms',
      shutdownNoticeDays: 60,
      exportWindowDays: 30,
      automaticRetentionDeletion: false,
    },
    plans,
  };
}

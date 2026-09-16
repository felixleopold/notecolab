import { Hono } from 'hono';
import { getDb } from '../db/schema.js';
import { createHash, timingSafeEqual } from 'crypto';
import { getUserUsedBytes, grantPlan } from '../quota.js';
import { getDefaultPlan, getPlan, listPlans } from '../plans.js';
import { generateUid, generateApiKey, hashApiKey } from '../utils.js';
import type { Context, Next } from 'hono';

const admin = new Hono();

// --- Admin auth middleware using ADMIN_SECRET env var ---
async function adminAuth(c: Context, next: Next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return c.json({ error: 'Admin API is not configured' }, 503);
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const provided = authHeader.slice(7);
  // Constant-time comparison to prevent timing attacks
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(secret).digest();

  if (!timingSafeEqual(providedHash, expectedHash)) {
    return c.json({ error: 'Invalid admin secret' }, 403);
  }

  await next();
}

// All admin routes require admin auth
admin.use('*', adminAuth);

// --- Database stats ---
admin.get('/stats', (c) => {
  const db = getDb();

  const noteCount = (db.prepare('SELECT COUNT(*) as c FROM notes').get() as any).c;
  const imageCount = (db.prepare('SELECT COUNT(*) as c FROM note_images').get() as any).c;
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
  const linkCount = (db.prepare('SELECT COUNT(*) as c FROM share_links').get() as any).c;

  const noteBytes = (db.prepare('SELECT COALESCE(SUM(LENGTH(encrypted_content)), 0) as c FROM notes').get() as any).c;
  const imageBytes = (db.prepare('SELECT COALESCE(SUM(LENGTH(encrypted_data)), 0) as c FROM note_images').get() as any).c;
  const yjsBytes = 0;

  const notesWithExpiry = (db.prepare("SELECT COUNT(*) as c FROM notes WHERE expires_at IS NOT NULL").get() as any).c;
  const notesNeverExpire = (db.prepare("SELECT COUNT(*) as c FROM notes WHERE expires_at IS NULL").get() as any).c;

  // Stale notes (not updated in 1 year)
  const staleNotes = (db.prepare(
    "SELECT COUNT(*) as c FROM notes WHERE updated_at < datetime('now', '-365 days')"
  ).get() as any).c;

  // DB file size (page_count * page_size)
  const pageCount = (db.prepare('PRAGMA page_count').get() as any).page_count;
  const pageSize = (db.prepare('PRAGMA page_size').get() as any).page_size;
  const dbFileSize = pageCount * pageSize;

  // Freelist pages (reclaimable with VACUUM)
  const freelistCount = (db.prepare('PRAGMA freelist_count').get() as any).freelist_count;
  const reclaimableBytes = freelistCount * pageSize;

  return c.json({
    users: userCount,
    notes: noteCount,
    images: imageCount,
    shareLinks: linkCount,
    storage: {
      noteBytes,
      imageBytes,
      yjsBytes,
      totalDataBytes: noteBytes + imageBytes + yjsBytes,
      dbFileSize,
      reclaimableBytes,
    },
    expiry: {
      withExpiry: notesWithExpiry,
      neverExpire: notesNeverExpire,
      staleOver1Year: staleNotes,
    },
  });
});

// --- List all notes with storage breakdown ---
admin.get('/notes', (c) => {
  const db = getDb();

  const notes = db.prepare(`
    SELECT
      n.id, n.share_id, n.title, n.title_enc, n.access_mode, n.expires_at,
      n.created_at, n.updated_at, n.user_id,
      u.uid as owner_uid,
      LENGTH(n.encrypted_content) as content_bytes,
      COALESCE(img.image_count, 0) as image_count,
      COALESCE(img.image_bytes, 0) as image_bytes,
      0 as yjs_bytes,
      COALESCE(sl.link_count, 0) as link_count
    FROM notes n
    JOIN users u ON n.user_id = u.id
    LEFT JOIN (
      SELECT note_id, COUNT(*) as image_count, SUM(LENGTH(encrypted_data)) as image_bytes
      FROM note_images GROUP BY note_id
    ) img ON img.note_id = n.id
    LEFT JOIN (
      SELECT note_id, COUNT(*) as link_count FROM share_links GROUP BY note_id
    ) sl ON sl.note_id = n.id
    ORDER BY n.updated_at DESC
  `).all() as any[];

  return c.json({
    notes: notes.map((n: any) => ({
      id: n.id,
      shareId: n.share_id,
      title: n.title,
      encryptedTitle: n.title_enc,
      ownerUid: n.owner_uid,
      accessMode: n.access_mode,
      expiresAt: n.expires_at,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
      linkCount: n.link_count,
      storage: {
        contentBytes: n.content_bytes || 0,
        imageCount: n.image_count,
        imageBytes: n.image_bytes,
        yjsBytes: n.yjs_bytes,
        totalBytes: (n.content_bytes || 0) + n.image_bytes + n.yjs_bytes,
      },
    })),
  });
});

// --- Per-user storage breakdown ---
admin.get('/users', (c) => {
  const db = getDb();

  const users = db.prepare(`
    SELECT
      u.id, u.uid, u.display_name, u.created_at, u.last_seen_at, u.plan, u.plan_expires_at,
      COUNT(DISTINCT n.id) as note_count,
      COALESCE(SUM(LENGTH(n.encrypted_content)), 0) as note_bytes,
      COALESCE(SUM(img.image_bytes), 0) as image_bytes,
      0 as yjs_bytes
    FROM users u
    LEFT JOIN notes n ON n.user_id = u.id
    LEFT JOIN (
      SELECT note_id, SUM(LENGTH(encrypted_data)) as image_bytes
      FROM note_images GROUP BY note_id
    ) img ON img.note_id = n.id
    GROUP BY u.id
    ORDER BY (COALESCE(SUM(LENGTH(n.encrypted_content)), 0) + COALESCE(SUM(img.image_bytes), 0)) DESC
  `).all() as any[];

  return c.json({
    users: users.map((u: any) => ({
      id: u.id,
      uid: u.uid,
      displayName: u.display_name,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
      plan: u.plan || 'free',
      planExpiresAt: u.plan_expires_at,
      noteCount: u.note_count,
      storage: {
        noteBytes: u.note_bytes,
        imageBytes: u.image_bytes,
        yjsBytes: u.yjs_bytes,
        totalBytes: getUserUsedBytes(db, u.id),
      },
    })),
  });
});

interface PlanInput {
  id?: string;
  name?: string;
  description?: string | null;
  quotaBytes?: number;
  collaboratorLimit?: number;
  priceLabel?: string | null;
  durationDays?: number | null;
  checkoutUrl?: string | null;
  stripePaymentLinkId?: string | null;
  active?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
}

function validatePlanInput(body: PlanInput, requireId: boolean): string | null {
  if (requireId && (!body.id || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(body.id))) {
    return 'id must be 1-32 lowercase letters, numbers, underscores, or dashes';
  }
  if (!body.name?.trim() || body.name.trim().length > 80) return 'name is required and must be at most 80 characters';
  if (body.description && body.description.trim().length > 240) return 'description must be at most 240 characters';
  if (!Number.isSafeInteger(body.quotaBytes) || body.quotaBytes! < 0) return 'quotaBytes must be a non-negative integer';
  if (body.collaboratorLimit !== undefined && (!Number.isSafeInteger(body.collaboratorLimit) || body.collaboratorLimit < 0)) return 'collaboratorLimit must be a non-negative integer';
  if (body.durationDays !== null && body.durationDays !== undefined && (!Number.isSafeInteger(body.durationDays) || body.durationDays < 1)) {
    return 'durationDays must be null or a positive integer';
  }
  if (body.checkoutUrl) {
    try {
      const url = new URL(body.checkoutUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return 'checkoutUrl must use http or https';
    } catch {
      return 'checkoutUrl must be a valid URL';
    }
  }
  if (body.stripePaymentLinkId && !/^plink_[A-Za-z0-9]+$/.test(body.stripePaymentLinkId)) {
    return 'stripePaymentLinkId must start with plink_';
  }
  if (body.isDefault && body.active === false) return 'the default plan must be active';
  return null;
}

admin.get('/plans', (c) => c.json({ plans: listPlans(getDb()) }));

admin.post('/plans', async (c) => {
  const body = await c.req.json<PlanInput>().catch(() => ({} as PlanInput));
  const error = validatePlanInput(body, true);
  if (error) return c.json({ error }, 400);
  const db = getDb();
  if (getPlan(db, body.id!)) return c.json({ error: 'Plan already exists' }, 409);

  const insert = db.transaction(() => {
    if (body.isDefault) db.prepare('UPDATE plans SET is_default = 0').run();
    db.prepare(`
      INSERT INTO plans
        (id, name, description, quota_bytes, price_label, duration_days, checkout_url, stripe_payment_link_id, active, is_default, sort_order, collaborator_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.id, body.name!.trim(), body.description?.trim() || null, body.quotaBytes, body.priceLabel?.trim() || null,
      body.durationDays ?? null, body.checkoutUrl?.trim() || null,
      body.stripePaymentLinkId?.trim() || null, body.active === false ? 0 : 1,
      body.isDefault ? 1 : 0, body.sortOrder ?? 0, body.collaboratorLimit ?? 0,
    );
  });
  insert();
  return c.json({ plan: getPlan(db, body.id!) }, 201);
});

admin.put('/plans/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<PlanInput>().catch(() => ({} as PlanInput));
  const error = validatePlanInput(body, false);
  if (error) return c.json({ error }, 400);
  const db = getDb();
  const existing = getPlan(db, id);
  if (!existing) return c.json({ error: 'Plan not found' }, 404);
  if (existing.isDefault && body.isDefault === false) return c.json({ error: 'Choose another default plan first' }, 400);
  if ((body.isDefault ?? existing.isDefault) && (body.active ?? existing.active) === false) {
    return c.json({ error: 'The default plan must be active' }, 400);
  }

  const update = db.transaction(() => {
    if (body.isDefault) db.prepare('UPDATE plans SET is_default = 0 WHERE id <> ?').run(id);
    db.prepare(`
      UPDATE plans SET name = ?, description = ?, quota_bytes = ?, price_label = ?, duration_days = ?,
        checkout_url = ?, stripe_payment_link_id = ?, active = ?, is_default = ?,
        sort_order = ?, collaborator_limit = ?, updated_at = datetime('now') WHERE id = ?
    `).run(
      body.name!.trim(), body.description?.trim() || null, body.quotaBytes, body.priceLabel?.trim() || null,
      body.durationDays ?? null, body.checkoutUrl?.trim() || null,
      body.stripePaymentLinkId?.trim() || null, body.active === false ? 0 : 1,
      (body.isDefault ?? existing.isDefault) ? 1 : 0, body.sortOrder ?? existing.sortOrder, body.collaboratorLimit ?? existing.collaboratorLimit, id,
    );
  });
  update();
  return c.json({ plan: getPlan(db, id) });
});

admin.delete('/plans/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const plan = getPlan(db, id);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (plan.isDefault) return c.json({ error: 'The default plan cannot be deleted' }, 400);
  const assigned = db.prepare('SELECT COUNT(*) AS count FROM users WHERE plan = ?').get(id) as { count: number };
  if (assigned.count > 0) return c.json({ error: `Plan is assigned to ${assigned.count} user(s)` }, 409);
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  return c.json({ ok: true });
});

// --- Provision a user directly (for REGISTRATION=closed servers) ---
// Body (optional): { publicKey?: string }
// Returns { uid, apiKey } exactly like /auth/register — hand these to the user
// so they can configure the plugin without self-registration being open.
admin.post('/users', async (c) => {
  const body = await c.req.json<{ publicKey?: string }>().catch(() => ({} as { publicKey?: string }));

  const db = getDb();
  const uid = generateUid();
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);

  db.prepare('INSERT INTO users (uid, api_key_hash, public_key, plan) VALUES (?, ?, ?, ?)')
    .run(uid, keyHash, body.publicKey || null, getDefaultPlan(db).id);

  return c.json({ uid, apiKey }, 201);
});

// --- Delete a user and all data keyed by their uid ---
admin.delete('/users/:uid', (c) => {
  const uid = c.req.param('uid');
  const db = getDb();

  const user = db.prepare('SELECT id, uid FROM users WHERE uid = ?').get(uid) as any;
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  const removeUser = db.transaction(() => {
    const notes = (db.prepare('SELECT COUNT(*) as c FROM notes WHERE user_id = ?').get(user.id) as any).c;
    const collaborators = db.prepare('DELETE FROM collaborators WHERE user_uid = ?').run(uid).changes;
    const pendingShares = db.prepare('DELETE FROM pending_shares WHERE recipient_uid = ? OR sender_uid = ?').run(uid, uid).changes;

    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

    return { notes, collaborators, pendingShares };
  });

  return c.json({ ok: true, deleted: removeUser() });
});

// --- Delete a specific note by internal ID ---
admin.delete('/notes/:noteId', (c) => {
  const noteId = parseInt(c.req.param('noteId'), 10);
  if (isNaN(noteId)) {
    return c.json({ error: 'Invalid note ID' }, 400);
  }

  const db = getDb();
  const note = db.prepare('SELECT id, share_id, title, title_enc FROM notes WHERE id = ?').get(noteId) as any;
  if (!note) {
    return c.json({ error: 'Note not found' }, 404);
  }

  // CASCADE deletes share_links, collaborators, images, yjs_state
  db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);

  return c.json({ ok: true, deleted: { id: note.id, shareId: note.share_id, title: note.title, encryptedTitle: note.title_enc } });
});

// --- Purge stale notes (not updated in N days, default 365) ---
admin.post('/purge-stale', (c) => {
  const daysParam = c.req.query('days');
  const days = daysParam ? parseInt(daysParam, 10) : 365;
  if (isNaN(days) || days < 1) {
    return c.json({ error: 'Invalid days parameter (must be >= 1)' }, 400);
  }

  const db = getDb();

  // Preview what would be deleted
  const dryRun = c.req.query('dry_run') === 'true';

  const staleNotes = db.prepare(`
    SELECT id, share_id, title, title_enc, updated_at FROM notes
    WHERE updated_at < datetime('now', '-' || ? || ' days')
    ORDER BY updated_at ASC
  `).all(days) as any[];

  if (dryRun) {
    return c.json({
      dryRun: true,
      days,
      wouldDelete: staleNotes.length,
      notes: staleNotes.map((n: any) => ({
        id: n.id,
        shareId: n.share_id,
        title: n.title,
        encryptedTitle: n.title_enc,
        updatedAt: n.updated_at,
      })),
    });
  }

  const result = db.prepare(`
    DELETE FROM notes WHERE updated_at < datetime('now', '-' || ? || ' days')
  `).run(days);

  return c.json({
    ok: true,
    deletedCount: result.changes,
    days,
  });
});

// --- Grant / revoke a user's plan by UID ---
// Body: { plan: string, durationDays?: number | null }
//   durationDays omitted  → the plan's configured duration
//   durationDays: null/0  → permanent (never expires)
//   assigning the default plan keeps data and blocks growth when over quota
admin.post('/users/:uid/plan', async (c) => {
  const uid = c.req.param('uid');
  const body = await c.req
    .json<{ plan?: string; durationDays?: number | null }>()
    .catch(() => ({} as { plan?: string; durationDays?: number | null }));

  const db = getDb();
  const plan = body.plan ? getPlan(db, body.plan) : null;
  if (!plan) return c.json({ error: 'Unknown plan' }, 400);
  const user = db.prepare('SELECT id FROM users WHERE uid = ?').get(uid) as { id: number } | undefined;
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  const result = grantPlan(db, user.id, plan.id, {
    durationDays: plan.isDefault ? null : body.durationDays,
    source: 'admin',
  });

  return c.json({ ok: true, uid, plan: result.plan, planExpiresAt: result.planExpiresAt });
});

// --- VACUUM to reclaim disk space ---
admin.post('/vacuum', (c) => {
  const db = getDb();

  // Get sizes before
  const beforePages = (db.prepare('PRAGMA page_count').get() as any).page_count;
  const pageSize = (db.prepare('PRAGMA page_size').get() as any).page_size;
  const beforeSize = beforePages * pageSize;

  db.exec('VACUUM');

  // Get sizes after
  const afterPages = (db.prepare('PRAGMA page_count').get() as any).page_count;
  const afterSize = afterPages * pageSize;

  return c.json({
    ok: true,
    beforeBytes: beforeSize,
    afterBytes: afterSize,
    reclaimedBytes: beforeSize - afterSize,
  });
});

export default admin;

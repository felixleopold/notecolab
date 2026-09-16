import { checkCollaboratorCapacity, collaboratorLimitError } from '../collaboration-limits.js';
import { Hono } from 'hono';
import { getDb } from '../db/schema.js';
import { generateShareId, generateInviteToken, hashApiKey, verifyApiKey } from '../utils.js';
import { authMiddleware, optionalAuthMiddleware } from './middleware.js';
import { lookupInvite, inviteLookupRateLimit, inviteAcceptRateLimit } from '../invites.js';
import { checkQuota, getQuotaStatus, loadUserPlan, type QuotaCheck } from '../quota.js';
import { checkoutPlans } from '../plans.js';
import type { AppEnv } from '../env.js';
import { legacyShareRateLimit } from '../share-access.js';

const notes = new Hono<AppEnv>();

// Absolute per-request payload caps (in bytes). These are a sanity ceiling on a
// single upload; the real per-user limit is the storage quota (see ../quota.ts).
const MAX_NOTE_SIZE = 25 * 1024 * 1024;  // 25 MB encrypted note
const MAX_CRDT_SIZE = 25 * 1024 * 1024;  // encrypted Yjs checkpoint
const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50 MB encrypted image
const MAX_NOTE_REVISIONS = 1;

const MB = 1024 * 1024;
const mb = (bytes: number) => (bytes / MB).toFixed(bytes >= MB ? 1 : 2);

// Wrapped-key / nonce payloads are small (an AES key + nonce, base64). Cap them
// so pending-share / vault-key rows can't be abused to park bulk data outside
// the quota accounting, and bound how many can be created per request.
const MAX_WRAPPED_FIELD = 8 * 1024;        // base64 of a wrapped key or nonce
const MAX_PENDING_TITLE = 1024;            // legacy plaintext title label
const MAX_ENCRYPTED_TITLE = 4 * 1024;      // base64 AES-GCM title blob
const MAX_SHARES_PER_REQUEST = 100;

export const PENDING_SHARE_UPSERT_SQL = `
  INSERT INTO pending_shares (note_id, share_id, recipient_uid, sender_uid, encrypted_key, nonce, title, title_enc)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(share_id, recipient_uid) DO UPDATE SET
    note_id = excluded.note_id,
    sender_uid = excluded.sender_uid,
    encrypted_key = excluded.encrypted_key,
    nonce = excluded.nonce,
    title = excluded.title,
    title_enc = excluded.title_enc,
    dismissed = 0,
    created_at = datetime('now')
`;

// A delivery is scoped to the link it was sent through, so its access mode comes
// from that link. Deliveries created before links carried the delivery identity
// fall back to the note's own access mode.
export const PENDING_SHARE_DELIVERY_SQL = `
  SELECT ps.note_id, ps.recipient_uid,
         COALESCE(sl.access_mode, n.access_mode) AS access_mode
  FROM pending_shares ps
  JOIN notes n ON n.id = ps.note_id
  LEFT JOIN share_links sl ON sl.note_id = ps.note_id AND sl.share_id = ps.share_id
  WHERE ps.id = ? AND ps.recipient_uid = ?
`;

/**
 * Invite responses now report the exact permission-bearing link the invite was
 * created against. `noteShareId` is kept as a transitional alias so clients
 * released before this change (which read that field) keep working; both fields
 * carry the same value. Remove the alias once no v1.25.x client is in use.
 */
export function inviteShareIds(
  invite: { link_share_id?: string | null; note_share_id: string },
): { shareId: string; noteShareId: string } {
  const shareId = invite.link_share_id || invite.note_share_id;
  return { shareId, noteShareId: shareId };
}

function isValidBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

function validateEncryptedTitle(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENCRYPTED_TITLE || !isValidBase64(value)) {
    return 'encryptedTitle must be base64 and at most 4 KB';
  }
  return null;
}

// Body for a 413 quota_exceeded response — shared across every write route so
// the plugin/web can detect it (code === 'quota_exceeded') and offer an upgrade.
function quotaBody(check: QuotaCheck) {
  const upgrade = checkoutPlans(getDb()).find((plan) => plan.id !== check.plan && (plan.quotaBytes <= 0 || plan.quotaBytes > check.limitBytes));
  const upgradeHint = upgrade
    ? ` Upgrade to ${upgrade.name}${upgrade.priceLabel ? ` (${upgrade.priceLabel})` : ''} for more space.`
    : ' Free up space by deleting shared notes.';
  return {
    error: `Storage limit reached (${mb(check.usedBytes)} MB of ${mb(check.limitBytes)} MB used).${upgradeHint}`,
    code: 'quota_exceeded' as const,
    plan: check.plan,
    usedBytes: check.usedBytes,
    limitBytes: check.limitBytes,
  };
}

// Public-edit content and image writes can authenticate with a key-derived
// capability. All other mutations still require an account credential.
notes.post('*', (c, next) => {
  const isImageUpload = /\/api\/v1\/notes\/[^/]+\/images$/.test(c.req.path);
  return isImageUpload ? optionalAuthMiddleware(c, next) : authMiddleware(c, next);
});
notes.put('*', authMiddleware);
notes.patch('*', (c, next) => {
  const isContentUpdate = /\/api\/v1\/notes\/[^/]+$/.test(c.req.path);
  return isContentUpdate ? optionalAuthMiddleware(c, next) : authMiddleware(c, next);
});
notes.delete('*', authMiddleware);

// Specific GET routes that require auth
notes.get('/mine', authMiddleware);
notes.get('/mine/storage', authMiddleware);
notes.get('/shared-with-me', authMiddleware);
notes.get('/pending-shares/mine', authMiddleware);
notes.get('/:shareId/links', authMiddleware);
notes.get('/:shareId/collaborators', authMiddleware);

// Invite link endpoints. These carry dedicated rate limits because they are the
// only routes a stranger can drive with a guessed token: the lookup is fully
// unauthenticated, and accept hands out collaborator access. (issue #19)
notes.get('/invite/:token', inviteLookupRateLimit, optionalAuthMiddleware);
notes.post('/invite/:token/accept', inviteAcceptRateLimit);

// Public GET routes use optional auth (needed for invited_edit access checks)
notes.get('/:shareId', legacyShareRateLimit, optionalAuthMiddleware);
notes.get('/:shareId/meta', legacyShareRateLimit, optionalAuthMiddleware);
notes.get('/:shareId/images', legacyShareRateLimit, optionalAuthMiddleware);
notes.get('/:shareId/images/:filename', legacyShareRateLimit, optionalAuthMiddleware);
notes.get('/:shareId/history', legacyShareRateLimit, optionalAuthMiddleware);

// --- Helper: resolve a share_id to note + link info ---
interface ResolvedNote {
  noteId: number;
  noteShareId: string;  // canonical note.share_id (Yjs room ID)
  linkId: number | null;
  linkShareId: string;
  accessMode: string;
  expiresAt: string | null;
  ownerUid: string;
  ownerId: number;
  encryptedContent: Buffer | null;
  encryptedCrdt: Buffer | null;
  contentVersion: number;
  title: string | null;
  encryptedTitle: string | null;
  writeTokenHash: string | null;
  createdAt: string;
  updatedAt: string;
}

function resolveShareId(shareId: string): ResolvedNote | null {
  const db = getDb();

  // Check share_links first
  const link = db.prepare(`
    SELECT sl.id as link_id, sl.access_mode as link_access, sl.expires_at as link_expires,
           n.id as note_id, n.share_id as note_share_id, n.title, n.title_enc, n.encrypted_content,
           n.encrypted_crdt, n.content_version,
           n.created_at, n.updated_at, n.user_id, n.write_token_hash, u.uid as owner_uid
    FROM share_links sl
    JOIN notes n ON sl.note_id = n.id
    JOIN users u ON n.user_id = u.id
    WHERE sl.share_id = ?
  `).get(shareId) as any;

  if (link) {
    return {
      noteId: link.note_id,
      noteShareId: link.note_share_id,
      linkId: link.link_id,
      linkShareId: shareId,
      accessMode: link.link_access,
      expiresAt: link.link_expires,
      ownerUid: link.owner_uid,
      ownerId: link.user_id,
      encryptedContent: link.encrypted_content,
      encryptedCrdt: link.encrypted_crdt,
      contentVersion: link.content_version,
      title: link.title,
      encryptedTitle: link.title_enc,
      writeTokenHash: link.write_token_hash,
      createdAt: link.created_at,
      updatedAt: link.updated_at,
    };
  }

  // Fallback to notes.share_id (backward compat)
  const note = db.prepare(`
    SELECT n.*, u.uid as owner_uid
    FROM notes n JOIN users u ON n.user_id = u.id
    WHERE n.share_id = ?
  `).get(shareId) as any;

  if (note) {
    return {
      noteId: note.id,
      noteShareId: note.share_id,
      linkId: null,
      linkShareId: shareId,
      accessMode: note.access_mode,
      expiresAt: note.expires_at,
      ownerUid: note.owner_uid,
      ownerId: note.user_id,
      encryptedContent: note.encrypted_content,
      encryptedCrdt: note.encrypted_crdt,
      contentVersion: note.content_version,
      title: note.title,
      encryptedTitle: note.title_enc,
      writeTokenHash: note.write_token_hash,
      createdAt: note.created_at,
      updatedAt: note.updated_at,
    };
  }

  return null;
}

// --- Helper: check if a link is expired for a given user ---
// Owners are never locked out by link expiry.
// invited_edit links don't expire — access is controlled via collaborator list.
function isExpiredForUser(resolved: ResolvedNote, userUid: string | undefined): boolean {
  if (!resolved.expiresAt) return false;
  if (new Date(resolved.expiresAt) >= new Date()) return false;
  // Owner bypasses expiry
  if (userUid && resolved.ownerUid === userUid) return false;
  // invited_edit: access controlled by collaborator list, not expiry
  if (resolved.accessMode === 'invited_edit') return false;
  return true;
}

// --- Helper: check if a user is a collaborator on a note ---
function isCollaborator(noteId: number, userUid: string | undefined): { allowed: boolean; canEdit: boolean } {
  if (!userUid) return { allowed: false, canEdit: false };
  const db = getDb();
  const row = db.prepare(
    'SELECT can_edit FROM collaborators WHERE note_id = ? AND user_uid = ?'
  ).get(noteId, userUid) as { can_edit: number } | undefined;
  if (!row) return { allowed: false, canEdit: false };
  return { allowed: true, canEdit: !!row.can_edit };
}

// --- Helper: may this account WRITE (edit content / images) via this link? ---
// Owners always can; invited_edit requires an edit-capable collaborator;
// read_only is owner-only. Public-edit callers use the separate note-key
// capability below. Callers still enforce expiry separately.
function canWriteNote(resolved: ResolvedNote, userUid: string | undefined): boolean {
  if (userUid && resolved.ownerUid === userUid) return true;
  if (resolved.accessMode === 'invited_edit') {
    const collab = isCollaborator(resolved.noteId, userUid);
    return collab.allowed && collab.canEdit;
  }
  return false; // read_only, non-owner
}

function hasWriteCapability(resolved: ResolvedNote, suppliedToken: string | undefined): boolean {
  // Existing rows predate write capabilities. Their short IDs are throttled at
  // the public lookup boundary while owners migrate them by opening the note in
  // a current client, which stores a token through /room-token.
  if (!resolved.writeTokenHash) return true;
  return !!suppliedToken && verifyApiKey(suppliedToken, resolved.writeTokenHash);
}

// --- Helper: may this user READ this link's content (invited_edit gate)? ---
function canReadNote(resolved: ResolvedNote, userUid: string | undefined): boolean {
  if (resolved.accessMode !== 'invited_edit') return true;
  if (userUid && resolved.ownerUid === userUid) return true;
  return isCollaborator(resolved.noteId, userUid).allowed;
}

// --- Share a note (upload encrypted content) ---
notes.post('/share', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    title?: string;
    encryptedTitle?: string;
    encryptedContent: string;
    accessMode?: 'public_edit' | 'invited_edit' | 'read_only';
    expiresIn?: number;
    collaborators?: string[];
  }>();

  if (!body.encryptedContent) {
    return c.json({ error: 'encryptedContent is required' }, 400);
  }
  if (body.collaborators !== undefined && (!Array.isArray(body.collaborators)
    || body.collaborators.some((uid) => typeof uid !== 'string' || !uid || uid.length > 128))) {
    return c.json({ error: 'collaborators must be a list of user IDs' }, 400);
  }
  const titleError = validateEncryptedTitle(body.encryptedTitle);
  if (titleError) {
    return c.json({ error: titleError }, 400);
  }

  const contentBuffer = Buffer.from(body.encryptedContent, 'base64');
  if (contentBuffer.byteLength > MAX_NOTE_SIZE) {
    return c.json({ error: `Note too large (max ${mb(MAX_NOTE_SIZE)} MB)` }, 413);
  }

  const db = getDb();

  const capacity = checkCollaboratorCapacity(db, user.id, body.collaborators ?? []);
  if (!capacity.ok) return c.json(collaboratorLimitError(capacity), 403);

  // Enforce the owner's storage quota — a brand-new note adds its full size.
  const quota = checkQuota(db, loadUserPlan(db, user.id), contentBuffer.byteLength);
  if (!quota.ok) {
    return c.json(quotaBody(quota), 413);
  }

  const accessMode = body.accessMode || 'read_only';
  const shareId = generateShareId();

  // invited_edit: access controlled by collaborator list, no time-based expiry
  let expiresAt: string | null = null;
  if (accessMode !== 'invited_edit' && body.expiresIn && body.expiresIn > 0) {
    expiresAt = new Date(Date.now() + body.expiresIn * 1000).toISOString();
  }

  const txn = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO notes (user_id, share_id, title, title_enc, encrypted_content, access_mode, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      shareId,
      body.encryptedTitle ? null : (body.title || null),
      body.encryptedTitle || null,
      contentBuffer,
      accessMode,
      expiresAt,
    );
    const noteId = result.lastInsertRowid as number;

    // Create the initial share link
    db.prepare(`
      INSERT INTO share_links (note_id, share_id, label, access_mode, expires_at)
      VALUES (?, ?, 'Original', ?, ?)
    `).run(noteId, shareId, accessMode, expiresAt);

    if (body.collaborators?.length) {
      const insertCollab = db.prepare(
        'INSERT OR IGNORE INTO collaborators (note_id, user_uid, can_edit) VALUES (?, ?, ?)'
      );
      for (const uid of body.collaborators) {
        insertCollab.run(noteId, uid, 1);
      }
    }

    return noteId;
  });

  txn();

  return c.json({ shareId, expiresAt });
});

// --- List all notes owned by the current user ---
notes.get('/mine', async (c) => {
  const user = c.get('user');
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      n.id, n.share_id AS note_share_id, n.title, n.title_enc, n.created_at AS note_created_at, n.updated_at,
      sl.share_id AS link_share_id, sl.label, sl.access_mode, sl.expires_at, sl.created_at AS link_created_at
    FROM notes n
    LEFT JOIN share_links sl ON sl.note_id = n.id
    WHERE n.user_id = ?
    ORDER BY n.updated_at DESC, sl.created_at ASC
  `).all(user.id) as any[];

  const notesById = new Map<number, any>();
  for (const row of rows) {
    if (!notesById.has(row.id)) {
      notesById.set(row.id, {
        noteShareId: row.note_share_id,
        title: row.title,
        encryptedTitle: row.title_enc,
        createdAt: row.note_created_at,
        updatedAt: row.updated_at,
        links: [],
      });
    }
    if (row.link_share_id) {
      notesById.get(row.id).links.push({
        shareId: row.link_share_id,
        label: row.label,
        accessMode: row.access_mode,
        expiresAt: row.expires_at,
        expired: row.expires_at ? new Date(row.expires_at) < new Date() : false,
        createdAt: row.link_created_at,
      });
    }
  }

  return c.json({ notes: [...notesById.values()] });
});

// --- Per-user storage breakdown ---
notes.get('/mine/storage', async (c) => {
  const user = c.get('user');
  const db = getDb();

  // Plan-derived quota (free vs pro, with expiry handled). totalBytes here is
  // the same figure the upload enforcement uses, so the bar can't disagree.
  const status = getQuotaStatus(db, loadUserPlan(db, user.id));

  const userNotes = db.prepare(`
    SELECT
      n.id, n.share_id, n.title, n.title_enc, n.created_at, n.updated_at,
      LENGTH(n.encrypted_content) as content_bytes,
      LENGTH(COALESCE(n.encrypted_crdt, X'')) as crdt_bytes,
      COALESCE(rev.revision_bytes, 0) as revision_bytes,
      COALESCE(img.image_count, 0) as image_count,
      COALESCE(img.image_bytes, 0) as image_bytes,
      0 as yjs_bytes
    FROM notes n
    LEFT JOIN (
      SELECT note_id, COUNT(*) as image_count, SUM(LENGTH(encrypted_data)) as image_bytes
      FROM note_images GROUP BY note_id
    ) img ON img.note_id = n.id
    LEFT JOIN (
      SELECT note_id,
             SUM(LENGTH(encrypted_content) + LENGTH(COALESCE(encrypted_crdt, X''))) AS revision_bytes
      FROM note_revisions GROUP BY note_id
    ) rev ON rev.note_id = n.id
    WHERE n.user_id = ?
    ORDER BY COALESCE(img.image_bytes, 0) DESC
  `).all(user.id) as any[];

  const noteBytes = userNotes.reduce((sum: number, n: any) => (
    sum + (n.content_bytes || 0) + n.crdt_bytes + n.revision_bytes + n.image_bytes + n.yjs_bytes
  ), 0);
  const otherBytes = Math.max(0, status.usedBytes - noteBytes);

  return c.json({
    plan: status.plan,
    planExpiresAt: status.planExpiresAt,
    storageLimit: status.limitBytes,
    unlimited: status.unlimited,
    totalBytes: status.usedBytes,
    otherBytes,
    usagePercent: status.usagePercent,
    noteCount: userNotes.length,
    notes: userNotes.map((n: any) => ({
      noteShareId: n.share_id,
      title: n.title,
      encryptedTitle: n.title_enc,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
      storage: {
        contentBytes: n.content_bytes || 0,
        crdtBytes: n.crdt_bytes,
        revisionBytes: n.revision_bytes,
        imageCount: n.image_count,
        imageBytes: n.image_bytes,
        yjsBytes: n.yjs_bytes,
        totalBytes: (n.content_bytes || 0) + n.crdt_bytes + n.revision_bytes + n.image_bytes + n.yjs_bytes,
      },
    })),
  });
});

// Static collection routes must be registered before dynamic /:shareId routes
// because Hono dispatches in registration order.

// --- Notes shared with me ---
notes.get('/shared-with-me', async (c) => {
  const user = c.get('user');
  const db = getDb();

  // The owner's UID lives on users.uid (notes only stores user_id), and the
  // canonical note.share_id is the one used for Yjs rooms and vault-key lookup -
  // so resolve owner via users and return n.share_id rather than a share_links id.
  const notes_list = db.prepare(`
    SELECT n.id, n.title, n.title_enc, u.uid AS owner_uid, n.share_id, n.access_mode,
           n.created_at, n.updated_at, c.can_edit
    FROM collaborators c
    JOIN notes n ON n.id = c.note_id
    JOIN users u ON u.id = n.user_id
    WHERE c.user_uid = ?
    ORDER BY n.updated_at DESC
  `).all(user.uid) as any[];

  return c.json({
    notes: notes_list.map((n: any) => ({
      noteId: n.id,
      title: n.title,
      encryptedTitle: n.title_enc,
      ownerUid: n.owner_uid,
      shareId: n.share_id,
      accessMode: n.access_mode,
      canEdit: !!n.can_edit,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
    })),
  });
});

// Leave a note that was shared with the current user. This removes only the
// recipient's collaborator/pending-share rows; the owner's note is untouched.
notes.delete('/shared-with-me/:shareId', async (c) => {
  const user = c.get('user');
  const resolved = resolveShareId(c.req.param('shareId'));
  if (!resolved) return c.json({ error: 'Note not found' }, 404);
  if (resolved.ownerUid === user.uid) {
    return c.json({ error: 'Owners must revoke their note instead' }, 400);
  }

  const db = getDb();
  const leave = db.transaction(() => {
    const removed = db.prepare(
      'DELETE FROM collaborators WHERE note_id = ? AND user_uid = ?'
    ).run(resolved.noteId, user.uid);
    db.prepare(
      'DELETE FROM pending_shares WHERE note_id = ? AND recipient_uid = ?'
    ).run(resolved.noteId, user.uid);
    return removed.changes > 0;
  });

  return c.json({ ok: true, removed: leave() });
});

// --- Link management routes (must be before /:shareId) ---

// Update a specific link
notes.patch('/links/:linkShareId', async (c) => {
  const linkShareId = c.req.param('linkShareId');
  const user = c.get('user');
  const db = getDb();

  const link = db.prepare(`
    SELECT sl.id, sl.note_id, u.uid as owner_uid
    FROM share_links sl
    JOIN notes n ON sl.note_id = n.id
    JOIN users u ON n.user_id = u.id
    WHERE sl.share_id = ?
  `).get(linkShareId) as any;

  if (!link) {
    return c.json({ error: 'Link not found' }, 404);
  }
  if (link.owner_uid !== user.uid) {
    return c.json({ error: 'Only the owner can modify links' }, 403);
  }

  const body = await c.req.json<{
    accessMode?: 'public_edit' | 'invited_edit' | 'read_only';
    expiresIn?: number | null;
    label?: string;
  }>();

  const updates: string[] = [];
  const params: any[] = [];

  if (body.accessMode) {
    updates.push('access_mode = ?');
    params.push(body.accessMode);
  }
  if (body.expiresIn !== undefined) {
    if (body.expiresIn === null) {
      updates.push('expires_at = NULL');
    } else {
      updates.push('expires_at = ?');
      params.push(new Date(Date.now() + body.expiresIn * 1000).toISOString());
    }
  }
  if (body.label !== undefined) {
    updates.push('label = ?');
    params.push(body.label);
  }

  if (updates.length > 0) {
    params.push(link.id);
    db.prepare(`UPDATE share_links SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  return c.json({ ok: true });
});

// Delete a specific link
notes.delete('/links/:linkShareId', async (c) => {
  const linkShareId = c.req.param('linkShareId');
  const user = c.get('user');
  const db = getDb();

  const link = db.prepare(`
    SELECT sl.id, sl.note_id, sl.share_id, n.share_id as note_share_id, u.uid as owner_uid
    FROM share_links sl
    JOIN notes n ON sl.note_id = n.id
    JOIN users u ON n.user_id = u.id
    WHERE sl.share_id = ?
  `).get(linkShareId) as any;

  if (!link) {
    return c.json({ error: 'Link not found' }, 404);
  }
  if (link.owner_uid !== user.uid) {
    return c.json({ error: 'Only the owner can delete links' }, 403);
  }

  // Don't allow deleting the last link — user should delete the note instead
  const linkCount = (db.prepare(
    'SELECT COUNT(*) as count FROM share_links WHERE note_id = ?'
  ).get(link.note_id) as any).count;

  if (linkCount <= 1) {
    return c.json({ error: 'Cannot delete the last link. Delete the note instead.' }, 400);
  }

  db.prepare('DELETE FROM share_links WHERE id = ?').run(link.id);

  return c.json({ ok: true });
});

// --- Note metadata (no content) ---
notes.get('/:shareId/meta', async (c) => {
  const shareId = c.req.param('shareId');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }

  const user = c.get('user');

  if (isExpiredForUser(resolved, user?.uid)) {
    return c.json({ error: 'This link has expired' }, 410);
  }

  // Enforce invited_edit: only owner or collaborators can see metadata
  if (resolved.accessMode === 'invited_edit') {
    const isOwner = user ? resolved.ownerUid === user.uid : false;
    if (!isOwner && !isCollaborator(resolved.noteId, user?.uid).allowed) {
      return c.json({ error: 'This note is invite-only. You need to be added as a collaborator.' }, 403);
    }
  }

  return c.json({
    share_id: resolved.linkShareId,
    title: resolved.title,
    encryptedTitle: resolved.encryptedTitle,
    access_mode: resolved.accessMode,
    expires_at: resolved.expiresAt,
    created_at: resolved.createdAt,
    updated_at: resolved.updatedAt,
    owner_uid: resolved.ownerUid,
  });
});

// --- List links for a note (owner only) ---
notes.get('/:shareId/links', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }
  if (resolved.ownerUid !== user.uid) {
    return c.json({ error: 'Only the owner can list links' }, 403);
  }

  const db = getDb();
  const links = db.prepare(`
    SELECT share_id, label, access_mode, expires_at, created_at
    FROM share_links WHERE note_id = ? ORDER BY created_at ASC
  `).all(resolved.noteId) as any[];

  return c.json({
    noteShareId: resolved.noteShareId,
    title: resolved.title,
    encryptedTitle: resolved.encryptedTitle,
    links: links.map((l: any) => ({
      shareId: l.share_id,
      label: l.label,
      accessMode: l.access_mode,
      expiresAt: l.expires_at,
      createdAt: l.created_at,
    })),
  });
});

// --- Create a new link for an existing note (owner only) ---
notes.post('/:shareId/links', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }
  if (resolved.ownerUid !== user.uid) {
    return c.json({ error: 'Only the owner can create links' }, 403);
  }

  const body = await c.req.json<{
    accessMode?: 'public_edit' | 'invited_edit' | 'read_only';
    expiresIn?: number;
    label?: string;
  }>();

  const newShareId = generateShareId();
  const accessMode = body.accessMode || 'read_only';
  // invited_edit: access controlled by collaborator list, no time-based expiry
  let expiresAt: string | null = null;
  if (accessMode !== 'invited_edit' && body.expiresIn && body.expiresIn > 0) {
    expiresAt = new Date(Date.now() + body.expiresIn * 1000).toISOString();
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO share_links (note_id, share_id, label, access_mode, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(resolved.noteId, newShareId, body.label || '', accessMode, expiresAt);

  return c.json({ shareId: newShareId, accessMode, expiresAt });
});

// --- Get encrypted note content ---
notes.get('/:shareId/history', async (c) => {
  const resolved = resolveShareId(c.req.param('shareId'));
  if (!resolved) return c.json({ error: 'Note not found' }, 404);

  const user = c.get('user');
  if (isExpiredForUser(resolved, user?.uid)) {
    return c.json({ error: 'This link has expired' }, 410);
  }
  if (!canReadNote(resolved, user?.uid)) {
    return c.json({ error: 'You are not authorized to read this note' }, 403);
  }

  if (resolved.ownerUid !== user?.uid && (resolved.accessMode === 'read_only'
    || (resolved.accessMode === 'invited_edit' && !isCollaborator(resolved.noteId, user?.uid).canEdit))) {
    return c.json({ error: 'Note history is available to the owner and editors only' }, 403);
  }

  const rows = getDb().prepare(`
    SELECT version, encrypted_content, encrypted_crdt, created_at
    FROM note_revisions
    WHERE note_id = ?
    ORDER BY version DESC
    LIMIT ?
  `).all(resolved.noteId, MAX_NOTE_REVISIONS) as {
    version: number;
    encrypted_content: Buffer | null;
    encrypted_crdt: Buffer | null;
    created_at: string;
  }[];

  return c.json({
    currentVersion: resolved.contentVersion,
    revisions: rows.map((row) => ({
      contentVersion: row.version,
      encryptedContent: row.encrypted_content?.toString('base64') ?? null,
      encryptedCrdt: row.encrypted_crdt?.toString('base64') ?? null,
      createdAt: row.created_at,
    })),
  });
});

notes.get('/:shareId', async (c) => {
  const shareId = c.req.param('shareId');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }

  const db = getDb();

  // Determine edit permission based on this link's access mode
  const user = c.get('user');
  const isOwner = user ? resolved.ownerUid === user.uid : false;

  if (isExpiredForUser(resolved, user?.uid)) {
    return c.json({ error: 'This link has expired' }, 410);
  }

  // Enforce invited_edit: only owner or collaborators can access
  if (resolved.accessMode === 'invited_edit' && !isOwner) {
    const collab = isCollaborator(resolved.noteId, user?.uid);
    if (!collab.allowed) {
      return c.json({ error: 'This note is invite-only. You need to be added as a collaborator.' }, 403);
    }
  }

  const canEdit = resolved.accessMode === 'public_edit'
    || isOwner
    || (resolved.accessMode === 'invited_edit' && isCollaborator(resolved.noteId, user?.uid).canEdit);

  return c.json({
    shareId: resolved.linkShareId,
    roomId: resolved.noteShareId, // canonical ID for Yjs room
    title: resolved.title,
    encryptedTitle: resolved.encryptedTitle,
    ownerUid: resolved.ownerUid,
    encryptedContent: resolved.encryptedContent
      ? (resolved.encryptedContent as Buffer).toString('base64')
      : null,
    encryptedCrdt: resolved.encryptedCrdt
      ? resolved.encryptedCrdt.toString('base64')
      : null,
    contentVersion: resolved.contentVersion,
    accessMode: resolved.accessMode,
    canEdit: !!canEdit,
    expiresAt: resolved.expiresAt,
    createdAt: resolved.createdAt,
    updatedAt: resolved.updatedAt,
  });
});

// --- Update note content (via any valid share link) ---
notes.patch('/:shareId', legacyShareRateLimit, async (c) => {
  const shareId = c.req.param('shareId')!;
  const user = c.get('user');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }

  const isOwner = !!user && resolved.ownerUid === user.uid;

  if (isExpiredForUser(resolved, user?.uid)) {
    return c.json({ error: 'This link has expired' }, 410);
  }

  const body = await c.req.json<{
    encryptedContent?: string;
    encryptedCrdt?: string;
    baseVersion?: number;
    title?: string;
    encryptedTitle?: string;
    collaborators?: string[];
  }>();

  if (body.collaborators !== undefined && (!Array.isArray(body.collaborators)
    || body.collaborators.some((uid) => typeof uid !== 'string' || !uid || uid.length > 128))) {
    return c.json({ error: 'collaborators must be a list of user IDs' }, 400);
  }
  const titleError = validateEncryptedTitle(body.encryptedTitle);
  if (titleError) {
    return c.json({ error: titleError }, 400);
  }

  // Check write permission
  if (!isOwner) {
    if (resolved.accessMode === 'read_only') {
      return c.json({ error: 'This link is read-only' }, 403);
    }
    if (resolved.accessMode === 'public_edit'
      && !hasWriteCapability(resolved, c.req.header('X-NoteColab-Write-Token'))) {
      return c.json({ error: 'A valid note-key write capability is required' }, 403);
    }
    if (resolved.accessMode === 'invited_edit') {
      const collab = isCollaborator(resolved.noteId, user?.uid);
      if (!collab.allowed || !collab.canEdit) {
        return c.json({ error: 'You are not authorized to edit this note' }, 403);
      }
    }
    if (body.title !== undefined || body.encryptedTitle !== undefined || body.collaborators) {
      return c.json({ error: 'Only the owner can change note settings' }, 403);
    }
  }

  const db = getDb();
  if (body.collaborators && isOwner) {
    const capacity = checkCollaboratorCapacity(db, user.id, body.collaborators, resolved.noteId);
    if (!capacity.ok) return c.json(collaboratorLimitError(capacity), 403);
  }
  const updates: string[] = [];
  const params: any[] = [];

  let newContent: Buffer | null = null;
  let newCrdt: Buffer | null = null;
  if (body.encryptedContent) {
    const newBuf = Buffer.from(body.encryptedContent, 'base64');
    if (newBuf.byteLength > MAX_NOTE_SIZE) {
      return c.json({ error: `Note too large (max ${mb(MAX_NOTE_SIZE)} MB)` }, 413);
    }
    newContent = newBuf;
  }
  if (body.encryptedCrdt !== undefined) {
    newCrdt = Buffer.from(body.encryptedCrdt, 'base64');
    if (newCrdt.byteLength > MAX_CRDT_SIZE) {
      return c.json({ error: `Encrypted collaboration checkpoint too large (max ${mb(MAX_CRDT_SIZE)} MB)` }, 413);
    }
    if (!body.encryptedContent) {
      return c.json({ error: 'encryptedCrdt requires encryptedContent' }, 400);
    }
  }
  if (body.title !== undefined && isOwner) {
    updates.push('title = ?');
    params.push(body.title);
  }
  if (body.encryptedTitle !== undefined && isOwner) {
    updates.push('title_enc = ?', 'title = NULL');
    params.push(body.encryptedTitle);
  }

  let responseVersion = resolved.contentVersion;
  if (newContent) {
    if (body.baseVersion !== undefined && (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 1)) {
      return c.json({ error: 'baseVersion must be a positive integer' }, 400);
    }

    const saveSnapshot = db.transaction(() => {
      const current = db.prepare(`
        SELECT encrypted_content, encrypted_crdt, content_version
        FROM notes WHERE id = ?
      `).get(resolved.noteId) as {
        encrypted_content: Buffer | null;
        encrypted_crdt: Buffer | null;
        content_version: number;
      };

      if (body.baseVersion !== undefined && current.content_version !== body.baseVersion) {
        return { conflict: true as const, current };
      }

      const previous = db.prepare(`SELECT COALESCE(SUM(LENGTH(COALESCE(encrypted_content, X''))
        + LENGTH(COALESCE(encrypted_crdt, X''))), 0) AS bytes FROM note_revisions WHERE note_id = ?`)
        .get(resolved.noteId) as { bytes: number };
      const incomingBytes = newContent.byteLength + (newCrdt?.byteLength || 0);
      const currentBytes = (current.encrypted_content?.byteLength || 0) + (current.encrypted_crdt?.byteLength || 0);
      const owner = loadUserPlan(db, resolved.ownerId);
      const withHistory = checkQuota(db, owner, incomingBytes - previous.bytes);
      // Recovery must not prevent users reducing usage. Drop the optional previous
      // version when it cannot fit; never hide its bytes from the account quota.
      const quota = withHistory.ok ? withHistory : checkQuota(db, owner, incomingBytes - currentBytes - previous.bytes);
      if (!quota.ok) return { quota };
      db.prepare('DELETE FROM note_revisions WHERE note_id = ?').run(resolved.noteId);
      if (withHistory.ok) {
        db.prepare(`INSERT INTO note_revisions (note_id, version, encrypted_content, encrypted_crdt)
          VALUES (?, ?, ?, ?)`).run(resolved.noteId, current.content_version, current.encrypted_content, current.encrypted_crdt);
      }

      const result = db.prepare(`
        UPDATE notes
        SET encrypted_content = ?, encrypted_crdt = ?,
            content_version = content_version + 1, updated_at = datetime('now')
        WHERE id = ? AND content_version = ?
      `).run(newContent, newCrdt, resolved.noteId, current.content_version);
      if (result.changes !== 1) throw new Error('Concurrent snapshot update');
      return { conflict: false as const, version: current.content_version + 1 };
    })();

    if (saveSnapshot.quota) return c.json(quotaBody(saveSnapshot.quota), 413);
    if (saveSnapshot.conflict) {
      return c.json({
        error: 'The note changed since this snapshot was loaded',
        code: 'snapshot_conflict',
        current: {
          contentVersion: saveSnapshot.current.content_version,
          encryptedContent: saveSnapshot.current.encrypted_content?.toString('base64') ?? null,
          encryptedCrdt: saveSnapshot.current.encrypted_crdt?.toString('base64') ?? null,
        },
      }, 409);
    }
    responseVersion = saveSnapshot.version;
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(resolved.noteId);
    db.prepare(`UPDATE notes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  if (body.encryptedTitle !== undefined && isOwner) {
    db.prepare(`
      UPDATE pending_shares
      SET title = NULL, title_enc = ?
      WHERE note_id = ?
    `).run(body.encryptedTitle, resolved.noteId);
  }

  if (body.collaborators && isOwner) {
    db.prepare('DELETE FROM collaborators WHERE note_id = ?').run(resolved.noteId);
    const insertCollab = db.prepare(
      'INSERT OR IGNORE INTO collaborators (note_id, user_uid, can_edit) VALUES (?, ?, ?)'
    );
    for (const uid of body.collaborators) {
      insertCollab.run(resolved.noteId, uid, 1);
    }
  }

  return c.json({ ok: true, contentVersion: responseVersion });
});

// --- Delete (revoke) entire note ---
notes.delete('/:shareId', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }
  if (resolved.ownerUid !== user.uid) {
    return c.json({ error: 'Only the owner can delete a shared note' }, 403);
  }

  const db = getDb();
  // Cascade deletes share_links, collaborators, images, yjs_state
  db.prepare('DELETE FROM notes WHERE id = ?').run(resolved.noteId);

  return c.json({ ok: true });
});

// --- Yjs room token (owner only; stores a hash of a key-derived token) ---
notes.put('/:shareId/room-token', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }
  if (resolved.ownerUid !== user.uid) {
    return c.json({ error: 'Only the owner can set the room token' }, 403);
  }

  const body = await c.req.json<{ roomToken?: string; writeToken?: string }>();
  if (!body.roomToken || !/^[A-Za-z0-9_-]{20,100}$/.test(body.roomToken)) {
    return c.json({ error: 'roomToken must be base64url and 20..100 chars' }, 400);
  }
  if (body.writeToken !== undefined && !/^[A-Za-z0-9_-]{20,100}$/.test(body.writeToken)) {
    return c.json({ error: 'writeToken must be base64url and 20..100 chars' }, 400);
  }

  const db = getDb();
  db.prepare(`
    UPDATE notes
    SET room_token_hash = ?, write_token_hash = COALESCE(?, write_token_hash)
    WHERE id = ?
  `).run(
    hashApiKey(body.roomToken),
    body.writeToken ? hashApiKey(body.writeToken) : null,
    resolved.noteId,
  );

  return c.json({ ok: true });
});

// --- Image upload/retrieval ---
notes.post('/:shareId/images', legacyShareRateLimit, async (c) => {
  const shareId = c.req.param('shareId')!;
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }

  const user = c.get('user');
  if (isExpiredForUser(resolved, user?.uid)) return c.json({ error: 'This link has expired' }, 410);
  if (!canWriteNote(resolved, user?.uid)
    && !(resolved.accessMode === 'public_edit'
      && hasWriteCapability(resolved, c.req.header('X-NoteColab-Write-Token')))) {
    return c.json({ error: 'You are not authorized to upload images to this note' }, 403);
  }

  const body = await c.req.json<{
    filename: string;
    encryptedData: string;
    mimeType?: string;
  }>();

  if (!body.filename || !body.encryptedData) {
    return c.json({ error: 'filename and encryptedData are required' }, 400);
  }
  // Reject path separators / traversal in the stored filename so a client that
  // later writes it to disk (import/asset download) can't be tricked into
  // escaping its target folder.
  if (
    body.filename.length > 255 ||
    /[\\/]/.test(body.filename) ||
    body.filename.split('/').includes('..') ||
    body.filename.includes('\0') ||
    body.filename === '.' ||
    body.filename === '..'
  ) {
    return c.json({ error: 'Invalid image filename' }, 400);
  }

  const dataBuffer = Buffer.from(body.encryptedData, 'base64');
  if (dataBuffer.byteLength > MAX_IMAGE_SIZE) {
    return c.json({ error: `Image too large (max ${mb(MAX_IMAGE_SIZE)} MB)` }, 413);
  }
  const mimeType = body.mimeType || 'application/octet-stream';

  const db = getDb();

  // Quota check: re-uploading an existing filename replaces it, so only the
  // net change counts against the owner.
  const existingImg = db
    .prepare('SELECT LENGTH(encrypted_data) AS bytes FROM note_images WHERE note_id = ? AND filename = ?')
    .get(resolved.noteId, body.filename) as { bytes: number } | undefined;
  const imgQuota = checkQuota(
    db,
    loadUserPlan(db, resolved.ownerId),
    dataBuffer.byteLength - (existingImg?.bytes || 0),
  );
  if (!imgQuota.ok) {
    return c.json(quotaBody(imgQuota), 413);
  }

  db.prepare(`
    INSERT INTO note_images (note_id, filename, encrypted_data, mime_type)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(note_id, filename) DO UPDATE SET encrypted_data = excluded.encrypted_data, mime_type = excluded.mime_type
  `).run(resolved.noteId, body.filename, dataBuffer, mimeType);

  return c.json({ ok: true });
});

notes.get('/:shareId/images/:filename', async (c) => {
  const shareId = c.req.param('shareId');
  const filename = c.req.param('filename');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }

  // Same expiry + invited_edit gate as GET /:shareId so an expired link can't
  // still enumerate/download image blobs.
  const user = c.get('user');
  if (isExpiredForUser(resolved, user?.uid)) {
    return c.json({ error: 'This link has expired' }, 410);
  }
  if (!canReadNote(resolved, user?.uid)) {
    return c.json({ error: 'This note is invite-only. You need to be added as a collaborator.' }, 403);
  }

  const db = getDb();
  const image = db.prepare(
    'SELECT encrypted_data, mime_type FROM note_images WHERE note_id = ? AND filename = ?'
  ).get(resolved.noteId, filename) as any;

  if (!image) {
    return c.json({ error: 'Image not found' }, 404);
  }

  return c.json({
    encryptedData: (image.encrypted_data as Buffer).toString('base64'),
    mimeType: image.mime_type,
  });
});

notes.get('/:shareId/images', async (c) => {
  const shareId = c.req.param('shareId');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }

  // Same expiry + invited_edit gate as GET /:shareId.
  const user = c.get('user');
  if (isExpiredForUser(resolved, user?.uid)) {
    return c.json({ error: 'This link has expired' }, 410);
  }
  if (!canReadNote(resolved, user?.uid)) {
    return c.json({ error: 'This note is invite-only. You need to be added as a collaborator.' }, 403);
  }

  const db = getDb();
  const images = db.prepare(
    'SELECT filename, mime_type FROM note_images WHERE note_id = ?'
  ).all(resolved.noteId) as any[];

  return c.json({ images: images.map((i: any) => ({ filename: i.filename, mimeType: i.mime_type })) });
});

// --- Collaborator management ---
notes.get('/:shareId/collaborators', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }
  if (resolved.ownerUid !== user.uid) {
    return c.json({ error: 'Only the owner can view collaborators' }, 403);
  }

  const db = getDb();
  const collabs = db.prepare(
    'SELECT user_uid, can_edit FROM collaborators WHERE note_id = ?'
  ).all(resolved.noteId) as any[];

  return c.json({
    collaborators: collabs.map((c: any) => ({
      uid: c.user_uid,
      canEdit: !!c.can_edit,
    })),
  });
});

notes.post('/:shareId/collaborators', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }
  if (resolved.ownerUid !== user.uid) {
    return c.json({ error: 'Only the owner can manage collaborators' }, 403);
  }

  const body = await c.req.json<{ uid: string; canEdit?: boolean }>();
  if (typeof body.uid !== 'string' || !body.uid || body.uid.length > 128) {
    return c.json({ error: 'A valid uid is required' }, 400);
  }

  const db = getDb();
  const capacity = checkCollaboratorCapacity(db, user.id, [body.uid]);
  if (!capacity.ok) return c.json(collaboratorLimitError(capacity), 403);
  db.prepare(
    'INSERT OR REPLACE INTO collaborators (note_id, user_uid, can_edit) VALUES (?, ?, ?)'
  ).run(resolved.noteId, body.uid, body.canEdit !== false ? 1 : 0);

  return c.json({ ok: true });
});

notes.delete('/:shareId/collaborators/:uid', async (c) => {
  const shareId = c.req.param('shareId');
  const uid = c.req.param('uid');
  const user = c.get('user');
  const resolved = resolveShareId(shareId);

  if (!resolved) {
    return c.json({ error: 'Note not found' }, 404);
  }
  if (resolved.ownerUid !== user.uid) {
    return c.json({ error: 'Only the owner can manage collaborators' }, 403);
  }

  const db = getDb();
  db.prepare('DELETE FROM collaborators WHERE note_id = ? AND user_uid = ?').run(resolved.noteId, uid);

  return c.json({ ok: true });
});

// --- Pending shares (encrypted key exchange for auto-import) ---

// Create pending share(s) for collaborators
notes.post('/:shareId/pending-shares', authMiddleware, async (c) => {
  const shareId = c.req.param('shareId')!;
  const user = c.get('user');
  const db = getDb();

  const resolved = resolveShareId(shareId);
  if (!resolved) return c.json({ error: 'Note not found' }, 404);

  // Only owner can create pending shares
  if (resolved.ownerUid !== user.uid) {
    return c.json({ error: 'Only the owner can send shares' }, 403);
  }

  const body = await c.req.json<{
    shares: { recipientUid: string; encryptedKey: string; nonce: string; encryptedTitle?: string }[];
    title?: string;
    encryptedTitle?: string;
  }>();

  if (!body.shares?.length) {
    return c.json({ error: 'shares array is required' }, 400);
  }
  if (body.shares.length > MAX_SHARES_PER_REQUEST) {
    return c.json({ error: `Too many recipients (max ${MAX_SHARES_PER_REQUEST})` }, 400);
  }
  if (body.title && body.title.length > MAX_PENDING_TITLE) {
    return c.json({ error: 'Title too long' }, 400);
  }
  const topLevelTitleError = validateEncryptedTitle(body.encryptedTitle);
  if (topLevelTitleError) {
    return c.json({ error: topLevelTitleError }, 400);
  }
  // Each row holds only a wrapped key + nonce (small). Reject oversized fields so
  // pending_shares can't be used to park bulk data, and require a recipient uid.
  let addedBytes = 0;
  for (const s of body.shares) {
    if (!s?.recipientUid || typeof s.recipientUid !== 'string' || s.recipientUid.length > 128) {
      return c.json({ error: 'Each share needs a valid recipientUid' }, 400);
    }
    if (!s.encryptedKey || s.encryptedKey.length > MAX_WRAPPED_FIELD ||
        !s.nonce || s.nonce.length > MAX_WRAPPED_FIELD) {
      return c.json({ error: 'encryptedKey/nonce missing or too large' }, 400);
    }
    const shareTitleError = validateEncryptedTitle(s.encryptedTitle);
    if (shareTitleError) {
      return c.json({ error: shareTitleError }, 400);
    }
    addedBytes += s.encryptedKey.length + s.nonce.length + (body.title?.length || 0);
  }

  // Pending-share blobs count toward the owner's quota (they persist until the
  // note is deleted), so block growth once the owner is over limit. (audit #8)
  const psQuota = checkQuota(db, loadUserPlan(db, resolved.ownerId), addedBytes);
  if (!psQuota.ok) {
    return c.json(quotaBody(psQuota), 413);
  }

  const insert = db.prepare(PENDING_SHARE_UPSERT_SQL);

  const txn = db.transaction(() => {
    for (const s of body.shares) {
      const encryptedTitle = s.encryptedTitle || body.encryptedTitle || resolved.encryptedTitle || null;
      insert.run(
        resolved.noteId,
        resolved.linkShareId,
        s.recipientUid,
        user.uid,
        s.encryptedKey,
        s.nonce,
        encryptedTitle ? null : (body.title || null),
        encryptedTitle,
      );
    }
  });
  txn();

  return c.json({ ok: true, count: body.shares.length });
});

// Get my pending shares (notes shared with me that I haven't imported yet)
notes.get('/pending-shares/mine', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = getDb();

  const rows = db.prepare(`
    SELECT ps.id, ps.share_id, ps.sender_uid, ps.encrypted_key, ps.nonce, ps.title, ps.title_enc, ps.created_at,
           u.display_name AS sender_display_name,
           COALESCE(sl.access_mode, n.access_mode) AS access_mode
    FROM pending_shares ps
    LEFT JOIN users u ON u.uid = ps.sender_uid
    JOIN notes n ON n.id = ps.note_id
    LEFT JOIN share_links sl ON sl.note_id = ps.note_id AND sl.share_id = ps.share_id
    WHERE ps.recipient_uid = ? AND ps.dismissed = 0
    ORDER BY ps.created_at DESC
  `).all(user.uid) as any[];

  return c.json({
    pendingShares: rows.map((r: any) => ({
      id: r.id,
      shareId: r.share_id,
      senderUid: r.sender_uid,
      senderName: r.sender_display_name,
      encryptedKey: r.encrypted_key,
      nonce: r.nonce,
      title: r.title,
      encryptedTitle: r.title_enc,
      accessMode: r.access_mode,
      createdAt: r.created_at,
    })),
  });
});

// Acknowledge/dismiss a pending share
notes.post('/pending-shares/:id/dismiss', authMiddleware, async (c) => {
  const id = parseInt(c.req.param('id')!, 10);
  const user = c.get('user');
  const db = getDb();

  const dismiss = db.transaction(() => {
    const pending = db.prepare(PENDING_SHARE_DELIVERY_SQL).get(id, user.uid) as {
      note_id: number;
      recipient_uid: string;
      access_mode: string;
    } | undefined;

    if (!pending) return;

    if (pending.access_mode === 'invited_edit') {
      db.prepare('DELETE FROM collaborators WHERE note_id = ? AND user_uid = ?')
        .run(pending.note_id, pending.recipient_uid);
    }
    db.prepare('UPDATE pending_shares SET dismissed = 1 WHERE id = ? AND recipient_uid = ?')
      .run(id, user.uid);
  });
  dismiss();

  return c.json({ ok: true });
});

// Acknowledge a pending share as imported (delete it)
notes.post('/pending-shares/:id/ack', authMiddleware, async (c) => {
  const id = parseInt(c.req.param('id')!, 10);
  const user = c.get('user');
  const db = getDb();

  db.prepare('DELETE FROM pending_shares WHERE id = ? AND recipient_uid = ?')
    .run(id, user.uid);

  return c.json({ ok: true });
});

// --- Invite links ---

// Create an invite link for a note (owner only)
notes.post('/:shareId/invite-links', async (c) => {
  const shareId = c.req.param('shareId')!;
  const user = c.get('user');
  const db = getDb();

  const resolved = resolveShareId(shareId);
  if (!resolved) return c.json({ error: 'Note not found' }, 404);
  if (resolved.ownerUid !== user.uid) return c.json({ error: 'Not the owner' }, 403);

  const { label, maxUses, expiresIn } = await c.req.json<{
    label?: string;
    maxUses?: number;
    expiresIn?: number;
  }>();

  const token = generateInviteToken();
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  db.prepare(`
    INSERT INTO invite_links (
      token, note_id, link_share_id, created_by_uid, label, max_uses, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    token,
    resolved.noteId,
    resolved.linkShareId,
    user.uid,
    label || '',
    maxUses || 1,
    expiresAt,
  );

  return c.json({ token, expiresAt });
});

// Get invite info (public). Deliberately minimal: only what the recipient needs
// before accepting — the E2E-encrypted title (opaque without the key that rides
// in the link fragment), the share id the import URL is built from, and the
// invite's own expiry. No sender identity, no plaintext title. (issue #19)
notes.get('/invite/:token', async (c) => {
  const lookup = lookupInvite(getDb(), c.req.param('token')!);
  if (!lookup.ok) {
    return c.json({ error: lookup.error, ...(lookup.code ? { code: lookup.code } : {}) }, lookup.status);
  }

  return c.json({
    encryptedTitle: lookup.invite.title_enc,
    ...inviteShareIds(lookup.invite),
    expiresAt: lookup.invite.expires_at,
  });
});

// Accept an invite (auth required — adds user as collaborator)
notes.post('/invite/:token/accept', async (c) => {
  const user = c.get('user');
  const db = getDb();

  const lookup = lookupInvite(db, c.req.param('token')!);
  if (!lookup.ok) {
    return c.json({ error: lookup.error, ...(lookup.code ? { code: lookup.code } : {}) }, lookup.status);
  }
  const invite = lookup.invite;

  // Don't let owner accept their own invite
  if (invite.created_by_uid === user.uid) {
    return c.json({ error: 'Cannot accept your own invite' }, 400);
  }

  const owner = db.prepare('SELECT user_id FROM notes WHERE id = ?').get(invite.note_id) as { user_id: number };
  const capacity = checkCollaboratorCapacity(db, owner.user_id, [user.uid]);
  if (!capacity.ok) return c.json(collaboratorLimitError(capacity), 403);

  const accept = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE invite_links
      SET used_count = used_count + 1
      WHERE id = ? AND used_count < max_uses
    `).run(invite.id);

    if (updated.changes === 0) return false;

    db.prepare(`
      INSERT OR IGNORE INTO collaborators (note_id, user_uid, can_edit)
      VALUES (?, ?, 1)
    `).run(invite.note_id, user.uid);

    return true;
  });

  if (!accept()) {
    return c.json({ error: 'Invite link has been used' }, 410);
  }

  return c.json({
    ok: true,
    ...inviteShareIds(invite),
  });
});

// List invite links for a note (owner only)
notes.get('/:shareId/invite-links', async (c) => {
  const shareId = c.req.param('shareId')!;
  const user = c.get('user');
  const db = getDb();

  const resolved = resolveShareId(shareId);
  if (!resolved) return c.json({ error: 'Note not found' }, 404);
  if (resolved.ownerUid !== user.uid) return c.json({ error: 'Not the owner' }, 403);

  // token_version/legacy_valid_until let the owner see which links still use the
  // retired 32-bit format and when they stop working. (issue #19)
  const links = db.prepare(`
    SELECT token, label, max_uses, used_count, expires_at, created_at,
           token_version, legacy_valid_until
    FROM invite_links WHERE note_id = ? ORDER BY created_at DESC
  `).all(resolved.noteId);

  return c.json({ inviteLinks: links });
});

// Delete an invite link (owner only)
notes.delete('/:shareId/invite-links/:token', async (c) => {
  const shareId = c.req.param('shareId')!;
  const token = c.req.param('token')!;
  const user = c.get('user');
  const db = getDb();

  const resolved = resolveShareId(shareId);
  if (!resolved) return c.json({ error: 'Note not found' }, 404);
  if (resolved.ownerUid !== user.uid) return c.json({ error: 'Not the owner' }, 403);

  db.prepare('DELETE FROM invite_links WHERE token = ? AND note_id = ?')
    .run(token, resolved.noteId);

  return c.json({ ok: true });
});

export default notes;

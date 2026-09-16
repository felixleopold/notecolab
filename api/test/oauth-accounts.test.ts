import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'notecolab-oauth-'));
process.env.DATABASE_PATH = join(dataDir, 'test.db');
process.env.OAUTH_CALLBACK_ORIGIN = 'https://notes.example.test';
process.env.OAUTH_GITHUB_CLIENT_ID = 'github-client';
process.env.OAUTH_GITHUB_CLIENT_SECRET = 'github-secret';
process.env.REGISTRATION = 'open';

const originalFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = originalFetch;
  const { closeDb } = await import('../src/db/schema.js');
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function mockGitHubSubject(subject: number): void {
  globalThis.fetch = async (input, init) => {
    assert.ok(init?.signal, 'provider requests must have a timeout signal');
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'temporary-provider-token' });
    }
    if (url === 'https://api.github.com/user') return Response.json({ id: subject, email: 'ignored@example.test' });
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

async function startOAuth(auth: Awaited<typeof import('../src/routes/auth.js')>['default'], options: {
  proof: string;
  intent?: 'login' | 'link';
  apiKey?: string;
}) {
  const { sha256Base64Url } = await import('../src/oauth.js');
  const response = await auth.request('/oauth/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': `test-${options.proof}`,
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify({
      provider: 'github',
      intent: options.intent || 'login',
      clientKind: 'web',
      clientProofHash: sha256Base64Url(options.proof),
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { attemptId: string; authorizationUrl: string };
  return { ...body, state: new URL(body.authorizationUrl).searchParams.get('state')! };
}

test('OAuth state and client completion proof are one-use', async () => {
  const [{ closeDb, getDb }, { migrateAccounts }, { default: auth }, { lookupAuthUser }] = await Promise.all([
    import('../src/db/schema.js'),
    import('../src/account-migration.js'),
    import('../src/routes/auth.js'),
    import('../src/routes/middleware.js'),
  ]);
  migrateAccounts(getDb());
  mockGitHubSubject(4242);

  const attempt = await startOAuth(auth, { proof: 'correct-client-proof' });
  const callback = await auth.request(`/oauth/callback/github?state=${encodeURIComponent(attempt.state)}&code=provider-code`);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), 'https://notes.example.test/login?oauth=complete');

  const replay = await auth.request(`/oauth/callback/github?state=${encodeURIComponent(attempt.state)}&code=replayed-code`);
  assert.equal(replay.status, 400);

  const wrongProof = await auth.request('/oauth/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId: attempt.attemptId, clientProof: 'wrong-client-proof' }),
  });
  assert.equal(wrongProof.status, 401);

  const completion = await auth.request('/oauth/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId: attempt.attemptId, clientProof: 'correct-client-proof' }),
  });
  assert.equal(completion.status, 200);
  const account = await completion.json() as { uid: string; apiKey: string };
  assert.ok(account.uid);
  assert.equal(lookupAuthUser(account.apiKey).ok, true);

  const reusedCompletion = await auth.request('/oauth/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId: attempt.attemptId, clientProof: 'correct-client-proof' }),
  });
  assert.equal(reusedCompletion.status, 409);

  const identity = getDb().prepare('SELECT provider, provider_subject FROM account_identities').get() as {
    provider: string;
    provider_subject: string;
  };
  assert.deepEqual(identity, { provider: 'github', provider_subject: '4242' });
});

test('linking rejects a provider subject already attached to another UID', async () => {
  const [{ getDb }, { default: auth }, { generateApiKey, hashApiKey }] = await Promise.all([
    import('../src/db/schema.js'),
    import('../src/routes/auth.js'),
    import('../src/utils.js'),
  ]);
  const db = getDb();
  const firstKey = generateApiKey();
  const secondKey = generateApiKey();
  const firstUserId = Number(db.prepare("INSERT INTO users (uid, api_key_hash, plan) VALUES ('link-a', ?, 'free')")
    .run(hashApiKey(firstKey)).lastInsertRowid);
  db.prepare("INSERT INTO users (uid, api_key_hash, plan) VALUES ('link-b', ?, 'free')").run(hashApiKey(secondKey));
  db.prepare("INSERT INTO notes (user_id, share_id, encrypted_content) VALUES (?, 'linked-note', X'0102')").run(firstUserId);
  db.prepare("INSERT INTO vault_keys (user_id, note_share_id, encrypted_key) VALUES (?, 'linked-note', 'wrapped-key')")
    .run(firstUserId);
  mockGitHubSubject(999);

  const first = await startOAuth(auth, { proof: 'link-proof-a', intent: 'link', apiKey: firstKey });
  assert.equal((await auth.request(`/oauth/callback/github?state=${first.state}&code=code-a`)).status, 302);
  const firstCompletion = await auth.request('/oauth/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId: first.attemptId, clientProof: 'link-proof-a' }),
  });
  assert.equal(firstCompletion.status, 200);
  const preserved = db.prepare(`
    SELECT u.id,
      (SELECT COUNT(*) FROM notes WHERE user_id = u.id) AS note_count,
      (SELECT COUNT(*) FROM vault_keys WHERE user_id = u.id) AS key_count
    FROM users u WHERE u.uid = 'link-a'
  `).get() as { id: number; note_count: number; key_count: number };
  assert.deepEqual(preserved, { id: firstUserId, note_count: 1, key_count: 1 });

  const second = await startOAuth(auth, { proof: 'link-proof-b', intent: 'link', apiKey: secondKey });
  const collisionCallback = await auth.request(`/oauth/callback/github?state=${second.state}&code=code-b`);
  assert.equal(collisionCallback.status, 302);
  assert.equal(collisionCallback.headers.get('location'), 'https://notes.example.test/login?oauth=failed');
  const collision = await auth.request('/oauth/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId: second.attemptId, clientProof: 'link-proof-b' }),
  });
  assert.equal(collision.status, 400);
  assert.deepEqual(await collision.json(), { error: 'provider_already_linked' });
});

test('linking fails if the initiating plugin credential is revoked before callback', async () => {
  const [{ getDb }, { default: auth }, { generateApiKey, hashApiKey }] = await Promise.all([
    import('../src/db/schema.js'),
    import('../src/routes/auth.js'),
    import('../src/utils.js'),
  ]);
  const db = getDb();
  const apiKey = generateApiKey();
  const userId = Number(db.prepare("INSERT INTO users (uid, api_key_hash, plan) VALUES ('revoked-link', ?, 'free')")
    .run(hashApiKey(apiKey)).lastInsertRowid);
  mockGitHubSubject(123456);

  const attempt = await startOAuth(auth, { proof: 'revoked-link-proof', intent: 'link', apiKey });
  db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').run(hashApiKey(generateApiKey()), userId);

  const callback = await auth.request(`/oauth/callback/github?state=${attempt.state}&code=revoked-link-code`);
  assert.equal(callback.status, 302);
  const completion = await auth.request('/oauth/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId: attempt.attemptId, clientProof: 'revoked-link-proof' }),
  });
  assert.equal(completion.status, 400);
  assert.deepEqual(await completion.json(), { error: 'initiating_credential_revoked' });
  const linked = db.prepare(`
    SELECT COUNT(*) AS count FROM account_identities WHERE user_id = ? AND provider = 'github'
  `).get(userId) as { count: number };
  assert.equal(linked.count, 0);
});

test('OAuth login does not create a new account when registration is closed', async () => {
  const [{ getDb }, { default: auth }] = await Promise.all([
    import('../src/db/schema.js'),
    import('../src/routes/auth.js'),
  ]);
  process.env.REGISTRATION = 'closed';
  mockGitHubSubject(777);
  const usersBefore = (getDb().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
  const attempt = await startOAuth(auth, { proof: 'closed-registration-proof' });
  assert.equal((await auth.request(`/oauth/callback/github?state=${attempt.state}&code=closed-code`)).status, 302);
  const completion = await auth.request('/oauth/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId: attempt.attemptId, clientProof: 'closed-registration-proof' }),
  });
  assert.equal(completion.status, 400);
  assert.deepEqual(await completion.json(), { error: 'registration_closed' });
  const usersAfter = (getDb().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
  assert.equal(usersAfter, usersBefore);
  process.env.REGISTRATION = 'open';
});

test('password logins create independent sessions that can be revoked individually', async () => {
  const [{ getDb }, { default: auth }, { hashApiKey, hashPassword }, { lookupAuthUser }] = await Promise.all([
    import('../src/db/schema.js'),
    import('../src/routes/auth.js'),
    import('../src/utils.js'),
    import('../src/routes/middleware.js'),
  ]);
  getDb().prepare(`
    INSERT INTO users (uid, api_key_hash, password_hash, vault_salt, plan)
    VALUES ('multi-session', ?, ?, 'c2FsdA==', 'free')
  `).run(hashApiKey('plugin-session-owner'), hashPassword('correct horse battery staple'));

  const login = async () => {
    const response = await auth.request('/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'multi-session', password: 'correct horse battery staple' }),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ apiKey: string }>;
  };
  const first = await login();
  const second = await login();
  assert.equal(lookupAuthUser(first.apiKey).ok, true);
  assert.equal(lookupAuthUser(second.apiKey).ok, true);

  const sessionsResponse = await auth.request('/sessions', { headers: { Authorization: `Bearer ${first.apiKey}` } });
  const sessionBody = await sessionsResponse.json() as { sessions: { id: string; current: boolean }[] };
  const firstSession = sessionBody.sessions.find((session) => session.current);
  assert.ok(firstSession);

  const revoke = await auth.request(`/sessions/${firstSession.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${second.apiKey}` },
  });
  assert.equal(revoke.status, 200);
  assert.equal(lookupAuthUser(first.apiKey).ok, false);
  assert.equal(lookupAuthUser(second.apiKey).ok, true);
});

test('changing a password keeps only the initiating browser session and leaves the plugin key valid', async () => {
  const [{ getDb }, { default: auth }, { createAccountSession }, { generateApiKey, hashApiKey }, { lookupAuthUser }] = await Promise.all([
    import('../src/db/schema.js'),
    import('../src/routes/auth.js'),
    import('../src/account-sessions.js'),
    import('../src/utils.js'),
    import('../src/routes/middleware.js'),
  ]);
  const db = getDb();
  const pluginKey = generateApiKey();
  const userId = Number(db.prepare("INSERT INTO users (uid, api_key_hash, plan) VALUES ('password-change', ?, 'free')")
    .run(hashApiKey(pluginKey)).lastInsertRowid);
  const current = createAccountSession(db, userId, 'Current browser');
  const other = createAccountSession(db, userId, 'Other browser');

  const invalidName = await auth.request('/set-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.token}` },
    body: JSON.stringify({ password: 'first secure password', displayName: 'x' }),
  });
  assert.equal(invalidName.status, 400);

  const changed = await auth.request('/set-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.token}` },
    body: JSON.stringify({ password: 'first secure password', displayName: '  Account Owner  ' }),
  });
  assert.equal(changed.status, 200);
  assert.equal((await auth.request('/me', { headers: { Authorization: `Bearer ${current.token}` } })).status, 200);
  assert.equal((await auth.request('/me', { headers: { Authorization: `Bearer ${other.token}` } })).status, 401);
  assert.equal((await auth.request('/me', { headers: { Authorization: `Bearer ${pluginKey}` } })).status, 200);
  assert.equal(lookupAuthUser(pluginKey).ok, true);
  assert.equal((db.prepare("SELECT display_name FROM users WHERE uid = 'password-change'").get() as { display_name: string }).display_name, 'Account Owner');

  const laterBrowser = createAccountSession(db, userId, 'Later browser');
  const pluginChange = await auth.request('/set-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pluginKey}` },
    body: JSON.stringify({ password: 'second secure password' }),
  });
  assert.equal(pluginChange.status, 200);
  assert.equal((await auth.request('/me', { headers: { Authorization: `Bearer ${current.token}` } })).status, 401);
  assert.equal((await auth.request('/me', { headers: { Authorization: `Bearer ${laterBrowser.token}` } })).status, 401);
  assert.equal((await auth.request('/me', { headers: { Authorization: `Bearer ${pluginKey}` } })).status, 200);
});

test('OAuth start rate limit bounds pending-attempt database growth', async () => {
  const [{ default: auth, OAUTH_START_LIMIT, resetOAuthStartRateLimits }, { sha256Base64Url }, { getDb }] = await Promise.all([
    import('../src/routes/auth.js'),
    import('../src/oauth.js'),
    import('../src/db/schema.js'),
  ]);
  resetOAuthStartRateLimits();
  const db = getDb();
  const before = (db.prepare('SELECT COUNT(*) AS count FROM oauth_attempts').get() as { count: number }).count;
  for (let index = 0; index < OAUTH_START_LIMIT; index++) {
    const response = await auth.request('/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': 'rate-limit-test' },
      body: JSON.stringify({
        provider: 'github', intent: 'login', clientKind: 'web',
        clientProofHash: sha256Base64Url(`rate-limit-proof-${index}`),
      }),
    });
    assert.equal(response.status, 200);
  }
  const blocked = await auth.request('/oauth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': 'rate-limit-test' },
    body: JSON.stringify({
      provider: 'github', intent: 'login', clientKind: 'web',
      clientProofHash: sha256Base64Url('rate-limit-proof-blocked'),
    }),
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.has('retry-after'), true);
  const afterCount = (db.prepare('SELECT COUNT(*) AS count FROM oauth_attempts').get() as { count: number }).count;
  assert.equal(afterCount - before, OAUTH_START_LIMIT);
  resetOAuthStartRateLimits();
});

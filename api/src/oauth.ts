import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type OAuthProviderId = 'google' | 'github';
export type OAuthIntent = 'login' | 'link';
export type OAuthClientKind = 'web' | 'plugin';

interface OAuthProviderConfig {
  id: OAuthProviderId;
  name: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  subjectUrl: string;
  scopes: string;
}

export interface OAuthAttemptInput {
  provider: OAuthProviderId;
  intent: OAuthIntent;
  clientKind: OAuthClientKind;
  clientProofHash: string;
  initiatingUserId?: number;
  initiatingKeyType?: 'plugin' | 'web' | 'session';
  initiatingCredentialHash?: string;
  initiatingSessionId?: string;
  registrationAllowed: boolean;
  initiatingIp: string;
}

const ATTEMPT_MINUTES = 10;
const PROVIDER_TIMEOUT_MS = 10_000;

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function callbackOrigin(): string | null {
  const configured = process.env.OAUTH_CALLBACK_ORIGIN?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.origin !== configured.replace(/\/$/, '') || (url.protocol !== 'https:' && url.hostname !== 'localhost')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function oauthCallbackUrl(provider: OAuthProviderId): string | null {
  const origin = callbackOrigin();
  return origin ? `${origin}/api/v1/auth/oauth/callback/${provider}` : null;
}

export function oauthProviders(): OAuthProviderConfig[] {
  if (!callbackOrigin()) return [];
  const providers: OAuthProviderConfig[] = [];
  if (process.env.OAUTH_GOOGLE_CLIENT_ID && process.env.OAUTH_GOOGLE_CLIENT_SECRET) {
    providers.push({
      id: 'google', name: 'Google',
      clientId: process.env.OAUTH_GOOGLE_CLIENT_ID,
      clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      subjectUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scopes: 'openid',
    });
  }
  if (process.env.OAUTH_GITHUB_CLIENT_ID && process.env.OAUTH_GITHUB_CLIENT_SECRET) {
    providers.push({
      id: 'github', name: 'GitHub',
      clientId: process.env.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: process.env.OAUTH_GITHUB_CLIENT_SECRET,
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      subjectUrl: 'https://api.github.com/user',
      scopes: '',
    });
  }
  return providers;
}

export function getOAuthProvider(id: string): OAuthProviderConfig | undefined {
  return oauthProviders().find((provider) => provider.id === id);
}

export function createOAuthAttempt(db: Database.Database, input: OAuthAttemptInput): {
  attemptId: string;
  authorizationUrl: string;
  expiresAt: string;
} {
  const provider = getOAuthProvider(input.provider);
  const redirectUri = provider && oauthCallbackUrl(provider.id);
  if (!provider || !redirectUri) throw new Error('provider_unavailable');

  db.prepare("DELETE FROM oauth_attempts WHERE julianday(expires_at) < julianday('now', '-1 day')").run();

  const attemptId = randomUUID();
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + ATTEMPT_MINUTES * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO oauth_attempts
      (id, state_hash, provider, intent, client_kind, client_proof_hash, code_verifier,
       initiating_user_id, initiating_key_type, initiating_credential_hash, initiating_session_id,
       registration_allowed, initiating_ip, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    attemptId, sha256Base64Url(state), provider.id, input.intent, input.clientKind,
    input.clientProofHash, codeVerifier, input.initiatingUserId || null,
    input.initiatingKeyType || null, input.initiatingCredentialHash || null,
    input.initiatingSessionId || null,
    input.registrationAllowed ? 1 : 0, input.initiatingIp, expiresAt,
  );

  const authorization = new URL(provider.authorizeUrl);
  authorization.searchParams.set('client_id', provider.clientId);
  authorization.searchParams.set('redirect_uri', redirectUri);
  authorization.searchParams.set('response_type', 'code');
  if (provider.scopes) authorization.searchParams.set('scope', provider.scopes);
  authorization.searchParams.set('state', state);
  authorization.searchParams.set('code_challenge', sha256Base64Url(codeVerifier));
  authorization.searchParams.set('code_challenge_method', 'S256');
  if (provider.id === 'google') authorization.searchParams.set('prompt', 'select_account');

  return { attemptId, authorizationUrl: authorization.toString(), expiresAt };
}

async function exchangeAccessToken(provider: OAuthProviderConfig, code: string, codeVerifier: string): Promise<string> {
  const redirectUri = oauthCallbackUrl(provider.id);
  if (!redirectUri) throw new Error('provider_unavailable');
  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('provider_exchange_failed');
  const body = await response.json() as { access_token?: string };
  if (!body.access_token) throw new Error('provider_exchange_failed');
  return body.access_token;
}

export async function fetchProviderSubject(
  provider: OAuthProviderConfig,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const accessToken = await exchangeAccessToken(provider, code, codeVerifier);
  const response = await fetch(provider.subjectUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: provider.id === 'github' ? 'application/vnd.github+json' : 'application/json',
      'User-Agent': 'NoteColab',
    },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('provider_identity_failed');
  const body = await response.json() as { sub?: unknown; id?: unknown };
  const subject = provider.id === 'google' ? body.sub : body.id;
  if ((typeof subject !== 'string' && typeof subject !== 'number') || String(subject).length > 255) {
    throw new Error('provider_identity_failed');
  }
  return String(subject);
}

export function callbackDestination(clientKind: OAuthClientKind, ok: boolean): string | null {
  if (clientKind !== 'web') return null;
  const origin = callbackOrigin();
  return origin ? `${origin}/login?oauth=${ok ? 'complete' : 'failed'}` : null;
}

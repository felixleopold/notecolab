import { requestUrl } from 'obsidian';

export interface OAuthProvider {
  id: 'google' | 'github';
  name: string;
}

interface OAuthStart {
  attemptId: string;
  authorizationUrl: string;
  expiresAt: string;
}

function randomProof(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function proofHash(proof: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function endpoint(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/api/v1/auth${path}`;
}

function completionError(code?: string): string {
  if (code === 'provider_already_linked') return 'That provider account is already linked to another Note Colab account.';
  if (code === 'access_denied' || code === 'authorization_denied') return 'Provider authorization was cancelled.';
  if (code === 'registration_closed') return 'Registration is closed on this server.';
  if (code === 'invite_required') return 'A valid server invite code is required for a new account.';
  return code || 'Provider linking failed';
}

export async function oauthProviders(serverUrl: string): Promise<OAuthProvider[]> {
  const response = await requestUrl({ url: endpoint(serverUrl, '/oauth/providers') });
  if (response.status !== 200) return [];
  const body = response.json as { providers?: OAuthProvider[] };
  return body.providers || [];
}

export async function linkedOAuthProviders(serverUrl: string, apiKey: string): Promise<string[]> {
  const response = await requestUrl({
    url: endpoint(serverUrl, '/identities'),
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (response.status !== 200) return [];
  const body = response.json as { providers?: { provider: string }[] };
  return (body.providers || []).map((identity) => identity.provider);
}

export async function linkOAuthProvider(
  serverUrl: string,
  apiKey: string,
  provider: OAuthProvider['id'],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const proof = randomProof();
  let startResponse: Awaited<ReturnType<typeof requestUrl>>;
  try {
    startResponse = await requestUrl({
      url: endpoint(serverUrl, '/oauth/start'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        provider,
        intent: 'link',
        clientKind: 'plugin',
        clientProofHash: await proofHash(proof),
      }),
      throw: false,
    });
  } catch {
    return { ok: false, error: 'Could not reach the server to start provider linking' };
  }
  if (startResponse.status !== 200) {
    const body = startResponse.json as { error?: string };
    return { ok: false, error: body.error || 'Could not start provider linking' };
  }
  const start = startResponse.json as OAuthStart;
  let authorization: URL;
  try {
    authorization = new URL(start.authorizationUrl);
    if (authorization.protocol !== 'https:') throw new Error('unsafe protocol');
  } catch {
    return { ok: false, error: 'The server returned an invalid authorization URL' };
  }
  window.open(authorization.toString(), '_blank', 'noopener,noreferrer');

  while (Date.now() < new Date(start.expiresAt).getTime()) {
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    let completion: Awaited<ReturnType<typeof requestUrl>>;
    try {
      completion = await requestUrl({
        url: endpoint(serverUrl, '/oauth/complete'),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId: start.attemptId, clientProof: proof }),
        throw: false,
      });
    } catch {
      continue;
    }
    if (completion.status === 202) continue;
    if (completion.status === 200) return { ok: true };
    const body = completion.json as { error?: string };
    return { ok: false, error: completionError(body.error) };
  }
  return { ok: false, error: 'Provider linking expired. Try again.' };
}

export async function unlinkOAuthProvider(
  serverUrl: string,
  apiKey: string,
  provider: OAuthProvider['id'],
): Promise<boolean> {
  try {
    const response = await requestUrl({
      url: endpoint(serverUrl, `/identities/${provider}`),
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
      throw: false,
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

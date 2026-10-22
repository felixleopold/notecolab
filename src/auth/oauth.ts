import { requestUrl } from 'obsidian';

export interface OAuthProvider {
  id: 'google' | 'github';
  name: string;
}

function endpoint(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/api/v1/auth${path}`;
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

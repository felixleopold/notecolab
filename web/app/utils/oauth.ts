export interface OAuthProvider {
  id: 'google' | 'github'
  name: string
}

interface StoredAttempt {
  attemptId: string
  clientProof: string
  returnTo: string
}

interface OAuthCompletion {
  ok: true
  uid?: string
  apiKey?: string
  displayName?: string | null
  linkedProvider?: string
  hasPassword?: boolean
  vaultLocked?: boolean
}

const ATTEMPT_KEY = 'notecolab-oauth-attempt'

function completionError(code?: string): string {
  if (code === 'provider_already_linked') return 'That provider account is already linked to another Note Colab account.'
  if (code === 'access_denied' || code === 'authorization_denied') return 'Provider authorization was cancelled.'
  if (code === 'registration_closed') return 'Registration is closed on this server.'
  if (code === 'invite_required') return 'A valid server invite code is required to create an account.'
  if (code === 'registration_rate_limited') return 'Too many accounts were created from this network. Try again later.'
  return code || 'Provider sign-in failed.'
}

function baseUrl(): string {
  return useRuntimeConfig().public.apiUrl.replace(/\/+$/, '')
}

function randomProof(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function proofHash(proof: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof))
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function discoverOAuth(): Promise<{
  providers: OAuthProvider[]
  registrationMode: 'open' | 'invite' | 'closed'
}> {
  const [providerResponse, infoResponse] = await Promise.all([
    fetch(`${baseUrl()}/api/v1/auth/oauth/providers`),
    fetch(`${baseUrl()}/api/v1/info`),
  ])
  const providerBody = providerResponse.ok
    ? await providerResponse.json() as { providers?: OAuthProvider[] }
    : {}
  const infoBody = infoResponse.ok
    ? await infoResponse.json() as { registration?: { mode?: 'open' | 'invite' | 'closed' } }
    : {}
  return {
    providers: providerBody.providers || [],
    registrationMode: infoBody.registration?.mode || 'open',
  }
}

export async function beginOAuth(options: {
  provider: OAuthProvider['id']
  intent: 'login' | 'link'
  returnTo: string
  inviteCode?: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const clientProof = randomProof()
  const apiKey = localStorage.getItem('notecolab-api-key')
  const response = await fetch(`${baseUrl()}/api/v1/auth/oauth/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.intent === 'link' && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      provider: options.provider,
      intent: options.intent,
      clientKind: 'web',
      clientProofHash: await proofHash(clientProof),
      inviteCode: options.inviteCode || undefined,
    }),
  })
  const body = await response.json().catch(() => ({})) as {
    attemptId?: string
    authorizationUrl?: string
    error?: string
  }
  if (!response.ok || !body.attemptId || !body.authorizationUrl) {
    return { ok: false, error: body.error || 'Could not start sign-in' }
  }
  let authorizationUrl: URL
  try {
    authorizationUrl = new URL(body.authorizationUrl)
    if (authorizationUrl.protocol !== 'https:') throw new Error('unsafe protocol')
  } catch {
    return { ok: false, error: 'The server returned an invalid authorization URL' }
  }
  sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({
    attemptId: body.attemptId,
    clientProof,
    returnTo: options.returnTo,
  } satisfies StoredAttempt))
  window.location.assign(authorizationUrl.toString())
  return { ok: true }
}

export async function completeOAuth(): Promise<{
  completion: OAuthCompletion
  returnTo: string
} | { error: string }> {
  const raw = sessionStorage.getItem(ATTEMPT_KEY)
  if (!raw) return { error: 'This sign-in was started in another browser or has expired.' }
  let attempt: StoredAttempt
  try {
    attempt = JSON.parse(raw) as StoredAttempt
  } catch {
    sessionStorage.removeItem(ATTEMPT_KEY)
    return { error: 'The saved sign-in request is invalid.' }
  }
  let response: Response
  try {
    response = await fetch(`${baseUrl()}/api/v1/auth/oauth/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId: attempt.attemptId, clientProof: attempt.clientProof }),
    })
  } catch {
    return { error: 'Could not reach the server to finish sign-in.' }
  }
  const body = await response.json().catch(() => ({})) as OAuthCompletion & { error?: string }
  if (response.status === 202) return { error: 'Provider authorization has not finished yet.' }
  if (!response.ok) {
    sessionStorage.removeItem(ATTEMPT_KEY)
    return { error: completionError(body.error) }
  }
  sessionStorage.removeItem(ATTEMPT_KEY)
  if (body.apiKey && body.uid) {
    localStorage.setItem('notecolab-api-key', body.apiKey)
    localStorage.setItem('notecolab-uid', body.uid)
    // useApi treats this key as the marker for a revocable web session. The
    // server uses the same Participant fallback when no public name is set.
    localStorage.setItem('notecolab-display-name', body.displayName || 'Participant')
    sessionStorage.removeItem('notecolab-vault-key')
  }
  return { completion: body, returnTo: attempt.returnTo }
}

interface RegistrationIdentity {
  uid: string;
  apiKey: string;
}

let pendingRegistration: Promise<RegistrationIdentity> | null = null;

function storedIdentity(): RegistrationIdentity | null {
  const apiKey = localStorage.getItem('notecolab-api-key');
  const uid = localStorage.getItem('notecolab-uid');
  return apiKey && uid ? { uid, apiKey } : null;
}

export async function ensureRegistration(baseUrl: string): Promise<RegistrationIdentity> {
  const existing = storedIdentity();
  if (existing) return existing;
  if (pendingRegistration) return pendingRegistration;

  pendingRegistration = (async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/register`, { method: 'POST' });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message = typeof body === 'object' && body !== null && 'error' in body
        && typeof body.error === 'string'
        ? body.error
        : 'Registration failed';
      throw new Error(message);
    }

    const identity = await response.json() as RegistrationIdentity;
    localStorage.setItem('notecolab-api-key', identity.apiKey);
    localStorage.setItem('notecolab-uid', identity.uid);
    return identity;
  })();

  try {
    return await pendingRegistration;
  } finally {
    pendingRegistration = null;
  }
}

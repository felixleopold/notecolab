/**
 * API client composable for the notecolab backend.
 */

import { ensureRegistration } from '~/utils/registration';

interface NoteMetadata {
  share_id: string;
  title: string | null;
  encryptedTitle: string | null;
  access_mode: 'public_edit' | 'invited_edit' | 'read_only';
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  owner_uid: string;
}

interface NoteContent {
  shareId: string;
  roomId: string;
  title: string | null;
  encryptedTitle: string | null;
  encryptedContent: string;
  encryptedCrdt: string | null;
  contentVersion: number;
  accessMode: string;
  canEdit: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionInfo {
  room_id: string;
  type: 'fleeting' | 'persistent';
  created_at: string;
  ended_at: string | null;
  share_id: string | null;
}

export function useApi() {
  const config = useRuntimeConfig();
  const baseUrl = config.public.apiUrl;

  // Store API key in localStorage
  function getApiKey(): string | null {
    if (import.meta.server) return null;
    return localStorage.getItem('notecolab-api-key');
  }

  function getUid(): string | null {
    if (import.meta.server) return null;
    return localStorage.getItem('notecolab-uid');
  }

  async function ensureRegistered(): Promise<{ uid: string; apiKey: string }> {
    return ensureRegistration(baseUrl);
  }

  async function fetchWithAuth(path: string, options: RequestInit = {}): Promise<Response> {
    const { apiKey } = await ensureRegistered();
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(options.headers || {}),
      },
    });

    // Handle stale credentials
    if (res.status === 401) {
      const data = await res.clone().json().catch(() => null) as { code?: string } | null;
      // If this was a logged-in session that got invalidated (e.g. password changed from plugin),
      // redirect to login instead of silently re-registering
      const wasLoggedIn = localStorage.getItem('notecolab-display-name');
      if (wasLoggedIn || data?.code === 'session_expired') {
        localStorage.removeItem('notecolab-api-key');
        localStorage.removeItem('notecolab-uid');
        localStorage.removeItem('notecolab-display-name');
        sessionStorage.removeItem('notecolab-vault-key');
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
        return res;
      }

      // Anonymous session — re-register
      localStorage.removeItem('notecolab-api-key');
      localStorage.removeItem('notecolab-uid');
      const fresh = await ensureRegistered();
      return fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${fresh.apiKey}`,
          ...(options.headers || {}),
        },
      });
    }

    return res;
  }

  async function getNoteMeta(shareId: string): Promise<{ data: NoteMetadata | null; status: number }> {
    const { apiKey } = await ensureRegistered();
    const res = await fetch(`${baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/meta`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!res.ok) return { data: null, status: res.status };
    return { data: await res.json(), status: res.status };
  }

  async function getNoteContent(shareId: string): Promise<{ data: NoteContent | null; status: number }> {
    const res = await fetchWithAuth(`/api/v1/notes/${encodeURIComponent(shareId)}`);
    if (!res.ok) return { data: null, status: res.status };
    return { data: await res.json(), status: res.status };
  }

  async function updateNote(
    shareId: string,
    data: {
      encryptedContent?: string;
      encryptedCrdt?: string;
      baseVersion?: number;
      title?: string;
      encryptedTitle?: string;
    },
    writeCapability?: string,
  ): Promise<{
    ok: boolean;
    status: number;
    contentVersion?: number;
    conflict?: {
      contentVersion: number;
      encryptedContent: string | null;
      encryptedCrdt: string | null;
    };
  }> {
    try {
      const res = await fetchWithAuth(`/api/v1/notes/${encodeURIComponent(shareId)}`, {
        method: 'PATCH',
        headers: writeCapability ? { 'X-NoteColab-Write-Token': writeCapability } : undefined,
        body: JSON.stringify(data),
      });
      const response = await res.json().catch(() => ({})) as {
        contentVersion?: number;
        code?: string;
        current?: {
          contentVersion: number;
          encryptedContent: string | null;
          encryptedCrdt: string | null;
        };
      };
      return {
        ok: res.ok,
        status: res.status,
        contentVersion: response.contentVersion,
        conflict: response.code === 'snapshot_conflict' ? response.current : undefined,
      };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  async function getNoteHistory(shareId: string): Promise<{
    currentVersion: number;
    revisions: {
      contentVersion: number;
      encryptedContent: string | null;
      encryptedCrdt: string | null;
      createdAt: string;
    }[];
  } | null> {
    try {
      const res = await fetchWithAuth(`/api/v1/notes/${encodeURIComponent(shareId)}/history`);
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async function getSession(roomId: string): Promise<SessionInfo | null> {
    const res = await fetchWithAuth(`/api/v1/sessions/${encodeURIComponent(roomId)}`);
    if (!res.ok) return null;
    return res.json();
  }

  // --- Auth ---
  async function login(uid: string, password: string): Promise<{ ok: boolean; error?: string; displayName?: string; vaultSalt?: string }> {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Login failed' }));
      return { ok: false, error: err.error };
    }
    const data = await res.json();
    localStorage.setItem('notecolab-api-key', data.apiKey);
    localStorage.setItem('notecolab-uid', data.uid);
    if (data.displayName) {
      localStorage.setItem('notecolab-display-name', data.displayName);
    }
    return { ok: true, displayName: data.displayName, vaultSalt: data.vaultSalt };
  }

  async function logout() {
    if (import.meta.server) return;
    const apiKey = getApiKey();
    if (apiKey) {
      await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      }).catch(() => undefined);
    }
    localStorage.removeItem('notecolab-api-key');
    localStorage.removeItem('notecolab-uid');
    localStorage.removeItem('notecolab-display-name');
    clearVaultKey();
  }

  function isLoggedIn(): boolean {
    return !!getApiKey() && !!getUid();
  }

  async function setPassword(password: string, displayName?: string): Promise<{ ok: boolean; vaultSalt?: string }> {
    const res = await fetchWithAuth('/api/v1/auth/set-password', {
      method: 'POST',
      body: JSON.stringify({ password, displayName }),
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, vaultSalt: data.vaultSalt };
  }

  async function getMe(): Promise<{ uid: string; displayName: string | null; hasPassword: boolean; createdAt: string } | null> {
    const res = await fetchWithAuth('/api/v1/auth/me');
    if (!res.ok) return null;
    return res.json();
  }

  // --- Dashboard ---
  async function getMyNotes(): Promise<any[]> {
    const res = await fetchWithAuth('/api/v1/notes/mine');
    if (!res.ok) return [];
    const data = await res.json();
    return data.notes || [];
  }

  async function getSharedWithMe(): Promise<any[] | null> {
    const res = await fetchWithAuth('/api/v1/notes/shared-with-me');
    if (!res.ok) return null;
    const data = await res.json();
    return data.notes || [];
  }

  async function getPendingShares(): Promise<any[]> {
    const res = await fetchWithAuth('/api/v1/notes/pending-shares/mine');
    if (!res.ok) return [];
    const data = await res.json();
    return data.pendingShares || [];
  }

  // --- Plans & billing ---
  interface BillingPlan {
    id: string;
    name: string;
    description: string | null;
    quotaBytes: number;
    priceLabel: string | null;
    durationDays: number | null;
    checkoutAvailable: boolean;
    isDefault: boolean;
    collaboratorLimit?: number;
  }
  interface BillingInfo {
    billingEnabled: boolean;
    checkoutAvailable: boolean;
    proPrice: string;
    upgradePlanId: string | null;
    plans: Record<string, BillingPlan>;
    plan?: string;
    planExpiresAt?: string | null;
    storage?: { usedBytes: number; limitBytes: number; unlimited: boolean; usagePercent: number };
    collaborators?: { limit: number; used: number; requested?: number; ok?: boolean; plan?: string };
  }

  async function getBillingInfo(): Promise<BillingInfo | null> {
    const res = await fetchWithAuth('/api/v1/billing/info');
    if (!res.ok) return null;
    return res.json();
  }

  async function createCheckout(planId?: string): Promise<{ url?: string; price?: string | null; error?: string }> {
    const res = await fetchWithAuth('/api/v1/billing/checkout', { method: 'POST', body: JSON.stringify({ planId }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || 'Checkout failed' };
    return data;
  }

  // --- Vault keys ---
  async function getVaultKeys(): Promise<{ note_share_id: string; encrypted_key: string }[]> {
    const res = await fetchWithAuth('/api/v1/auth/vault-keys');
    if (!res.ok) return [];
    const data = await res.json();
    return data.keys || [];
  }

  function setVaultKey(key: string) {
    if (import.meta.server) return;
    sessionStorage.setItem('notecolab-vault-key', key);
  }

  function getVaultKey(): string | null {
    if (import.meta.server) return null;
    return sessionStorage.getItem('notecolab-vault-key');
  }

  function clearVaultKey() {
    if (import.meta.server) return;
    sessionStorage.removeItem('notecolab-vault-key');
  }

  return {
    getApiKey,
    getUid,
    ensureRegistered,
    fetchWithAuth,
    getNoteMeta,
    getNoteContent,
    updateNote,
    getNoteHistory,
    getSession,
    login,
    logout,
    isLoggedIn,
    setPassword,
    getMe,
    getMyNotes,
    getSharedWithMe,
    getPendingShares,
    getBillingInfo,
    createCheckout,
    getVaultKeys,
    setVaultKey,
    getVaultKey,
    clearVaultKey,
    baseUrl,
  };
}

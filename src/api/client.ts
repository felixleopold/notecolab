import { requestUrl } from 'obsidian';
import type { ColabSettings, NoteContent, SessionInfo } from '../types';
import { requestHeaders } from './credentials';

export class ApiClient {
  /**
   * Per-instance base URL override. When set, requests go here instead of
   * `settings.serverUrl`. Used to import/collab a share link that was minted on
   * a *different* server (the link carries its own host). See `withBaseUrl`.
   */
  private baseOverride?: string;
  private includeCredentials = true;
  private writeCapability?: string;

  constructor(private settings: ColabSettings) {}

  /** Base URL every request targets: a foreign-origin override, or the configured server. */
  private get baseUrl(): string {
    return this.baseOverride || this.settings.serverUrl;
  }

  /**
   * Return an anonymous client that talks to `baseUrl` (a share link's own
   * origin). Home-server credentials are deliberately not copied. This unlocks cross-server
   * import + collaboration for read_only / public_edit links: the note's public
   * GET endpoints and the Yjs relay accept the link's shareId + derived room
   * token without a home-server account, so no federation is needed. (issue #8)
   */
  withBaseUrl(baseUrl: string): ApiClient {
    const clone = new ApiClient(this.settings);
    clone.baseOverride = baseUrl.replace(/\/+$/, '');
    clone.includeCredentials = false;
    clone.writeCapability = this.writeCapability;
    return clone;
  }

  /** Attach the key-derived capability used for anonymous public-edit writes. */
  withWriteCapability(writeCapability: string): ApiClient {
    const clone = new ApiClient(this.settings);
    clone.baseOverride = this.baseOverride;
    clone.includeCredentials = this.includeCredentials;
    clone.writeCapability = writeCapability;
    return clone;
  }

  get usesAccountCredentials(): boolean {
    return this.includeCredentials;
  }

  private get headers(): Record<string, string> {
    return {
      ...requestHeaders(this.settings.apiKey, this.includeCredentials),
      ...(this.writeCapability ? { 'X-NoteColab-Write-Token': this.writeCapability } : {}),
    };
  }

  async register(publicKey?: string, inviteCode?: string): Promise<{ uid: string; apiKey: string }> {
    const res = await requestUrl({
      url: `${this.baseUrl}/api/v1/auth/register`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey, ...(inviteCode ? { inviteCode } : {}) }),
    });
    return res.json;
  }

  async shareNote(data: {
    title?: string;
    encryptedTitle?: string;
    encryptedContent: string;
    accessMode?: string;
    expiresIn?: number;
    collaborators?: string[];
  }): Promise<{ shareId: string; expiresAt: string | null }> {
    const res = await requestUrl({
      url: `${this.baseUrl}/api/v1/notes/share`,
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(data),
    });
    return res.json;
  }

  async getNoteContent(shareId: string): Promise<NoteContent | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json;
    } catch {
      return null;
    }
  }

  async getNoteMeta(shareId: string): Promise<{ accessMode: string; expiresAt: string | null } | 'expired' | 'not_found' | 'forbidden' | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/meta`,
        method: 'GET',
        headers: this.headers,
      });
      return { accessMode: res.json.access_mode, expiresAt: res.json.expires_at };
    } catch (e: any) {
      if (e?.status === 410) return 'expired';
      if (e?.status === 404) return 'not_found';
      if (e?.status === 403) return 'forbidden';
      return null; // network error or other transient failure
    }
  }

  async updateNote(shareId: string, data: {
    encryptedContent?: string;
    accessMode?: string;
    expiresIn?: number | null;
    title?: string;
    encryptedTitle?: string;
    collaborators?: string[];
  }): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}`,
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify(data),
      });
      return true;
    } catch {
      return false;
    }
  }

  async deleteNote(shareId: string): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}`,
        method: 'DELETE',
        headers: this.headers,
      });
      return true;
    } catch {
      return false;
    }
  }

  async createSession(type: 'fleeting' | 'persistent', shareId?: string): Promise<{ roomId: string; type: string }> {
    const res = await requestUrl({
      url: `${this.baseUrl}/api/v1/sessions/create`,
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ type, shareId }),
    });
    return res.json;
  }

  async endSession(roomId: string): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(roomId)}`,
        method: 'DELETE',
        headers: this.headers,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getSession(roomId: string): Promise<SessionInfo | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(roomId)}`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json;
    } catch {
      return null;
    }
  }

  async setRoomToken(shareId: string, roomToken: string, writeToken?: string): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/room-token`,
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({ roomToken, ...(writeToken ? { writeToken } : {}) }),
      });
      return true;
    } catch (e: any) {
      if (e?.status !== 403) {
        console.warn('NoteColab: setRoomToken failed:', e);
      }
      return false;
    }
  }

  async uploadImage(shareId: string, filename: string, encryptedData: string, mimeType: string): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/images`,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ filename, encryptedData, mimeType }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async getImage(shareId: string, filename: string): Promise<{ encryptedData: string; mimeType: string } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/images/${encodeURIComponent(filename)}`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json;
    } catch {
      return null;
    }
  }

  async listImages(shareId: string): Promise<{ filename: string; mimeType: string }[]> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/images`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json.images || [];
    } catch {
      return [];
    }
  }

  // --- Link management ---

  async listLinks(shareId: string): Promise<{
    noteShareId: string;
    title: string | null;
    encryptedTitle: string | null;
    links: { shareId: string; label: string; accessMode: string; expiresAt: string | null; createdAt: string }[];
  } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/links`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json;
    } catch {
      return null;
    }
  }

  async createLink(noteShareId: string, data: {
    accessMode?: string;
    expiresIn?: number;
    label?: string;
  }): Promise<{ shareId: string; accessMode: string; expiresAt: string | null } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(noteShareId)}/links`,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(data),
      });
      return res.json;
    } catch {
      return null;
    }
  }

  async updateLink(linkShareId: string, data: {
    accessMode?: string;
    expiresIn?: number | null;
    label?: string;
  }): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/links/${encodeURIComponent(linkShareId)}`,
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify(data),
      });
      return true;
    } catch {
      return false;
    }
  }

  async deleteLink(linkShareId: string): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/links/${encodeURIComponent(linkShareId)}`,
        method: 'DELETE',
        headers: this.headers,
      });
      return true;
    } catch {
      return false;
    }
  }

  async listMyNotes(): Promise<{
    notes: {
      noteShareId: string;
      title: string | null;
      encryptedTitle: string | null;
      createdAt: string;
      updatedAt: string;
      links: { shareId: string; label: string; accessMode: string; expiresAt: string | null; createdAt: string }[];
    }[];
  } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/mine`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json;
    } catch (e) {
      console.error('NoteColab: listMyNotes failed:', e);
      return null;
    }
  }

  async getSharedWithMe(): Promise<{
    notes: {
      noteId: number;
      title: string | null;
      encryptedTitle: string | null;
      ownerUid: string;
      shareId: string;
      accessMode: string;
      canEdit: boolean;
      createdAt: string;
      updatedAt: string;
    }[];
  } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/shared-with-me`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json;
    } catch (e) {
      console.error('NoteColab: getSharedWithMe failed:', e);
      return null;
    }
  }

  async leaveSharedNote(shareId: string): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/shared-with-me/${encodeURIComponent(shareId)}`,
        method: 'DELETE',
        headers: this.headers,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getMyStorage(): Promise<{
    plan?: 'free' | 'pro';
    planExpiresAt?: string | null;
    unlimited?: boolean;
    storageLimit: number;
    totalBytes: number;
    otherBytes?: number;
    usagePercent: number;
    noteCount: number;
    notes: {
      noteShareId: string;
      title: string | null;
      encryptedTitle: string | null;
      createdAt: string;
      updatedAt: string;
      storage: {
        contentBytes: number;
        imageCount: number;
        imageBytes: number;
        yjsBytes: number;
        totalBytes: number;
      };
    }[];
  } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/mine/storage`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json;
    } catch (e) {
      console.error('NoteColab: getMyStorage failed:', e);
      return null;
    }
  }

  // --- Plans & billing ---

  /** Server capabilities (name, plans, whether paid upgrades are offered). */
  async getServerInfo(): Promise<{
    name: string;
    protocolVersion: number;
    billingEnabled: boolean;
    checkoutAvailable: boolean;
    proPrice: string;
    upgradePlanId?: string | null;
    plans: Record<string, { id: string; name: string; description: string | null; quotaBytes: number; priceLabel: string | null; durationDays: number | null; checkoutAvailable: boolean; isDefault: boolean }>;
    registration?: { mode: 'open' | 'invite' | 'closed'; inviteRequired: boolean };
  } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/info`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      return res.json;
    } catch {
      return null;
    }
  }

  /** Billing info for the current user (capabilities + plan + storage). */
  async getBillingInfo(): Promise<{
    billingEnabled: boolean;
    checkoutAvailable: boolean;
    proPrice: string;
    upgradePlanId?: string | null;
    plans: Record<string, { id: string; name: string; description: string | null; quotaBytes: number; priceLabel: string | null; durationDays: number | null; checkoutAvailable: boolean; isDefault: boolean }>;
    plan?: string;
    planExpiresAt?: string | null;
    storage?: { usedBytes: number; limitBytes: number; unlimited: boolean; usagePercent: number };
  } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/billing/info`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json;
    } catch {
      return null;
    }
  }

  /** Start a paid upgrade — returns a checkout URL to open in the browser. */
  async createCheckout(planId?: string): Promise<{ url: string; price: string | null } | { error: string } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/billing/checkout`,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ planId }),
      });
      return res.json;
    } catch (e: any) {
      // requestUrl throws on non-2xx; surface the server's error message if any.
      const msg = e?.json?.error || (e?.status === 503 ? 'Billing is not available on this server' : 'Checkout failed');
      return { error: msg };
    }
  }

  // --- Collaborator management ---

  async listCollaborators(shareId: string): Promise<{ uid: string; canEdit: boolean }[]> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/collaborators`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json.collaborators || [];
    } catch {
      return [];
    }
  }

  async addCollaborator(shareId: string, uid: string, canEdit: boolean = true): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/collaborators`,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ uid, canEdit }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async removeCollaborator(shareId: string, uid: string): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/collaborators/${encodeURIComponent(uid)}`,
        method: 'DELETE',
        headers: this.headers,
      });
      return true;
    } catch {
      return false;
    }
  }

  // --- Public key exchange ---

  async uploadPublicKey(publicKey: string): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/auth/public-key`,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ publicKey }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async getPublicKey(uid: string): Promise<{ publicKey: string; displayName: string | null } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/auth/public-key/${encodeURIComponent(uid)}`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json;
    } catch {
      return null;
    }
  }

  async getMyProfile(): Promise<{ uid: string; displayName: string | null } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/auth/me`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json;
    } catch {
      return null;
    }
  }

  async setUsername(username: string | null): Promise<{ ok: boolean; username: string | null } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/auth/me`,
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify({ username }),
      });
      return res.json;
    } catch {
      return null;
    }
  }

  // --- Pending shares (encrypted key exchange for auto-import) ---

  async createPendingShares(
    shareId: string,
    shares: { recipientUid: string; encryptedKey: string; nonce: string }[],
    encryptedTitle?: string
  ): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/pending-shares`,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ shares, encryptedTitle }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async getPendingShares(): Promise<{
    id: number;
    shareId: string;
    senderUid: string;
    senderName: string | null;
    encryptedKey: string;
    nonce: string;
    title: string | null;
    encryptedTitle: string | null;
    accessMode: 'public_edit' | 'invited_edit' | 'read_only';
    createdAt: string;
  }[]> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/pending-shares/mine`,
        method: 'GET',
        headers: this.headers,
      });
      return res.json.pendingShares || [];
    } catch (e) {
      console.error('NoteColab: getPendingShares failed:', e);
      return [];
    }
  }

  async ackPendingShare(id: number): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/pending-shares/${id}/ack`,
        method: 'POST',
        headers: this.headers,
      });
      return true;
    } catch {
      return false;
    }
  }

  async dismissPendingShare(id: number): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/pending-shares/${id}/dismiss`,
        method: 'POST',
        headers: this.headers,
      });
      return true;
    } catch {
      return false;
    }
  }

  async rotateApiKey(): Promise<{ apiKey: string } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/auth/rotate-key`,
        method: 'POST',
        headers: this.headers,
        body: '{}',
      });
      return res.json;
    } catch {
      return null;
    }
  }

  // --- Vault keys (encrypted note keys for web dashboard) ---

  // --- Invite links ---

  async createInviteLink(shareId: string, options?: { label?: string; maxUses?: number; expiresIn?: number }): Promise<{ token: string; expiresAt: string | null } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/${encodeURIComponent(shareId)}/invite-links`,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(options || {}),
      });
      return res.json;
    } catch {
      return null;
    }
  }

  async acceptInvite(token: string): Promise<{ ok: boolean; shareId: string } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/notes/invite/${encodeURIComponent(token)}/accept`,
        method: 'POST',
        headers: this.headers,
        body: '{}',
      });
      return res.json;
    } catch {
      return null;
    }
  }

  // --- Vault keys (cont.) ---

  async setPassword(password: string, displayName?: string): Promise<{ ok: boolean; vaultSalt?: string }> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/v1/auth/set-password`,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ password, displayName }),
      });
      return { ok: true, vaultSalt: res.json.vaultSalt };
    } catch {
      return { ok: false };
    }
  }

  async uploadVaultKeys(keys: { noteShareId: string; encryptedKey: string }[]): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/auth/vault-keys`,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ keys }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async clearVaultKeys(): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.baseUrl}/api/v1/auth/vault-keys`,
        method: 'DELETE',
        headers: this.headers,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export interface Contact {
  uid: string;
  name: string;
}

export interface ColabSettings {
  serverUrl: string;
  apiKey: string;
  uid: string;
  defaultEncryption: boolean;
  defaultAccessMode: 'public_edit' | 'invited_edit' | 'read_only';
  defaultTtlSeconds: number; // 0 = no expiry
  // X25519 keypair for E2E key exchange
  publicKey: string;
  secretKey: string;
  // Trusted contacts for easy collaboration
  contacts: Contact[];
  // Public username is resolved by UID; contact names remain local aliases.
  username: string;
  usernamePromptState: 'upgrade' | 'after_shares' | 'done';
  sharedNoteCount: number;
  // Auto-accept notes shared with me (skip the accept/deny popup)
  autoImport: boolean;
  // PBKDF2-derived vault key for web dashboard access (base64url, memory-safe)
  vaultKey: string;
  // Origins the user allowed to import/collab from even though they differ from
  // `serverUrl` (cross-server share links). Each is a full origin, e.g.
  // "https://serverA.com". Used to skip the trust prompt on repeat imports.
  trustedShareHosts: string[];
}

export const OFFICIAL_SERVER_URL = 'https://notecolab.com';
export const LEGACY_OFFICIAL_SERVER_URL = 'https://notecolab.felixmrak.com';

export function migrateOfficialServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '') === LEGACY_OFFICIAL_SERVER_URL
    ? OFFICIAL_SERVER_URL
    : serverUrl;
}

export function isOfficialServerAlias(first: string, second: string): boolean {
  try {
    const officialOrigins = new Set([OFFICIAL_SERVER_URL, LEGACY_OFFICIAL_SERVER_URL]);
    return officialOrigins.has(new URL(first).origin) && officialOrigins.has(new URL(second).origin);
  } catch {
    return false;
  }
}

export function initialUsernamePromptState(saved: Partial<ColabSettings> | null): ColabSettings['usernamePromptState'] {
  if (saved?.apiKey && saved.usernamePromptState === undefined) return 'upgrade';
  return saved?.usernamePromptState || 'after_shares';
}

export const DEFAULT_SETTINGS: ColabSettings = {
  serverUrl: OFFICIAL_SERVER_URL,
  apiKey: '',
  uid: '',
  defaultEncryption: true,
  defaultAccessMode: 'read_only',
  defaultTtlSeconds: 86400, // 24 hours
  publicKey: '',
  secretKey: '',
  contacts: [],
  username: '',
  usernamePromptState: 'after_shares',
  sharedNoteCount: 0,
  autoImport: false,
  vaultKey: '',
  trustedShareHosts: [],
};

export interface ShareResult {
  shareId: string;
  shareUrl: string;
  expiresAt: string | null;
}

export interface SessionResult {
  roomId: string;
  type: 'fleeting' | 'persistent';
  shareUrl: string;
}

export interface NoteContent {
  shareId: string;
  roomId: string;
  title: string | null;
  encryptedTitle: string | null;
  encryptedContent: string;
  ownerUid?: string;
  accessMode: string;
  canEdit: boolean;
  expiresAt: string | null;
  updatedAt?: string;
}

export interface SessionInfo {
  room_id: string;
  type: 'fleeting' | 'persistent';
  created_at: string;
  ended_at: string | null;
  share_id: string | null;
}

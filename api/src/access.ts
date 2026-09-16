// Server-level access control for the NoteColab server.
//
// Two independent, opt-in knobs let a self-hoster turn the default *open* server
// (anyone can register and get a quota'd account) into a fully private instance:
//
//   REGISTRATION     open (default) | invite | closed
//   WS_REQUIRE_AUTH  gate the WebSocket upgrade on a valid bearer key
//
// Both default to today's open behavior so existing deployments are unaffected.
// The relevant bits are advertised on GET /api/v1/info so the plugin can adapt.

import { createHash, timingSafeEqual } from 'crypto';

export type RegistrationMode = 'open' | 'invite' | 'closed';

/** How self-registration behaves. Unknown/unset ⇒ `open` (backward compatible). */
export function registrationMode(): RegistrationMode {
  const raw = (process.env.REGISTRATION || 'open').trim().toLowerCase();
  if (raw === 'invite' || raw === 'closed') return raw;
  return 'open';
}

/**
 * Verify a caller-supplied invite code against REGISTRATION_SECRET in constant
 * time. An empty/unset secret always fails closed: `invite` mode without a
 * configured secret must never accept registrations.
 */
export function verifyInviteCode(provided: string | null | undefined): boolean {
  const secret = process.env.REGISTRATION_SECRET || '';
  if (!secret || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/** Whether the WebSocket upgrade requires a valid per-user bearer key. */
export function wsRequireAuth(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.WS_REQUIRE_AUTH || '').trim());
}

/** Public access-control capabilities exposed on GET /api/v1/info. */
export function publicAccessInfo() {
  const mode = registrationMode();
  return {
    registration: {
      mode,
      // Convenience flag so the client can prompt without knowing the vocabulary.
      inviteRequired: mode === 'invite',
    },
  };
}

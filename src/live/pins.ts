/** Rooms seen encrypted, shared by sessions and imports so all pin the same entry (§6.1). */
import type { ColabSettings } from '../types';
import { decryptCrdt } from './checkpoint';
import { livePinId } from './keys';
import type { LiveMode } from './mode';

export function liveOrigin(settings: ColabSettings, origin?: string): string {
  return (origin || settings.serverUrl).replace(/\/+$/, '');
}

/** `pinId` is `livePinId(noteKey)`, so every link and room of a note shares one pin. */
export function isRoomPinned(settings: ColabSettings, origin: string, pinId: string): boolean {
  return settings.liveE2EPins?.includes(`${origin}|${pinId}`) ?? false;
}

const pinListeners = new Set<(origin: string, pinId: string) => void>();

/** Lets a running session leave the plain room when its note is pinned elsewhere. */
export function onRoomPinned(listener: (origin: string, pinId: string) => void): () => void {
  pinListeners.add(listener);
  return () => pinListeners.delete(listener);
}

/** Permanent: a note seen encrypted is never joined plain again. False if it was already pinned. */
export function addRoomPin(settings: ColabSettings, origin: string, pinId: string): boolean {
  if (isRoomPinned(settings, origin, pinId)) return false;
  settings.liveE2EPins = [...(settings.liveE2EPins ?? []), `${origin}|${pinId}`];
  for (const listener of pinListeners) listener(origin, pinId);
  return true;
}

/**
 * Pin a note the server or its checkpoint shows as encrypted, before anything
 * starts a session on it. `origin` is the link's foreign origin, or '' for the
 * configured server. True if the pin is new and settings need saving.
 */
export async function pinIfEncrypted(
  settings: ColabSettings,
  origin: string,
  noteKey: string,
  roomId: string,
  note: { liveMode?: LiveMode; encryptedCrdt?: string | null },
): Promise<boolean> {
  const encrypted = note.liveMode === 'e2e'
    || (!!note.encryptedCrdt && !!(await decryptCrdt(note.encryptedCrdt, noteKey, roomId))?.encrypted);
  return encrypted && addRoomPin(settings, liveOrigin(settings, origin), await livePinId(noteKey));
}

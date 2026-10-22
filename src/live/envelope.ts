/**
 * Sealed live frames (docs/LIVE-E2E-ENCRYPTION.md §4.2). The header is plaintext routing
 * metadata; the kind, sender and room are authenticated through the AES-GCM AAD.
 *
 *   frame  = varUint 8 ‖ varUint kind ‖ varString route ‖ sender (16) ‖ sealed
 *   sealed = iv (12) ‖ AES-256-GCM(frameKey(sender), iv, aad, inner)
 *
 * `route` is the target connection ID going client→relay (empty = default routing) and the
 * origin connection ID going relay→client. It is outside the AAD and affects only routing.
 */
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { deriveFrameKey } from './keys.ts';

export const MESSAGE_SEALED = 8;
export const SENDER_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
/** 2^28 frames per sender keeps random IVs far below the NIST SP 800-38D limit. */
const MAX_CACHED_SENDERS = 1024;
export const SENDER_FRAME_LIMIT = 2 ** 28;

export const FrameKind = { step1: 1, step2: 2, update: 3, awareness: 4 } as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export interface Frame {
  kind: FrameKind;
  route: string;
  sender: Uint8Array<ArrayBuffer>;
  sealed: Uint8Array<ArrayBuffer>;
}

const encoder = new TextEncoder();

function assertKind(kind: number): asserts kind is FrameKind {
  if (!Object.values<number>(FrameKind).includes(kind)) throw new Error(`Unknown live frame kind ${kind}`);
}

export function encodeFrame({ kind, route, sender, sealed }: Frame): Uint8Array<ArrayBuffer> {
  assertKind(kind);
  if (sender.length !== SENDER_LENGTH) throw new Error('Live frame sender must be 16 bytes');
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, MESSAGE_SEALED);
  encoding.writeVarUint(out, kind);
  encoding.writeVarString(out, route);
  encoding.writeUint8Array(out, sender);
  encoding.writeUint8Array(out, sealed);
  return new Uint8Array(encoding.toUint8Array(out));
}

/** Throws on a wrong message type, an unknown kind, or a frame too short to hold a sealed payload. */
export function decodeFrame(data: Uint8Array): Frame {
  const input = decoding.createDecoder(data);
  if (decoding.readVarUint(input) !== MESSAGE_SEALED) throw new Error('Not a sealed live frame');
  const kind = decoding.readVarUint(input);
  assertKind(kind);
  const route = decoding.readVarString(input);
  if (input.arr.length - input.pos < SENDER_LENGTH + IV_LENGTH + TAG_LENGTH) throw new Error('Truncated live frame');
  const sender = new Uint8Array(decoding.readUint8Array(input, SENDER_LENGTH));
  return { kind, route, sender, sealed: new Uint8Array(decoding.readTailAsUint8Array(input)) };
}

function frameAad(roomId: string, kind: FrameKind, sender: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode(`notecolab-live:v2:${roomId}`);
  const aad = new Uint8Array(prefix.length + 2 + sender.length);
  aad.set(prefix);
  aad[prefix.length] = 0;
  aad[prefix.length + 1] = kind;
  aad.set(sender, prefix.length + 2);
  return aad;
}

/** Seals and opens the frames of one room, caching each sender's derived frame key. */
export class LiveCipher {
  private readonly frameKeys = new Map<string, Promise<CryptoKey>>();
  private readonly liveKey: CryptoKey;
  private readonly roomId: string;

  constructor(liveKey: CryptoKey, roomId: string) {
    this.liveKey = liveKey;
    this.roomId = roomId;
  }

  private frameKey(sender: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    const id = Array.from(sender, byte => byte.toString(16).padStart(2, '0')).join('');
    let key = this.frameKeys.get(id);
    if (!key) {
      // A relay can invent senders; bound what it can make us remember.
      if (this.frameKeys.size >= MAX_CACHED_SENDERS) this.frameKeys.clear();
      key = deriveFrameKey(this.liveKey, sender);
      this.frameKeys.set(id, key);
    }
    return key;
  }

  /** `iv` is injectable for known-answer tests only; production always uses a random one. */
  async seal(
    kind: FrameKind,
    sender: Uint8Array<ArrayBuffer>,
    inner: Uint8Array<ArrayBuffer>,
    iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  ): Promise<Uint8Array<ArrayBuffer>> {
    assertKind(kind);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: frameAad(this.roomId, kind, sender) },
      await this.frameKey(sender),
      inner
    );
    const sealed = new Uint8Array(IV_LENGTH + encrypted.byteLength);
    sealed.set(iv);
    sealed.set(new Uint8Array(encrypted), IV_LENGTH);
    return sealed;
  }

  /** Rejects (callers drop the frame) unless kind, sender and room all match what was sealed. */
  async open({ kind, sender, sealed }: Pick<Frame, 'kind' | 'sender' | 'sealed'>): Promise<Uint8Array<ArrayBuffer>> {
    assertKind(kind);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.subarray(0, IV_LENGTH), additionalData: frameAad(this.roomId, kind, sender) },
      await this.frameKey(sender),
      sealed.subarray(IV_LENGTH)
    );
    return new Uint8Array(decrypted);
  }
}

/** One per connection: a random sender salt, replaced after `limit` sealed frames. */
export class SenderSource {
  private sender = randomSender();
  private count = 0;
  private readonly limit: number;

  constructor(limit = SENDER_FRAME_LIMIT) {
    this.limit = limit;
  }

  /** The sender to seal the next frame with. */
  next(): Uint8Array<ArrayBuffer> {
    if (this.count >= this.limit) {
      this.sender = randomSender();
      this.count = 0;
    }
    this.count++;
    return this.sender;
  }
}

function randomSender(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SENDER_LENGTH));
}

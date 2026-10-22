/**
 * What sessions, presence and live cursors use from a live provider. y-websocket's
 * WebsocketProvider (plain rooms) and LiveE2EProvider (encrypted rooms) both satisfy it.
 */
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type * as encoding from 'lib0/encoding';
import type * as decoding from 'lib0/decoding';

export type LiveStatus = 'connecting' | 'connected' | 'disconnected';

/** Handles another frame type by number, e.g. the presence roster (type 4). */
export type LiveMessageHandler = (
  encoder: encoding.Encoder,
  decoder: decoding.Decoder,
  provider: never,
  emitSynced: boolean,
  messageType: number
) => void;

export interface LiveProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  ws: WebSocket | null;
  wsconnected: boolean;
  wsconnecting: boolean;
  readonly synced: boolean;
  messageHandlers: LiveMessageHandler[];
  on(name: 'status', listener: (event: { status: LiveStatus }) => void): unknown;
  on(name: 'sync', listener: (synced: boolean) => void): unknown;
  on(name: 'connection-close', listener: (event: CloseEvent | null) => void): unknown;
  off(name: 'status', listener: (event: { status: LiveStatus }) => void): void;
  off(name: 'sync', listener: (synced: boolean) => void): void;
  off(name: 'connection-close', listener: (event: CloseEvent | null) => void): void;
  connect(): void;
  disconnect(): void;
  destroy(): void;
}

import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { WebsocketProvider } from 'y-websocket';

export interface PresenceRoster {
  participants: { id: string; name: string; client: 'web' | 'obsidian' }[];
  selfId: string;
}

export function presenceLabel(roster: PresenceRoster | null): string {
  if (!roster) return 'Connecting…';
  const self = roster.participants.some(person => person.id === roster.selfId);
  const others = roster.participants.length - Number(self);
  if (!self) return others ? `${others} ${others === 1 ? 'person' : 'people'} here` : 'No one here';
  return others ? `You + ${others} ${others === 1 ? 'other' : 'others'}` : 'Only you here';
}

export function isForeground(document: Pick<Document, 'visibilityState' | 'hasFocus'>): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Presence uses only the server connection, never the provider's cross-tab broadcast. */
export class NotePresence {
  roster: PresenceRoster | null = null;
  private active = false;
  private connected = false;
  private lastReceived = 0;
  private expireConnection: () => void = () => {};

  get label() {
    return this.roster ? presenceLabel(this.roster) : this.connected ? 'Presence unavailable' : 'Reconnecting…';
  }
  private heartbeat: ReturnType<typeof setInterval>;
  private cleanup: () => void = () => {};
  private send: (message: Uint8Array) => void = () => {};

  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
    this.heartbeat = setInterval(() => {
      if (this.roster && Date.now() - this.lastReceived > 60_000) {
        this.roster = null;
        this.expireConnection();
        this.changed();
      }
      this.publish();
    }, 20_000);
  }

  private receive(decoder: decoding.Decoder) {
    try {
      const value: unknown = JSON.parse(decoding.readVarString(decoder));
      if (!value || typeof value !== 'object' || !('participants' in value) || !('selfId' in value)
        || typeof value.selfId !== 'string' || !Array.isArray(value.participants)) return;
      const participants: PresenceRoster['participants'] = [];
      for (const person of value.participants) {
        if (!person || typeof person !== 'object' || typeof person.id !== 'string'
          || typeof person.name !== 'string' || !['web', 'obsidian'].includes(person.client)) return;
        participants.push({ id: person.id, name: person.name, client: person.client });
      }
      this.lastReceived = Date.now();
      this.roster = { selfId: value.selfId, participants };
      this.changed();
    } catch { /* Ignore unsupported or malformed presence messages. */ }
  }

  attach(provider: WebsocketProvider) {
    const previous = provider.messageHandlers[4] ?? (() => {});
    this.connected = provider.wsconnected;
    provider.messageHandlers[4] = (_encoder, decoder, _provider, fromSocket) => {
      if (fromSocket && provider.wsconnected) this.receive(decoder);
    };
    this.send = message => {
      if (provider.ws?.readyState === 1) provider.ws.send(message);
    };
    const status = ({ status }: { status: string }) => {
      this.roster = null;
      this.connected = status === 'connected';
      if (status === 'connected') this.publish();
      this.changed();
    };
    provider.on('status', status);
    this.cleanup = () => {
      provider.off('status', status);
      provider.messageHandlers[4] = previous;
    };
    this.publish();
  }

  /** Read-only notes need no Y.Doc and never send or apply content updates. */
  connect(url: string) {
    let stopped = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        this.connected = true;
        this.publish();
        this.changed();
      };
      socket.onmessage = event => {
        if (!(event.data instanceof ArrayBuffer)) return;
        try {
          const decoder = decoding.createDecoder(new Uint8Array(event.data));
          if (decoding.readVarUint(decoder) === 4) this.receive(decoder);
        } catch { /* Ignore malformed frames. */ }
      };
      socket.onclose = event => {
        this.connected = false;
        this.roster = null;
        this.changed();
        if (!stopped && event.code !== 1008) retry = setTimeout(connect, 5000);
      };
    };
    this.send = message => { if (socket?.readyState === 1) socket.send(message); };
    this.expireConnection = () => socket.close();
    this.cleanup = () => {
      stopped = true;
      clearTimeout(retry);
      socket.onclose = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close();
    };
    connect();
  }

  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    this.publish();
  }

  private publish() {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 4);
    encoding.writeVarString(encoder, JSON.stringify({ active: this.active, client: 'obsidian' }));
    this.send(encoding.toUint8Array(encoder));
  }

  destroy() {
    this.active = false;
    this.publish();
    clearInterval(this.heartbeat);
    this.cleanup();
    this.roster = null;
  }
}

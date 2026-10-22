/**
 * Encrypted live sync (docs/LIVE-E2E-ENCRYPTION.md §5). A drop-in for the part of
 * y-websocket's WebsocketProvider that the plugin and web client use; it keeps Yjs and
 * y-protocols encoding and replaces only the transport and routing.
 *
 * Receivers dispatch on the authenticated kind alone: kinds 2 and 3 only reach
 * `Y.applyUpdate`, kind 4 only reaches `applyAwarenessUpdate`, and kind 1 is only answered.
 */
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { ObservableV2 } from 'lib0/observable';
import { decodeFrame, encodeFrame, FrameKind, LiveCipher, MESSAGE_SEALED, SenderSource } from './envelope.ts';

const MESSAGE_CONTROL = 9;
const OPEN = 1;

export const LIVE_TIMING = {
  /** Give up waiting for listed writers to answer the join pull (§5.1 step 6). */
  syncTimeout: 5_000,
  /** Periodic kind 1 that repairs dropped frames (§5.2). */
  resyncInterval: 60_000,
  /** Checkpoint catch-up check (§5.2). */
  healthInterval: 30_000,
  minBackoff: 100,
  maxBackoff: 5_000,
};

export interface LiveCheckpoint {
  /** Decrypted Yjs update of the checkpoint. */
  update: Uint8Array;
  contentVersion: number;
}

/** Read side of the REST checkpoint; saving stays with the session. */
export interface CheckpointSource {
  /** The note's current contentVersion, e.g. from `/meta`. */
  getContentVersion(): Promise<number>;
  loadCheckpoint(): Promise<LiveCheckpoint | null>;
}

export interface LiveE2EProviderOptions {
  liveKey: CryptoKey;
  params?: Record<string, string>;
  connect?: boolean;
  awareness?: awarenessProtocol.Awareness;
  WebSocketPolyfill?: typeof WebSocket;
  checkpoint?: CheckpointSource;
  /** contentVersion of the checkpoint already restored into the doc (§5.1 step 1). */
  contentVersion?: number;
  timing?: Partial<typeof LIVE_TIMING>;
}

type Status = 'connecting' | 'connected' | 'disconnected';

type Events = {
  status: (event: { status: Status }) => void;
  sync: (synced: boolean) => void;
  synced: (synced: boolean) => void;
  'connection-close': (event: CloseEvent | null, provider: LiveE2EProvider) => void;
  /** This connection's own write access, from `welcome` or a `grant` (§5.4). */
  grant: (canWrite: boolean) => void;
};

/** Handlers for other frame types, e.g. the presence roster (type 4). */
type MessageHandler = (
  encoder: encoding.Encoder,
  decoder: decoding.Decoder,
  provider: LiveE2EProvider,
  emitSynced: boolean,
  messageType: number
) => void;

type Control =
  | { type: 'welcome'; self: string; canWrite: boolean; writers: string[] }
  | { type: 'joined'; id: string; canWrite: boolean }
  | { type: 'left'; id: string }
  | { type: 'grant'; id: string; canWrite: boolean };

type AwarenessEntry = { clientID: number; clock: number; state: string };

export class LiveE2EProvider extends ObservableV2<Events> {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly serverUrl: string;
  readonly roomname: string;
  params: Record<string, string>;
  messageHandlers: MessageHandler[] = [];
  ws: WebSocket | null = null;
  wsconnected = false;
  wsconnecting = false;
  shouldConnect = false;
  /** This socket's relay connection ID; empty until `welcome`. */
  self = '';
  canWrite = false;
  /** The other writers in the room, by connection ID. */
  writers = new Set<string>();
  /** Newest checkpoint merged into the doc. The session raises it after its own saves. */
  contentVersion: number;

  private readonly cipher: LiveCipher;
  private readonly WS: typeof WebSocket;
  private readonly checkpoint: CheckpointSource | undefined;
  private readonly timing: typeof LIVE_TIMING;
  private sender = new SenderSource();
  /** Writers listed in `welcome` that have not answered the join pull yet. */
  private unanswered = new Set<string>();
  /** Each remote awareness client ID belongs to the first connection that announced it. */
  private readonly awarenessOwners = new Map<number, string>();
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();
  private catchingUp: Promise<void> | null = null;
  private reconnects = 0;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly resyncTimer: ReturnType<typeof setInterval>;
  private readonly healthTimer: ReturnType<typeof setInterval>;
  private _synced = false;

  constructor(serverUrl: string, roomname: string, doc: Y.Doc, options: LiveE2EProviderOptions) {
    super();
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.roomname = roomname;
    this.doc = doc;
    this.awareness = options.awareness ?? new awarenessProtocol.Awareness(doc);
    this.params = options.params ?? {};
    this.cipher = new LiveCipher(options.liveKey, roomname);
    this.WS = options.WebSocketPolyfill ?? WebSocket;
    this.checkpoint = options.checkpoint;
    this.contentVersion = options.contentVersion ?? 0;
    this.timing = { ...LIVE_TIMING, ...options.timing };
    doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    this.resyncTimer = setInterval(() => this.resync(), this.timing.resyncInterval);
    this.healthTimer = setInterval(() => { if (this.shouldConnect) void this.catchUp(); }, this.timing.healthInterval);
    if (options.connect ?? true) this.connect();
  }

  get url(): string {
    return `${this.serverUrl}/${this.roomname}?${new URLSearchParams({ ...this.params, proto: '2' })}`;
  }

  get synced(): boolean {
    return this._synced;
  }

  set synced(state: boolean) {
    if (this._synced === state) return;
    this._synced = state;
    this.emit('synced', [state]);
    this.emit('sync', [state]);
  }

  connect() {
    this.shouldConnect = true;
    if (!this.ws && !this.wsconnecting) void this.open();
  }

  disconnect() {
    this.shouldConnect = false;
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    if (ws) {
      ws.close();
      this.closed(ws, null);
    }
  }

  override destroy() {
    clearInterval(this.resyncTimer);
    clearInterval(this.healthTimer);
    this.disconnect();
    this.awareness.off('update', this.onAwarenessUpdate);
    this.doc.off('update', this.onDocUpdate);
    super.destroy();
  }

  /** Pull from every writer to repair dropped frames; also call it when the app regains focus. */
  resync() {
    if (this.self && this.writers.size > 0) this.send(FrameKind.step1, '', Y.encodeStateVector(this.doc));
  }

  /** Merge the REST checkpoint when its contentVersion is newer than the last one merged. */
  catchUp(): Promise<void> {
    const source = this.checkpoint;
    if (!source) return Promise.resolve();
    this.catchingUp ??= (async () => {
      if ((await source.getContentVersion()) <= this.contentVersion) return;
      const checkpoint = await source.loadCheckpoint();
      if (!checkpoint || checkpoint.contentVersion <= this.contentVersion) return;
      Y.applyUpdate(this.doc, checkpoint.update, this);
      this.contentVersion = checkpoint.contentVersion;
    })().catch(() => {}).finally(() => { this.catchingUp = null; });
    return this.catchingUp;
  }

  // §5.3: catch up from the checkpoint first, then join with a fresh sender.
  private async open() {
    this.wsconnecting = true;
    this.emit('status', [{ status: 'connecting' }]);
    await this.catchUp();
    if (!this.shouldConnect || this.ws) {
      this.wsconnecting = false;
      return;
    }
    const ws = new this.WS(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.sender = new SenderSource();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnects = 0;
      this.wsconnecting = false;
      this.wsconnected = true;
      this.emit('status', [{ status: 'connected' }]);
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      const data = new Uint8Array(event.data as ArrayBuffer);
      this.inbound = this.inbound.then(() => this.receive(ws, data)).catch(() => {});
    };
    ws.onclose = event => this.closed(ws, event);
  }

  private closed(ws: WebSocket, event: CloseEvent | null) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.emit('connection-close', [event, this]);
    const wasConnected = this.wsconnected;
    this.wsconnected = false;
    this.wsconnecting = false;
    this.self = '';
    this.canWrite = false;
    this.writers = new Set();
    this.unanswered = new Set();
    clearTimeout(this.syncTimer);
    const remote = [...this.awareness.getStates().keys()].filter(id => id !== this.awareness.clientID);
    awarenessProtocol.removeAwarenessStates(this.awareness, remote, this);
    this.awarenessOwners.clear();
    this.synced = false;
    if (wasConnected) this.emit('status', [{ status: 'disconnected' }]);
    if (!this.shouldConnect) return;
    const base = Math.min(this.timing.maxBackoff, this.timing.minBackoff * 2 ** this.reconnects++);
    this.reconnectTimer = setTimeout(() => this.connect(), Math.min(this.timing.maxBackoff, base * (1 + Math.random())));
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Remote and checkpoint updates are applied with this provider as origin and never echo.
    if (origin !== this) this.send(FrameKind.update, '', update);
  };

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }
  ) => {
    // Only our own entry is ever announced from this connection.
    const own = this.awareness.clientID;
    if (added.includes(own) || updated.includes(own) || removed.includes(own)) {
      this.send(FrameKind.awareness, '', awarenessProtocol.encodeAwarenessUpdate(this.awareness, [own]));
    }
  };

  // Seals in order on the current socket; read-only connections never send kinds 2 or 3.
  private send(kind: FrameKind, to: string, inner: Uint8Array) {
    const ws = this.ws;
    if (!ws || !this.self) return;
    const writes = kind === FrameKind.step2 || kind === FrameKind.update;
    if (writes && !this.canWrite) return;
    const sender = this.sender.next();
    const bytes = new Uint8Array(inner);
    this.outbound = this.outbound.then(async () => {
      const sealed = await this.cipher.seal(kind, sender, bytes);
      // A grant downgrade stops writes still waiting in the queue.
      if (this.ws !== ws || ws.readyState !== OPEN || (writes && !this.canWrite)) return;
      ws.send(encodeFrame({ kind, route: to, sender, sealed }));
    }).catch(() => {});
  }

  private async receive(ws: WebSocket, data: Uint8Array) {
    if (this.ws !== ws) return;
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SEALED) {
      await this.receiveSealed(ws, data);
    } else if (type === MESSAGE_CONTROL) {
      this.control(JSON.parse(decoding.readVarString(decoder)) as Control);
    } else {
      this.messageHandlers[type]?.(encoding.createEncoder(), decoder, this, true, type);
    }
  }

  // Fails closed: a frame that doesn't decode or authenticate is dropped, and its sender isn't muted.
  private async receiveSealed(ws: WebSocket, data: Uint8Array) {
    let frame, inner;
    try {
      frame = decodeFrame(data);
      inner = await this.cipher.open(frame);
    } catch {
      return;
    }
    if (this.ws !== ws) return;
    const from = frame.route;
    switch (frame.kind) {
      case FrameKind.step1: {
        if (!this.canWrite) return;
        let reply;
        try {
          reply = Y.encodeStateAsUpdate(this.doc, inner);
        } catch {
          return;
        }
        this.send(FrameKind.step2, from, reply);
        return;
      }
      case FrameKind.step2:
      case FrameKind.update:
        try {
          Y.applyUpdate(this.doc, inner, this);
        } catch {
          return;
        }
        if (frame.kind === FrameKind.step2) this.answered(from);
        return;
      case FrameKind.awareness:
        this.applyAwareness(from, inner);
    }
  }

  private control(message: Control) {
    switch (message.type) {
      case 'welcome': {
        this.self = message.self;
        this.canWrite = message.canWrite === true;
        const writers = Array.isArray(message.writers) ? message.writers : [];
        this.writers = new Set(writers);
        this.unanswered = new Set(writers);
        this.emit('grant', [this.canWrite]);
        // Push, then pull (§5.1 steps 4 and 5).
        if (this.canWrite) this.send(FrameKind.update, '', Y.encodeStateAsUpdate(this.doc));
        this.resync();
        if (this.awareness.getLocalState() !== null) {
          this.send(FrameKind.awareness, '', awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]));
        }
        if (this.unanswered.size === 0) {
          this.synced = true;
        } else {
          this.syncTimer = setTimeout(() => { if (this.self) this.synced = true; }, this.timing.syncTimeout);
        }
        return;
      }
      case 'joined':
        if (message.canWrite) this.writers.add(message.id);
        return;
      case 'left':
        this.writers.delete(message.id);
        this.answered(message.id);
        this.forgetAwareness(message.id);
        return;
      case 'grant':
        if (message.id === this.self) {
          const couldWrite = this.canWrite;
          this.canWrite = message.canWrite === true;
          if (this.canWrite && !couldWrite) this.send(FrameKind.update, '', Y.encodeStateAsUpdate(this.doc));
          if (this.canWrite !== couldWrite) this.emit('grant', [this.canWrite]);
        } else if (message.canWrite) {
          this.writers.add(message.id);
        } else {
          this.writers.delete(message.id);
          this.answered(message.id);
        }
    }
  }

  private answered(id: string) {
    if (!this.unanswered.delete(id) || this.unanswered.size > 0 || !this.self) return;
    clearTimeout(this.syncTimer);
    this.synced = true;
  }

  private applyAwareness(from: string, update: Uint8Array) {
    const entries: AwarenessEntry[] = [];
    try {
      const decoder = decoding.createDecoder(update);
      for (let count = decoding.readVarUint(decoder); count > 0; count--) {
        const entry = { clientID: decoding.readVarUint(decoder), clock: decoding.readVarUint(decoder), state: decoding.readVarString(decoder) };
        JSON.parse(entry.state);
        entries.push(entry);
      }
    } catch {
      return;
    }
    const kept = entries.filter(({ clientID }) => {
      if (clientID === this.awareness.clientID) return false;
      const owner = this.awarenessOwners.get(clientID);
      if (owner === undefined) this.awarenessOwners.set(clientID, from);
      return owner === undefined || owner === from;
    });
    if (kept.length === 0) return;
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, kept.length);
    for (const { clientID, clock, state } of kept) {
      encoding.writeVarUint(out, clientID);
      encoding.writeVarUint(out, clock);
      encoding.writeVarString(out, state);
    }
    awarenessProtocol.applyAwarenessUpdate(this.awareness, encoding.toUint8Array(out), this);
  }

  private forgetAwareness(connection: string) {
    const ids = [...this.awarenessOwners].filter(([, owner]) => owner === connection).map(([id]) => id);
    for (const id of ids) this.awarenessOwners.delete(id);
    awarenessProtocol.removeAwarenessStates(this.awareness, ids, this);
  }
}

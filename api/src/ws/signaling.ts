import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

// Simple WebRTC signaling server
// Relays SDP offers/answers and ICE candidates between peers in the same room

interface SignalPeer {
  ws: WebSocket;
  room: string;
  peerId: string;
}

const signalRooms = new Map<string, Set<SignalPeer>>();
const MAX_SIGNAL_CONNECTIONS = parseInt(process.env.MAX_SIGNAL_CONNECTIONS || '200', 10);
let totalSignalConnections = 0;

export function setupSignalingWebSocket(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathParts = url.pathname.split('/');
    // Expected: /ws/signal/:roomId
    const roomId = pathParts[pathParts.length - 1];

    if (!roomId) {
      ws.close(1008, 'Missing room ID');
      return;
    }

    if (totalSignalConnections >= MAX_SIGNAL_CONNECTIONS) {
      ws.close(1013, 'Server at capacity — please try again later');
      return;
    }
    totalSignalConnections++;

    const peerId = Math.random().toString(36).slice(2, 10);

    const peer: SignalPeer = { ws, room: roomId, peerId };

    if (!signalRooms.has(roomId)) {
      signalRooms.set(roomId, new Set());
    }
    const room = signalRooms.get(roomId)!;
    room.add(peer);

    // Notify existing peers about the new peer
    for (const p of room) {
      if (p !== peer && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({ type: 'peer-joined', peerId }));
      }
    }

    // Send existing peer list to new peer
    const existingPeers = Array.from(room)
      .filter(p => p !== peer)
      .map(p => p.peerId);
    ws.send(JSON.stringify({ type: 'peers', peers: existingPeers, you: peerId }));

    ws.on('message', (data: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Relay signaling messages (offer/answer/candidate) to the target peer
      if (msg.type === 'signal' && msg.targetPeerId) {
        for (const p of room) {
          if (p.peerId === msg.targetPeerId && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({
              type: 'signal',
              fromPeerId: peerId,
              signal: msg.signal,
            }));
            break;
          }
        }
      }
    });

    ws.on('close', () => {
      totalSignalConnections = Math.max(0, totalSignalConnections - 1);
      room.delete(peer);
      // Notify remaining peers
      for (const p of room) {
        if (p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify({ type: 'peer-left', peerId }));
        }
      }
      if (room.size === 0) {
        signalRooms.delete(roomId);
      }
    });

    ws.on('error', () => {
      ws.close();
    });
  });
}

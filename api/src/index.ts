import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

import auth from './routes/auth.js';
import notes from './routes/notes.js';
import sessions from './routes/sessions.js';
import admin from './routes/admin.js';
import billing from './routes/billing.js';
import { setupYjsWebSocket, getTotalConnections, getRoomCount } from './ws/yjs-relay.js';
import { setupSignalingWebSocket } from './ws/signaling.js';
import { startCleanupCron } from './cron/cleanup.js';
import { getDb, closeDb, isDatabaseReady } from './db/schema.js';
import { publicPlanInfo } from './plans.js';
import { publicAccessInfo, wsRequireAuth } from './access.js';
import { lookupAuthUser } from './routes/middleware.js';

const app = new Hono();

// Public server identity, shown on /api/v1/info so the plugin can adapt.
const SERVER_NAME = process.env.SERVER_NAME || 'NoteColab';

// CORS — allow the Obsidian plugin and the web frontend. Self-hosters set
// CORS_ORIGINS (comma-separated) to their own web origin(s); the Obsidian
// origin is always included so the plugin keeps working.
const corsOrigins = [
  ...(process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : ['https://notecolab.com', 'https://notecolab.felixmrak.com']),
  'app://obsidian.md',
];
app.use('*', cors({
  origin: corsOrigins,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-NoteColab-Write-Token'],
  maxAge: 86400,
}));

// Baseline response hardening. These are cheap static headers and do not alter
// the API contract or add work to request hot paths.
app.use('*', async (c, next) => {
  await next();
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});

// Global request-body cap. The largest legitimate payload is a 50 MB encrypted
// image, base64-wrapped in JSON (~1.37x) → ~70 MB. This rejects oversized bodies
// before they are buffered/decoded, so a huge upload can't exhaust memory before
// the per-route size checks run.
const MAX_BODY_BYTES = 80 * 1024 * 1024;
app.use('*', bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json({ error: 'Request body too large' }, 413),
}));

// Health check
app.get('/api/v1/ping', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

// Readiness includes a side-effect-free SQLite query so an unreadable or
// unavailable database keeps the container out of service.
app.get('/api/v1/ready', (c) => {
  try {
    if (isDatabaseReady()) {
      return c.json({ status: 'ok' });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown SQLite error';
    console.error(`Database readiness check failed: ${message}`);
  }
  return c.json({ status: 'unavailable' }, 503);
});

// Capability discovery — lets the plugin learn this server's name, protocol
// version, and plan/billing setup without hardcoding anything. See
// docs/PROTOCOL.md.
app.get('/api/v1/info', (c) => c.json({
  name: SERVER_NAME,
  protocolVersion: 1,
  ...publicPlanInfo(getDb()),
  ...publicAccessInfo(),
}));

// Status endpoint (connection stats)
app.get('/api/v1/status', (c) => c.json({
  wsConnections: getTotalConnections(),
  activeRooms: getRoomCount(),
  time: new Date().toISOString(),
}));

// Routes
app.route('/api/v1/auth', auth);
app.route('/api/v1/notes', notes);
app.route('/api/v1/sessions', sessions);
app.route('/api/v1/admin', admin);
app.route('/api/v1/billing', billing);

// Initialize DB eagerly
getDb();

// Create HTTP server from Hono
const port = parseInt(process.env.PORT || '8787', 10);
const server = createServer(async (req, res) => {
  const response = await app.fetch(
    new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : req as any,
      // @ts-ignore
      duplex: 'half',
    })
  );

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    };
    pump().catch(() => res.end());
  } else {
    res.end();
  }
});

// WebSocket servers
const yjsWss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
const signalingWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

setupYjsWebSocket(yjsWss);
setupSignalingWebSocket(signalingWss);

// Optional private-server gate: require a valid per-user bearer key on the WS
// upgrade itself. This closes both the Yjs relay and the (otherwise
// unauthenticated) WebRTC signaling door at once — a closed instance means no
// stranger holds a key. Browsers can't set headers on a WS handshake, so the
// key is read from the `token` query param (what both Yjs clients already send)
// with an Authorization header as a fallback for non-browser callers.
function wsUpgradeAuthorized(req: IncomingMessage): boolean {
  if (!wsRequireAuth()) return true;
  let token: string | null = null;
  try {
    token = new URL(req.url || '/', `http://${req.headers.host}`).searchParams.get('token');
  } catch { /* malformed URL → no token */ }
  if (!token) {
    const auth = req.headers['authorization'];
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  }
  return !!token && lookupAuthUser(token).ok;
}

server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const pathname = req.url || '';

  if (!wsUpgradeAuthorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  if (pathname.startsWith('/ws/yjs/')) {
    yjsWss.handleUpgrade(req, socket, head, (ws) => {
      yjsWss.emit('connection', ws, req);
    });
  } else if (pathname.startsWith('/ws/signal/')) {
    signalingWss.handleUpgrade(req, socket, head, (ws) => {
      signalingWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Start cleanup cron
startCleanupCron();

server.listen(port, () => {
  console.log(`notecolab API running on port ${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close();
  closeDb();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  server.close();
  closeDb();
  process.exit(0);
});

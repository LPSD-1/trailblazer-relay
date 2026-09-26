#!/usr/bin/env node
// Trail Blazer relay, protocol v1 - single-file Node version.
// The full contract is in PROTOCOL.md at the top of this repository.
//
//   RELAY_TOKEN=<22-char token> PORT=8080 node relay.js
//
// It forwards opaque encrypted frames between the phones in a room. It never
// writes a frame anywhere, never logs one, and never tries to read one.
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

// ---- Protocol v1 limits (PROTOCOL.md section 5) ----
const MAX_FRAME = 256;         // bytes per binary frame
const CATCH_UP = 64;           // frames kept per room, in memory only
const BURST = 10;              // rate limit: bucket size...
const REFILL_PER_S = 1;        // ...and refill, per socket
const MAX_SOCKETS = 24;        // per room, authenticated or not
const AUTH_MS = 5000;          // time allowed for the auth message

// ---- Close codes (PROTOCOL.md section 6) ----
const CLOSE_BAD_TOKEN = 4001;
const CLOSE_AUTH_TIMEOUT = 4002;
const CLOSE_PROTOCOL = 4003;
const CLOSE_TOO_LARGE = 4004;
const CLOSE_ROOM_FULL = 4005;

// ---- Configuration: refuse to start rather than run half-configured ----
const TOKEN = process.env.RELAY_TOKEN || '';
const PORT = Number(process.env.PORT || 8080);
if (!isToken(TOKEN)) {
  console.error('RELAY_TOKEN must be set to 16 random bytes in base64url (22 characters).');
  console.error("Make one with: node -e \"console.log(require('crypto').randomBytes(16).toString('base64url'))\"");
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('PORT must be a number from 1 to 65535.');
  process.exit(1);
}
const TOKEN_BYTES = Buffer.from(TOKEN, 'utf8');

// True when s is exactly 16 bytes written as canonical base64url, no padding.
function isToken(s) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(s)) return false;
  return Buffer.from(s, 'base64url').toString('base64url') === s;
}

function tokenMatches(presented) {
  const b = Buffer.from(presented, 'utf8');
  return b.length === TOKEN_BYTES.length && crypto.timingSafeEqual(b, TOKEN_BYTES);
}

// roomId -> { sockets: Set<WebSocket>, frames: Buffer[] }
// This map is the only place frames ever exist, and only while someone is in the room.
const rooms = new Map();

const server = http.createServer((req, res) => {
  // A plain page so a person can open the address in a browser and see it is up.
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Trail Blazer relay, protocol v1. This address is for the app, not a browser.\n');
    return;
  }
  res.writeHead(req.url.startsWith('/v1/room/') ? 426 : 404, { 'content-type': 'text/plain' });
  res.end(req.url.startsWith('/v1/room/') ? 'WebSocket upgrade required\n' : 'Not found\n');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const m = /^\/v1\/room\/([A-Za-z0-9_-]{22})$/.exec(req.url || '');
  if (!m || !isToken(m[1])) { // a roomId has the same shape as a token: 16 bytes, base64url
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => join(ws, m[1]));
});

function join(ws, roomId) {
  const s = { authed: false, tokens: BURST, at: Date.now(), alive: true };
  ws.tb = s; // per-socket state: auth, rate-limit bucket, liveness
  let room = rooms.get(roomId);
  if (!room) { room = { sockets: new Set(), frames: [] }; rooms.set(roomId, room); }
  if (room.sockets.size >= MAX_SOCKETS) {
    ws.close(CLOSE_ROOM_FULL, 'room full');
    return;
  }
  room.sockets.add(ws);

  ws.on('pong', () => { s.alive = true; });
  const authTimer = setTimeout(() => {
    if (!s.authed) ws.close(CLOSE_AUTH_TIMEOUT, 'auth timeout');
  }, AUTH_MS);

  ws.on('message', (data, isBinary) => {
    // Once the relay has closed a socket, ignore anything still in flight on
    // it: otherwise "garbage, then auth <token>, then a frame" sent back to
    // back would authenticate and forward after the 4003 close.
    if (ws.readyState !== ws.OPEN) return;
    if (!s.authed) {
      // The first message must be the text frame "auth <token>".
      const text = isBinary ? null : data.toString('utf8');
      if (text === null || !text.startsWith('auth ') || data.length > MAX_FRAME) {
        ws.close(CLOSE_PROTOCOL, 'expected auth');
        return;
      }
      if (!tokenMatches(text.slice(5))) { ws.close(CLOSE_BAD_TOKEN, 'token refused'); return; }
      s.authed = true;
      clearTimeout(authTimer);
      ws.send('ok 1');
      for (const f of room.frames) ws.send(f, { binary: true }); // catch-up, oldest first
      return;
    }
    if (!isBinary) { ws.close(CLOSE_PROTOCOL, 'text after auth'); return; }
    if (data.length > MAX_FRAME) { ws.close(CLOSE_TOO_LARGE, 'frame too large'); return; }

    // Token bucket: over-limit frames are dropped, not forwarded and not kept.
    const now = Date.now();
    s.tokens = Math.min(BURST, s.tokens + ((now - s.at) / 1000) * REFILL_PER_S);
    s.at = now;
    if (s.tokens < 1) return;
    s.tokens -= 1;

    room.frames.push(data);
    if (room.frames.length > CATCH_UP) room.frames.shift();
    for (const other of room.sockets) {
      if (other !== ws && other.tb.authed && other.readyState === other.OPEN) {
        other.send(data, { binary: true });
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    room.sockets.delete(ws);
    // Forget the room, and every frame in it, once nobody authenticated is left.
    const anyAuthed = [...room.sockets].some((o) => o.tb.authed);
    if (!anyAuthed) room.frames = [];
    if (room.sockets.size === 0) rooms.delete(roomId);
  });
  ws.on('error', () => { /* the close handler tidies up */ });
}

// Drop connections whose phone vanished without closing (tunnel, battery).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.tb.alive) { ws.terminate(); continue; }
    ws.tb.alive = false;
    ws.ping();
  }
}, 30000);

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'relay shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  // The only log line. Room ids, addresses and frames are never logged.
  console.log(`Trail Blazer relay (protocol v1) listening on port ${PORT}`);
});

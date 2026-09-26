// Trail Blazer relay, protocol v1 - Cloudflare Worker + Durable Object.
// The full contract is in PROTOCOL.md at the top of the repository.
//
// One Durable Object per room. It uses the WebSocket Hibernation API, so a
// quiet room stops using the free plan's duration allowance between frames.
// It never touches Durable Object storage (ctx.storage is not used anywhere),
// never logs, and never tries to read a frame.
import { DurableObject } from 'cloudflare:workers';

// ---- Protocol v1 limits (PROTOCOL.md section 5) ----
const MAX_FRAME = 256;
const CATCH_UP = 64;
const BURST = 10;
const REFILL_PER_S = 1;
const MAX_SOCKETS = 24;
const AUTH_MS = 5000;

// ---- Close codes (PROTOCOL.md section 6) ----
const CLOSE_BAD_TOKEN = 4001;
const CLOSE_AUTH_TIMEOUT = 4002;
const CLOSE_PROTOCOL = 4003;
const CLOSE_TOO_LARGE = 4004;
const CLOSE_ROOM_FULL = 4005;

const OPEN = 1; // WebSocket.OPEN

// True when s is exactly 16 bytes written as canonical base64url, no padding.
// Room ids and the access token share this shape.
function isId(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(s)) return false;
  // The last character carries 2 spare bits, which canonical encoding sets to 0.
  return 'AQgw'.includes(s[21]);
}

function tokenMatches(presented, expected) {
  const enc = new TextEncoder();
  const a = enc.encode(presented);
  const b = enc.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!isId(env.RELAY_TOKEN)) {
      // Fail loudly: a relay with no usable token must not look healthy.
      return new Response(
        'RELAY_TOKEN is not set, or is not 16 bytes in base64url (22 characters). See the README.\n',
        { status: 500 },
      );
    }
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('Trail Blazer relay, protocol v1. This address is for the app, not a browser.\n');
    }
    const m = /^\/v1\/room\/([^/]+)$/.exec(url.pathname);
    if (!m || !isId(m[1])) return new Response('Not found\n', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required\n', { status: 426 });
    }
    // Same roomId -> same Durable Object, wherever the riders connect from.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // The catch-up buffer lives in memory only. If the object hibernated
    // (nothing happened for about 10 s), memory was wiped; rebuild what we can
    // from each open socket's own attachment, which holds that socket's last
    // accepted frame. The attachment lives with the connection in the runtime
    // and ends with it; it is not Durable Object storage.
    this.frames = [];
    this.seq = 0;
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.last) this.frames.push(a.last);
    }
    this.frames.sort((x, y) => x.i - y.i);
    this.frames = this.frames.slice(-CATCH_UP);
    if (this.frames.length) this.seq = this.frames[this.frames.length - 1].i + 1;
  }

  async fetch() {
    const open = this.ctx.getWebSockets().filter((w) => w.readyState === OPEN);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    if (open.length >= MAX_SOCKETS) {
      server.close(CLOSE_ROOM_FULL, 'room full');
    } else {
      server.serializeAttachment({ authed: false, opened: Date.now(), tokens: BURST, at: Date.now() });
      // A pending timer also keeps the object awake until auth is settled.
      setTimeout(() => {
        const a = server.deserializeAttachment();
        if (a && !a.authed && server.readyState === OPEN) server.close(CLOSE_AUTH_TIMEOUT, 'auth timeout');
      }, AUTH_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    // Once the relay has closed a socket, ignore anything still in flight on
    // it (a room-full socket, or one refused for a bad first message).
    if (ws.readyState !== OPEN) return;
    const a = ws.deserializeAttachment();
    if (!a) return;

    if (!a.authed) {
      if (Date.now() - a.opened > AUTH_MS) return ws.close(CLOSE_AUTH_TIMEOUT, 'auth timeout');
      // The first message must be the text frame "auth <token>".
      if (typeof msg !== 'string' || !msg.startsWith('auth ') || msg.length > MAX_FRAME) {
        return ws.close(CLOSE_PROTOCOL, 'expected auth');
      }
      if (!tokenMatches(msg.slice(5), this.env.RELAY_TOKEN)) {
        return ws.close(CLOSE_BAD_TOKEN, 'token refused');
      }
      a.authed = true;
      ws.serializeAttachment(a);
      ws.send('ok 1');
      for (const f of this.frames) ws.send(f.data); // catch-up, oldest first
      return;
    }

    if (typeof msg === 'string') return ws.close(CLOSE_PROTOCOL, 'text after auth');
    if (msg.byteLength > MAX_FRAME) return ws.close(CLOSE_TOO_LARGE, 'frame too large');

    // Token bucket: over-limit frames are dropped, not forwarded and not kept.
    const now = Date.now();
    a.tokens = Math.min(BURST, a.tokens + ((now - a.at) / 1000) * REFILL_PER_S);
    a.at = now;
    if (a.tokens < 1) {
      ws.serializeAttachment(a);
      return;
    }
    a.tokens -= 1;

    const f = { i: this.seq++, data: msg };
    this.frames.push(f);
    if (this.frames.length > CATCH_UP) this.frames.shift();
    a.last = f;
    ws.serializeAttachment(a);

    for (const other of this.ctx.getWebSockets()) {
      if (other === ws || other.readyState !== OPEN) continue;
      if (other.deserializeAttachment()?.authed) other.send(msg);
    }
  }

  async webSocketClose(ws) {
    // Answer the client's close so its close handshake completes. Newer
    // compatibility dates do this automatically (web_socket_auto_reply_to_close);
    // then the socket is already closed and this throws, which is fine.
    try {
      ws.close(1000, 'bye');
    } catch { /* already closed */ }
    this.forgetIfEmpty(ws);
  }

  async webSocketError(ws) {
    this.forgetIfEmpty(ws);
  }

  // Forget every frame once nobody authenticated is left in the room.
  forgetIfEmpty(leaving) {
    const anyone = this.ctx
      .getWebSockets()
      .some((w) => w !== leaving && w.readyState === OPEN && w.deserializeAttachment()?.authed);
    if (!anyone) {
      this.frames = [];
      this.seq = 0;
    }
  }
}

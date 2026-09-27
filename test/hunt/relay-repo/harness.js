// Shared harness for the relay-repo hunt tests: starts node/relay.js as its
// own process on a free port with a fresh token, the way a rider runs it.
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const WebSocket = require(require.resolve('ws', { paths: [root] }));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

const newId = () => crypto.randomBytes(16).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts a relay from `file` (node/relay.js by default). Resolves once it
// logs that it is listening. `relay.output` collects stdout and stderr.
async function startRelay({ file = path.join(root, 'node', 'relay.js'), env = {} } = {}) {
  const port = await freePort();
  const token = newId();
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, RELAY_TOKEN: token, PORT: String(port), NODE_PATH: path.join(root, 'node_modules'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const relay = { child, port, token, output: '', exited: null, base: `ws://127.0.0.1:${port}` };
  child.stdout.on('data', (d) => { relay.output += d; });
  child.stderr.on('data', (d) => { relay.output += d; });
  relay.exitedP = new Promise((r) => child.on('exit', (code, sig) => { relay.exited = { code, sig }; r(relay.exited); }));
  const t0 = Date.now();
  while (!/listening on port/.test(relay.output)) {
    if (relay.exited) throw new Error(`relay exited before listening: ${relay.output}`);
    if (Date.now() - t0 > 10000) throw new Error(`relay did not start: ${relay.output}`);
    await sleep(20);
  }
  relay.stop = () => new Promise((r) => {
    if (relay.exited) return r();
    child.once('exit', () => r());
    child.kill();
    setTimeout(r, 3000).unref();
  });
  return relay;
}

// A recording client, like the checker's Peer.
class Peer {
  constructor(url, opts = {}) {
    this.msgs = [];
    this.close = null;
    this.ws = new WebSocket(url, { closeTimeout: 500, ...opts });
    this.ws.on('message', (data, isBinary) => this.msgs.push({ data: Buffer.from(data), isBinary }));
    this.ws.on('error', () => {});
    this.opened = new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.opened.catch(() => {});
    this.closed = new Promise((res) => this.ws.once('close', (code, reason) => {
      this.close = { code, reason: reason.toString() };
      res(this.close);
    }));
  }
  async until(fn, ms) {
    const end = Date.now() + ms;
    while (!fn()) { if (Date.now() > end) return false; await sleep(10); }
    return true;
  }
  binaries() { return this.msgs.filter((m) => m.isBinary).map((m) => m.data); }
  end() { try { this.ws.close(1000); } catch { /* gone */ } }
}

async function join(relay, room, token = relay.token) {
  const p = new Peer(`${relay.base}/v1/room/${room}`);
  await p.opened;
  p.ws.send(`auth ${token}`);
  const ok = await p.until(() => p.msgs.length || p.close, 5000);
  if (!ok || !p.msgs.length || p.msgs[0].data.toString() !== 'ok 1') {
    throw new Error(`could not join: ${p.close ? p.close.code : 'no answer'}`);
  }
  return p;
}

// A raw TCP WebSocket handshake to `pathname`, with `extra` bytes written in
// the same packet right after the request.
function rawUpgrade(port, pathname, extra = Buffer.alloc(0)) {
  const sock = net.connect(port, '127.0.0.1');
  sock.on('error', () => {});
  const req = `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
  sock.once('connect', () => sock.write(Buffer.concat([Buffer.from(req), extra])));
  return sock;
}

// A masked client frame (RFC 6455 5.2). opcode 1 text, 2 binary.
function clientFrame(opcode, payload, { rsv = 0 } = {}) {
  const mask = crypto.randomBytes(4);
  const p = Buffer.from(payload);
  const masked = Buffer.from(p.map((b, i) => b ^ mask[i % 4]));
  let head;
  if (p.length < 126) head = Buffer.from([0x80 | rsv | opcode, 0x80 | p.length]);
  else { head = Buffer.alloc(4); head[0] = 0x80 | rsv | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
  return Buffer.concat([head, mask, masked]);
}

async function isAlive(relay) {
  if (relay.exited) return false;
  try {
    const p = await join(relay, newId());
    p.end();
    return true;
  } catch { return false; }
}

module.exports = { root, WebSocket, startRelay, Peer, join, rawUpgrade, clientFrame, newId, sleep, isAlive, freePort };

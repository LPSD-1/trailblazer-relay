#!/usr/bin/env node
// Conformance checker for Trail Blazer relays, protocol v1.
//
//   npx trailblazer-relay-check wss://your-relay.example <token>
//
// Runs every rule in PROTOCOL.md against a live relay and prints PASS or FAIL
// for each. Exit code: 0 all passed, 1 a check failed, 2 bad arguments.
// It uses fresh random rooms, so it never sees a real group's frames.
'use strict';

const crypto = require('node:crypto');
const WebSocket = require('ws');

const MAX_FRAME = 256;
const CATCH_UP = 64;
const BURST = 10;
const MAX_SOCKETS = 24;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const quietMs = Number((process.argv.find((a) => a.startsWith('--quiet-ms=')) || '').split('=')[1]) || 1000;
const [baseArg, token] = args;
if (!baseArg || !token || !/^wss?:\/\//.test(baseArg)) {
  console.error('Usage: trailblazer-relay-check wss://your-relay.example <token> [--quiet-ms=1000]');
  console.error('  --quiet-ms  how long to wait before deciding nothing more is coming (raise it on slow links)');
  process.exit(2);
}
const base = baseArg.replace(/\/+$/, '');
const roomUrl = (room) => `${base}/v1/room/${room}`;
const newRoom = () => crypto.randomBytes(16).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One WebSocket with every message and the close recorded from the start,
// so nothing that arrives before a test looks for it is missed.
class Peer {
  constructor(url) {
    this.msgs = [];
    this.waiters = [];
    this.close = null;
    this.startedAt = Date.now();
    // closeTimeout: report the close as soon as the relay's close frame has
    // arrived and been answered, rather than waiting up to 30 s for the TCP
    // connection itself to end (some runtimes hold it open for a few seconds).
    this.ws = new WebSocket(url, { closeTimeout: 500 });
    this.ws.on('message', (data, isBinary) => {
      this.msgs.push({ data: Buffer.from(data), isBinary });
      this.waiters.splice(0).forEach((w) => w());
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.opened.catch(() => {});
    this.ws.on('error', () => {});
    this.closed = new Promise((resolve) => {
      this.ws.once('close', (code, reason) => {
        this.close = { code, reason: reason.toString(), afterMs: Date.now() - this.startedAt };
        this.waiters.splice(0).forEach((w) => w());
        resolve(this.close);
      });
    });
  }

  // Resolves when fn() is truthy, or with false after ms.
  async until(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      if (fn()) return true;
      const left = end - Date.now();
      if (left <= 0) return false;
      await new Promise((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => { clearTimeout(t); r(); });
      });
    }
  }

  binaries() { return this.msgs.filter((m) => m.isBinary).map((m) => m.data); }
  send(data) { this.ws.send(data); }
  end() { try { this.ws.close(1000); } catch { /* already gone */ } }
  async closedWithin(ms) {
    return Promise.race([this.closed, sleep(ms).then(() => null)]);
  }
}

// Open a socket, authenticate, and wait for "ok 1".
async function join(room, tok = token) {
  const p = new Peer(roomUrl(room));
  await p.opened;
  p.send(`auth ${tok}`);
  const ok = await p.until(() => p.msgs.length > 0 || p.close, 5000);
  const first = p.msgs[0];
  if (!ok || !first || first.isBinary || first.data.toString() !== 'ok 1') {
    const why = p.close ? `closed ${p.close.code} ${p.close.reason}` : first ? `got ${describe(first)}` : 'no reply in 5 s';
    p.end();
    throw new Error(`could not join: ${why}`);
  }
  return p;
}

function describe(m) {
  return m.isBinary ? `a ${m.data.length}-byte binary frame` : `text "${m.data.toString().slice(0, 40)}"`;
}

// A frame is a tag byte, a 4-byte index and random filler, so frames are unique and traceable.
function frame(tag, i, size = 40) {
  const b = crypto.randomBytes(size);
  b[0] = tag;
  b.writeUInt32BE(i, 1);
  return b;
}

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
function expect(cond, msg) { if (!cond) throw new Error(msg); }
async function expectClose(p, code, ms) {
  const c = await p.closedWithin(ms);
  expect(c, `still open after ${ms} ms, expected close ${code}`);
  expect(c.code === code, `closed with ${c.code} "${c.reason}", expected ${code}`);
  return c;
}

check('a malformed room id is refused', async () => {
  for (const bad of ['short', `${newRoom()}x`, newRoom().slice(0, 21) + 'B']) {
    const p = new Peer(roomUrl(bad));
    const opened = await p.opened.then(() => true, () => false);
    p.end();
    expect(!opened, `room id "${bad}" was accepted`);
  }
});

check('the right token is accepted ("ok 1")', async () => {
  const p = await join(newRoom());
  p.end();
});

check('a wrong token is refused (4001)', async () => {
  const p = new Peer(roomUrl(newRoom()));
  await p.opened;
  p.send(`auth ${newRoom()}`); // right shape, wrong value
  await expectClose(p, 4001, 3000);
});

check('a binary frame before auth is refused (4003) and goes nowhere', async () => {
  const room = newRoom();
  const b = await join(room);
  const p = new Peer(roomUrl(room));
  await p.opened;
  // Sent back to back: once refused, the socket must not be able to
  // authenticate afterwards and slip a frame through before it finishes closing.
  p.send(frame(1, 0));
  p.send(`auth ${token}`);
  p.send(frame(1, 1));
  await expectClose(p, 4003, 3000);
  await sleep(quietMs);
  expect(!p.msgs.length, `the refused socket was sent ${describe(p.msgs[0] || { data: Buffer.alloc(0) })}`);
  expect(b.binaries().length === 0, `${b.binaries().length} frame(s) from the refused socket were forwarded`);
  b.end();
});

check('a socket that has not authenticated is sent nothing', async () => {
  const room = newRoom();
  const [a, b] = [await join(room), await join(room)];
  const f1 = frame(9, 1);
  a.send(f1);
  expect(await b.until(() => b.binaries().length === 1, 3000), 'the first frame was not forwarded');
  const u = new Peer(roomUrl(room));
  await u.opened;
  const f2 = frame(9, 2);
  a.send(f2);
  expect(await b.until(() => b.binaries().length === 2, 3000), 'the second frame was not forwarded');
  await sleep(quietMs);
  expect(u.msgs.length === 0, `before auth it was sent ${u.msgs.length} message(s), first ${u.msgs[0] && describe(u.msgs[0])}`);
  // Once it authenticates: "ok 1", then both frames as catch-up.
  u.send(`auth ${token}`);
  await u.until(() => u.msgs.length >= 3, 3000);
  const got = u.msgs.map((m) => (m.isBinary ? m.data.toString('hex') : m.data.toString()));
  expect(got.length === 3 && got[0] === 'ok 1' && got[1] === f1.toString('hex') && got[2] === f2.toString('hex'),
    `after auth got ${u.msgs.map(describe).join(', ') || 'nothing'}; expected "ok 1" then the 2 frames`);
  [a, b, u].forEach((p) => p.end());
});

check('a text frame after auth is refused (4003) and not forwarded', async () => {
  const room = newRoom();
  const [a, b] = [await join(room), await join(room)];
  a.send('hello');
  await expectClose(a, 4003, 3000);
  await sleep(quietMs);
  expect(b.msgs.length === 1, `the other socket was sent ${b.msgs.length - 1} extra message(s)`);
  b.end();
});

check('the relay answers a client close', async () => {
  const p = await join(newRoom());
  p.end();
  const c = await p.closedWithin(3000);
  expect(c, 'no close within 3 s');
  // 1006 means no close frame came back (see the closeTimeout note in Peer).
  expect(c.code !== 1006, 'the relay never answered the close frame (1006)');
});

check('no auth within 5 s is refused (4002)', async () => {
  const p = new Peer(roomUrl(newRoom()));
  await p.opened;
  const c = await expectClose(p, 4002, 9000);
  expect(c.afterMs >= 4000, `closed after ${c.afterMs} ms, earlier than the 5 s allowed`);
});

check('frames reach every other socket and not the sender', async () => {
  const room = newRoom();
  const [a, b, c] = [await join(room), await join(room), await join(room)];
  const f = frame(2, 0);
  a.send(f);
  expect(await b.until(() => b.binaries().length, 3000), 'second socket got nothing');
  expect(await c.until(() => c.binaries().length, 3000), 'third socket got nothing');
  await sleep(quietMs);
  expect(b.binaries()[0].equals(f) && c.binaries()[0].equals(f), 'the frame arrived altered');
  expect(a.binaries().length === 0, 'the sender got its own frame back');
  expect(b.binaries().length === 1 && c.binaries().length === 1, 'a frame arrived more than once');
  [a, b, c].forEach((p) => p.end());
});

check(`a ${MAX_FRAME}-byte frame is forwarded intact`, async () => {
  const room = newRoom();
  const [a, b] = [await join(room), await join(room)];
  const f = frame(3, 0, MAX_FRAME);
  a.send(f);
  expect(await b.until(() => b.binaries().length, 3000), 'nothing arrived');
  expect(b.binaries()[0].equals(f), 'the frame arrived altered');
  expect(!a.close, `the sender was closed (${a.close?.code})`);
  [a, b].forEach((p) => p.end());
});

check(`a ${MAX_FRAME + 1}-byte frame is refused (4004) and not forwarded`, async () => {
  const room = newRoom();
  const [a, b] = [await join(room), await join(room)];
  a.send(frame(4, 0, MAX_FRAME + 1));
  await expectClose(a, 4004, 3000);
  await sleep(quietMs);
  expect(b.binaries().length === 0, 'the oversize frame was forwarded');
  b.end();
});

check(`a late joiner gets the last ${CATCH_UP} frames, oldest first, before live ones`, async () => {
  const room = newRoom();
  const listener = await join(room);
  // 7 senders x 10 frames = 70, without tripping anyone's rate limit.
  const senders = [];
  for (let s = 0; s < 7; s++) senders.push(await join(room));
  for (let s = 0; s < senders.length; s++) {
    for (let i = 0; i < BURST; i++) senders[s].send(frame(5, s * BURST + i));
    // Wait until the relay has handled this sender's frames, so the order is known.
    const want = (s + 1) * BURST;
    expect(await listener.until(() => listener.binaries().length >= want, 5000),
      `listener got ${listener.binaries().length} of ${want} frames`);
  }
  const sent = listener.binaries();
  const late = await join(room);
  await late.until(() => late.binaries().length >= CATCH_UP, 5000);
  await sleep(quietMs);
  const got = late.binaries();
  expect(got.length === CATCH_UP, `got ${got.length} catch-up frames, expected ${CATCH_UP}`);
  const want = sent.slice(-CATCH_UP);
  const mismatch = got.findIndex((g, i) => !g.equals(want[i]));
  expect(mismatch === -1, `catch-up frame ${mismatch} is not the one expected (wrong order or content)`);
  // A live frame after catch-up arrives after it.
  const live = frame(5, 999);
  senders[0].send(live);
  expect(await late.until(() => late.binaries().length === CATCH_UP + 1, 3000), 'a live frame after catch-up did not arrive');
  expect(late.binaries()[CATCH_UP].equals(live), 'the live frame arrived altered');
  [listener, late, ...senders].forEach((p) => p.end());
});

check('a room is forgotten once everyone has left', async () => {
  const room = newRoom();
  const [a, b] = [await join(room), await join(room)];
  a.send(frame(6, 0));
  expect(await b.until(() => b.binaries().length, 3000), 'the frame was not forwarded');
  a.end(); b.end();
  await Promise.all([a.closed, b.closed]);
  await sleep(quietMs);
  const c = await join(room);
  await sleep(quietMs);
  expect(c.binaries().length === 0, `a newcomer to the emptied room still got ${c.binaries().length} old frame(s)`);
  c.end();
});

check(`the rate limit holds: a burst of ${BURST}, then about 1 frame/s`, async () => {
  const room = newRoom();
  const [a, b] = [await join(room), await join(room)];
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) a.send(frame(7, i));
  await b.until(() => b.binaries().length >= 30, quietMs + 1000);
  const burst = b.binaries().length;
  expect(burst >= BURST, `only ${burst} of a ${BURST}-frame burst got through`);
  expect(burst <= BURST + 2, `${burst} of 30 back-to-back frames got through; the limit is a burst of ${BURST}`);
  expect(!a.close, `the sender was closed (${a.close?.code}); over-limit frames must be dropped, not closed`);
  // After a pause, about one more frame per second of pause is allowed.
  await sleep(3000);
  const pause = (Date.now() - t0) / 1000;
  for (let i = 30; i < 40; i++) a.send(frame(7, i));
  await sleep(quietMs);
  const refill = b.binaries().length - burst;
  const lo = Math.max(1, Math.floor(pause) - 1);
  const hi = Math.min(BURST, Math.ceil(pause) + 1);
  expect(refill >= lo && refill <= hi,
    `${refill} of 10 frames got through after a ${pause.toFixed(1)} s pause; expected ${lo} to ${hi}`);
  [a, b].forEach((p) => p.end());
});

check('rooms are isolated from each other', async () => {
  const [r1, r2] = [newRoom(), newRoom()];
  const a = await join(r1);
  const b = await join(r2);
  a.send(frame(8, 0));
  const c = await join(r1); // proves the frame was accepted in r1
  expect(await c.until(() => c.binaries().length, 3000), 'the frame never reached its own room');
  const d = await join(r2);
  await sleep(quietMs);
  expect(b.binaries().length === 0, 'a frame crossed into another room (live)');
  expect(d.binaries().length === 0, 'a frame crossed into another room (catch-up)');
  [a, b, c, d].forEach((p) => p.end());
});

check(`socket ${MAX_SOCKETS + 1} is refused (4005) and a freed place can be reused`, async () => {
  const room = newRoom();
  const peers = [];
  for (let i = 0; i < MAX_SOCKETS; i++) peers.push(await join(room));
  const extra = new Peer(roomUrl(room));
  await extra.opened.catch(() => {});
  await expectClose(extra, 4005, 3000);
  peers.pop().end();
  // The relay may take a moment to notice the close; retry briefly.
  let rejoined = null;
  for (let i = 0; i < 10 && !rejoined; i++) {
    await sleep(300);
    rejoined = await join(room).catch(() => null);
  }
  expect(rejoined, `no place came free after one of ${MAX_SOCKETS} sockets left`);
  [...peers, rejoined].forEach((p) => p.end());
});

async function main() {
  console.log(`Checking ${base} against Trail Blazer relay protocol v1`);
  if (base.startsWith('ws://')) {
    console.log('note: ws:// is unencrypted; fine on your own machine, but the app only connects to wss://');
  }
  let failed = 0;
  for (const c of checks) {
    const t0 = Date.now();
    try {
      await c.fn();
      console.log(`PASS  ${c.name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${c.name}: ${e.message}`);
    }
  }
  console.log(failed ? `${failed} of ${checks.length} checks FAILED` : `All ${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`checker error: ${e.stack || e}`);
  process.exit(1);
});

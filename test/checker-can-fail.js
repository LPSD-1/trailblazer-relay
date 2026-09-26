// Proves the checker can fail: each mutant below is the Node relay with one
// rule broken, and the checker must report FAIL for every one of them.
// A checker that passes a broken relay would be worse than no checker.
//
//   node test/checker-can-fail.js
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'node', 'relay.js'), 'utf8');
const token = crypto.randomBytes(16).toString('base64url');

// [what is broken, text to find, replacement]
const mutants = [
  ['frames echo back to the sender', 'other !== ws && ', ''],
  ['catch-up keeps 65 frames', 'const CATCH_UP = 64;', 'const CATCH_UP = 65;'],
  ['catch-up is sent newest first', 'for (const f of room.frames)', 'for (const f of [...room.frames].reverse())'],
  ['frames up to 300 bytes allowed', 'const MAX_FRAME = 256;', 'const MAX_FRAME = 300;'],
  ['no rate limit', 'if (s.tokens < 1) return;', ''],
  ['burst of 20', 'const BURST = 10;', 'const BURST = 20;'],
  ['25 sockets per room', 'const MAX_SOCKETS = 24;', 'const MAX_SOCKETS = 25;'],
  ['20 s to authenticate', 'const AUTH_MS = 5000;', 'const AUTH_MS = 20000;'],
  ['any token accepted', 'if (!tokenMatches(text.slice(5)))', 'if (false)'],
  ['one shared room', 'let room = rooms.get(roomId);', 'roomId = "all"; let room = rooms.get(roomId);'],
  ['room remembered after everyone leaves',
    "if (!anyAuthed) room.frames = [];\n    if (room.sockets.size === 0) rooms.delete(roomId);", ''],
  ['non-canonical room ids accepted', 'if (!m || !isToken(m[1]))', 'if (!m)'],
  ['a refused socket can still authenticate and send', 'if (ws.readyState !== ws.OPEN) return;', ''],
  ['live frames reach unauthenticated sockets', 'other !== ws && other.tb.authed && ', 'other !== ws && '],
  ['catch-up sent before auth', 'room.sockets.add(ws);',
    'room.sockets.add(ws); for (const f of room.frames) ws.send(f, { binary: true });'],
  ['text after auth accepted', "if (!isBinary) { ws.close(CLOSE_PROTOCOL, 'text after auth'); return; }", ''],
];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function run(cmd, args, env) {
  return spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mutant-'));
  let survived = 0;
  for (const [what, find, repl] of mutants) {
    if (!source.includes(find)) {
      console.log(`ERROR  mutant "${what}": text not found in relay.js; update this test`);
      survived++;
      continue;
    }
    const file = path.join(dir, 'relay.js');
    fs.writeFileSync(file, source.replace(find, repl));
    const port = await freePort();
    const relay = run(process.execPath, [file], {
      RELAY_TOKEN: token, PORT: String(port), NODE_PATH: path.join(root, 'node_modules'),
    });
    await new Promise((r) => relay.stdout.once('data', r));
    const checker = run(process.execPath, [path.join(root, 'checker', 'check.js'), `ws://127.0.0.1:${port}`, token]);
    let out = '';
    checker.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r) => checker.on('exit', r));
    relay.kill();
    const fails = out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/^FAIL\s+/, ''));
    if (code === 1 && fails.length) {
      console.log(`CAUGHT    ${what}\n          -> ${fails.join('\n          -> ')}`);
    } else {
      survived++;
      console.log(`MISSED    ${what} (checker exit ${code})`);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(survived ? `${survived} of ${mutants.length} broken relays were NOT caught` : `All ${mutants.length} broken relays were caught`);
  process.exit(survived ? 1 : 0);
})();

// Start each relay locally, run the conformance checker against it, stop it.
//
//   node test/run.js node worker
//
// Both relays get a fresh random token, and the checker is run as the real CLI
// (a separate process), so this tests exactly what a rider would run.
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const root = path.join(__dirname, '..');
const token = crypto.randomBytes(16).toString('base64url');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Start a process and resolve once a line of its output matches ready.
function start(cmd, args, opts, ready, timeoutMs) {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`did not start within ${timeoutMs} ms:\n${out}`)), timeoutMs);
    const onData = (d) => {
      out += d.toString();
      if (ready.test(out)) { clearTimeout(t); resolve(child); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`exited with ${code} before it was ready:\n${out}`)); });
  });
}

function runChecker(url) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(root, 'checker', 'check.js'), url, token], { stdio: 'inherit' });
    c.on('exit', (code) => resolve(code));
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 3000).unref();
  });
}

const relays = {
  async node(port) {
    return start(process.execPath, [path.join(root, 'node', 'relay.js')], {
      env: { ...process.env, RELAY_TOKEN: token, PORT: String(port) },
    }, /listening on port/, 10000);
  },
  async worker(port) {
    // wrangler dev runs the Worker and its Durable Object in workerd locally.
    const pkg = require.resolve('wrangler/package.json', { paths: [path.join(root, 'worker')] });
    const wrangler = path.join(path.dirname(pkg), require(pkg).bin.wrangler);
    return start(process.execPath, [
      wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port),
      '--var', `RELAY_TOKEN:${token}`, '--show-interactive-dev-session=false',
    ], {
      cwd: path.join(root, 'worker'),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    }, /Ready on/, 120000);
  },
};

(async () => {
  const which = process.argv.slice(2);
  if (!which.length || which.some((w) => !relays[w])) {
    console.error('Usage: node test/run.js node|worker [node|worker]');
    process.exit(2);
  }
  const results = [];
  for (const name of which) {
    const port = await freePort();
    console.log(`\n=== ${name} relay on ws://127.0.0.1:${port} ===`);
    let child;
    try {
      child = await relays[name](port);
    } catch (e) {
      console.log(`FAIL  could not start the ${name} relay: ${e.message}`);
      results.push([name, 1]);
      continue;
    }
    const code = await runChecker(`ws://127.0.0.1:${port}`);
    await stop(child);
    results.push([name, code]);
  }
  console.log('\n=== summary ===');
  for (const [name, code] of results) console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${name} relay`);
  process.exit(results.every(([, code]) => code === 0) ? 0 : 1);
})();

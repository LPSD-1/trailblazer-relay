// relay-repo-1
// A WebSocket upgrade to a path the relay refuses (any non-canonical room id,
// or any path that is not /v1/room/<22-char base64url>) is answered by
// node/relay.js with `socket.end('HTTP/1.1 404 ...')` in the `server.on('upgrade')`
// handler. That raw socket never gets an 'error' listener. If the peer resets
// the TCP connection while the 404 is being written - which any client library,
// scanner or flaky network does routinely - Node emits 'error' on the socket
// with no listener, and the WHOLE relay process crashes with ECONNRESET.
//
// No token and no valid room are needed: anything on the internet that opens
// /v1/room/<junk> and drops the connection ends group ride tracking for every
// rider on that relay at once. PROTOCOL.md section 8 requires a 404 here, but
// says nothing that permits the server to die serving it.
//
// RED now: the relay exits. GREEN once the upgrade handler attaches an 'error'
// handler to the socket before writing to it (e.g. `socket.on('error', () => {})`).
'use strict';

const net = require('node:net');
const h = require('./harness.js');

(async () => {
  const relay = await h.startRelay();
  try {
    const before = await h.isAlive(relay);
    if (!before) throw new Error('relay was not alive before the test');

    // A refused upgrade path, reset the moment the relay answers.
    const s = net.connect(relay.port, '127.0.0.1');
    s.on('error', () => {});
    const req =
      'GET /v1/room/not-a-canonical-room HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n';
    s.once('connect', () => s.write(req));
    s.once('data', () => s.resetAndDestroy());

    await h.sleep(800);

    const alive = await h.isAlive(relay);
    if (relay.exited || !alive) {
      console.log('FAIL  relay-repo-1: a refused upgrade path that resets crashed the relay');
      console.log('      exit:', JSON.stringify(relay.exited));
      console.log('      last output:\n' + relay.output.split('\n').slice(-8).map((l) => '        ' + l).join('\n'));
      await relay.stop();
      process.exit(1);
    }
    console.log('PASS  relay-repo-1: relay survived a reset on a refused upgrade path');
    await relay.stop();
    process.exit(0);
  } catch (e) {
    console.log('ERROR relay-repo-1:', e.message);
    await relay.stop();
    process.exit(1);
  }
})();

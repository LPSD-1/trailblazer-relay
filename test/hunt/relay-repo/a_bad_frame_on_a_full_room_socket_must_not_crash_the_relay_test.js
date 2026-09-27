// relay-repo-2
// join() in node/relay.js attaches `ws.on('error', () => {})` only on the path
// where a socket is admitted to the room. When the room already holds 24
// sockets it does `ws.close(CLOSE_ROOM_FULL); return;` BEFORE attaching any
// error listener. The socket is still open long enough to deliver the bytes it
// sent, and a WebSocket protocol violation (here an RSV bit set, which ws
// rejects with WS_ERR_UNEXPECTED_RSV_1) makes ws emit 'error' on that socket.
// With no listener, Node crashes the entire relay process.
//
// Result: once a group's room is full (24 phones), a single 25th connection
// that sends one malformed frame takes the relay down for the whole group.
// PROTOCOL.md section 7 says the 25th socket is closed with 4005; it must not
// be able to kill the server on its way out.
//
// RED now: the relay exits. GREEN once join() attaches the socket's 'error'
// handler before the room-full early return (and for every accepted socket).
'use strict';

const h = require('./harness.js');

(async () => {
  const relay = await h.startRelay();
  const peers = [];
  try {
    const room = h.newId();
    for (let i = 0; i < 24; i++) {
      const p = new h.Peer(`${relay.base}/v1/room/${room}`);
      await p.opened;
      peers.push(p);
    }

    // The 25th socket: complete the WebSocket handshake, then in the same
    // packet send a binary frame with RSV1 set (a protocol error to ws).
    const s = h.rawUpgrade(relay.port, `/v1/room/${room}`, h.clientFrame(2, Buffer.alloc(8), { rsv: 0x40 }));
    s.on('error', () => {});

    await h.sleep(800);

    const alive = await h.isAlive(relay);
    if (relay.exited || !alive) {
      console.log('FAIL  relay-repo-2: a malformed frame from a room-full (25th) socket crashed the relay');
      console.log('      exit:', JSON.stringify(relay.exited));
      console.log('      last output:\n' + relay.output.split('\n').slice(-8).map((l) => '        ' + l).join('\n'));
      s.destroy(); peers.forEach((p) => p.end());
      await relay.stop();
      process.exit(1);
    }
    console.log('PASS  relay-repo-2: relay survived a malformed frame from a room-full socket');
    s.destroy(); peers.forEach((p) => p.end());
    await relay.stop();
    process.exit(0);
  } catch (e) {
    console.log('ERROR relay-repo-2:', e.message);
    peers.forEach((p) => p.end());
    await relay.stop();
    process.exit(1);
  }
})();

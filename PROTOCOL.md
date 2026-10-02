# Trail Blazer relay protocol, version 1

This is the whole contract between the Trail Blazer app and a group ride relay.
It is enough to write a compatible relay in any language. **Your relay is
compatible when the conformance checker in [`checker/`](checker/) passes
against it:**

```
npx trailblazer-relay-check wss://your-relay.example <token>
```

(From a copy of this repository: `node checker/check.js wss://your-relay.example <token>`,
after `npm install` in `checker/`.)

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. What a relay is

A relay is a WebSocket server that passes small encrypted messages ("frames")
between the phones in a riding group. Phones in the same group join the same
**room**. Every frame a phone sends is passed to every other phone in that
room. That is all it does.

Frames are encrypted by the phones with a key the relay never has. To the relay
a frame is opaque bytes. It cannot read one, and it MUST NOT try to.

## 2. Addressing

A rider gives the app the relay's **base address**, for example
`wss://trailblazer-relay.example.workers.dev`. The app joins a room at:

```
<base address>/v1/room/<roomId>
```

- The base address uses `wss://`. The app will not use `ws://`; `ws://` is only
  for testing on your own machine.
- The base address MAY include a path (`wss://example.org/tb`). The client
  removes any trailing `/` from it and appends `/v1/room/<roomId>`.
- The base address, as the rider enters it, is at most **120 bytes**: it
  travels inside the group's QR code, which has room for no more.
- `v1` is the protocol version (section 10).
- `roomId` is exactly 16 bytes, written as base64url (RFC 4648 section 5)
  without padding: 22 characters from `A-Z a-z 0-9 - _`. It MUST be the
  canonical encoding: decoding it and encoding it again gives the same 22
  characters (so the last character is one of `A`, `Q`, `g`, `w`). The app
  derives it from the group's secret key, so only group members can work out a
  room's id.
- A relay MUST refuse the WebSocket upgrade for any other path, including a
  `roomId` that is not canonical 22-character base64url. It SHOULD answer
  HTTP 404.

The access token is also 16 random bytes in canonical base64url (22
characters). It is the relay's password: it stops strangers using somebody's
relay. It is not what keeps positions private; the phones' encryption does that.

## 3. Joining a room

1. The client opens a WebSocket to the room address. The relay accepts it,
   unless the room is full (section 7).
2. The client's **first message MUST be a text frame** containing exactly
   `auth <token>`: the four letters `auth`, one space, the 22-character token,
   nothing else (no newline).
3. If the token matches, the relay sends the text frame `ok 1`, then the room's
   catch-up frames (section 5), then live frames as they arrive.

The relay MUST compare the token in constant time. It MUST close the socket:

| When | Close code |
|---|---|
| the first message is not a text frame starting `auth `, or is over 256 bytes | 4003 |
| the token does not match | 4001 |
| no first message arrives within 5 seconds of the socket opening | 4002 |

A relay MUST allow at least 5 seconds and SHOULD close within 6.

Once a relay has decided to close a socket, for this or any other reason, it
MUST ignore every further message on it. A client can send several messages
back to back, and many WebSocket libraries still deliver ones that were already
in flight after `close()`; a relay that kept processing them would let
`<junk>`, `auth <token>`, `<frame>` authenticate and forward a frame after
the 4003.

**Why the token goes in the first message** and not somewhere else:

- *Not in the URL* (`?token=`): URLs end up in access logs, proxy logs and
  platform dashboards. A token there leaks to anyone who can read those.
- *Not in an HTTP header* (`Authorization`): Dart's `dart:io` WebSocket and
  Node's `ws` can both send one, but browsers cannot, so a web-based checker or
  client would be impossible. A header refused before the upgrade also reaches
  the client only as an HTTP status, which WebSocket libraries report
  inconsistently, so the app could not reliably tell "wrong token" from "wrong
  address".
- *Not in `Sec-WebSocket-Protocol`*: that header is echoed back in the response
  and commonly logged, and using it for a secret is a misuse proxies do not
  expect.
- *A first message* works from every WebSocket client there is (`dart:io`,
  Node, browsers, anything), never appears in a URL or header log, and every
  failure arrives as a close code the app can name exactly (section 8). The
  cost is that a stranger can hold a socket open for up to 5 seconds without a
  token, which section 7's room limit and the 5-second deadline bound.

## 4. Frames

After `ok 1`, the client sends **binary** frames only.

- A frame is 0 to **256 bytes**. A binary frame over 256 bytes: the relay MUST
  close the socket with **4004** and MUST NOT forward the frame.
- A text frame after authentication: the relay MUST close with **4003**.
- Every accepted frame is sent, unchanged, to **every other authenticated
  socket in the same room**, in the order the relay accepted them.
- The relay MUST NOT send a frame back to the socket it came from.
- Sockets that have not authenticated yet receive nothing.
- The relay never sends a text frame except `ok 1`. A v1 client SHOULD ignore
  any other text frame, so a later minor revision can add messages.

Today's app frames are at most 256 bytes; plan parts are 246 and positions 84
(a version byte, a hop count, a 12-byte nonce, AES-256-GCM ciphertext and a
16-byte tag), but a relay MUST NOT depend on that or on any other structure:
treat every frame as opaque bytes.

## 5. Catch-up

So that a phone joining a ride sees everyone straight away, the relay keeps the
**last 64 accepted frames** of each room **in memory only**. Right after `ok 1`
it sends them to the newly authenticated socket, oldest first, before any live
frame. (A relay with asynchronous sends should queue the whole catch-up before
it starts treating the socket as a recipient of live frames, or a live frame
can overtake it.)

- Frames dropped by the rate limit (section 6) are not kept.
- When the last authenticated socket leaves a room, the relay MUST forget every
  frame it held for that room (section 9).
- A relay whose platform may wipe memory during quiet periods (for example a
  Cloudflare Durable Object hibernating after about 10 seconds with no events)
  MAY hold fewer than 64 after such a period, but MUST still hold at least the
  most recent frame sent by each socket that is still connected. The app's
  frames each carry a rider's whole current state, so the latest one per phone
  is what matters.

## 6. Rate limit

Per socket, a **token bucket of 10, refilled at 1 per second**:

- The bucket starts full when the socket opens and never holds more than 10.
- Each accepted binary frame takes one. A frame that arrives when the bucket
  holds less than one is **dropped silently**: not forwarded, not kept for
  catch-up. The socket stays open.

Dropping rather than closing is deliberate: every app frame carries the
sender's whole state, so a dropped frame is replaced by the next one, while a
close would make the phone reconnect and pull the whole catch-up again.

A phone's own position goes out every 5 seconds while moving (every 30 when
stopped), well inside the limit. The limit is **per socket, not per rider**,
though: a phone that also passes other riders' frames on to the relay (for
riders only it can hear over Bluetooth) sends those on the same socket. A
client MUST therefore keep everything it sends on one socket within the bucket,
putting its own frame first, rather than rely on the relay dropping the excess:
the relay cannot tell a rider's own frame from a forwarded one, and drops
whichever arrives when the bucket is empty. The limit exists to protect the
relay owner's free allowance.

## 7. Room size

At most **24 sockets per room**, counting sockets that have not authenticated
yet. The 25th is accepted at the WebSocket level and immediately closed with
**4005**. When a socket leaves, its place is free again.

## 8. Close codes

| Code | Meaning | What the client should do |
|---|---|---|
| 1000 | Normal close | Nothing |
| 1001 | Relay going away (restart, redeploy) | Reconnect with backoff |
| 1006 | Connection lost (no close frame; set by the client library) | Reconnect with backoff |
| 1009 | Message far too big for the relay's transport | Treat as 4004 |
| 1011 | Relay internal error | Reconnect with backoff |
| **4001** | Token refused | Stop. Tell the rider the token is wrong |
| **4002** | No `auth` message within 5 s | Reconnect; if it repeats, report it |
| **4003** | Protocol error: first message not `auth <token>`, or text after auth | Stop. The client or relay speaks a different protocol |
| **4004** | Frame over 256 bytes | Stop sending that frame; it is a client bug |
| **4005** | Room full (24 sockets) | Retry after 60 s or more |

Suggested backoff: 1 s, doubling to at most 60 s, with random jitter.

A client SHOULD act on the close code as soon as the close frame arrives, not
when the connection finally ends: some platforms (Cloudflare's local
development server, at least) hold the TCP connection open for several seconds
after sending it. A relay MUST answer a client's close frame with its own, as
RFC 6455 requires, so the client's close completes.

Refusals before the WebSocket opens are HTTP statuses: **404** for a path that
is not `/v1/room/<roomId>` (including an unknown protocol version) and **426**
for a plain HTTP request to a room path. A relay that is not configured
(no valid token set) SHOULD answer every request with **500** and a message
saying so, rather than accepting sockets it will refuse.

## 9. Room lifetime

A room exists while sockets are connected to it. When no authenticated socket
remains, the relay MUST drop that room's frames at once. A relay SHOULD also
free everything else it held for the room when its last socket leaves.

The relay SHOULD detect dead connections (a phone that lost signal without
closing) with WebSocket pings, or rely on its platform to do so. Clients MAY
send pings; control frames do not count towards the rate limit.

## 10. Rules a relay MUST NOT break

A relay MUST NOT:

1. write a frame to disk, a database, a key-value store, a queue or any other
   storage, even briefly;
2. log a frame's contents, or anything derived from them (hashes included);
3. try to parse, decrypt, decompress, validate or alter a frame;
4. send a frame to another room, back to its sender, or to anyone who has not
   authenticated in that room;
5. keep frames for a room nobody is in.

It SHOULD NOT log room ids, and SHOULD keep no per-connection logs at all.

Things a relay unavoidably sees, and which its operator is therefore trusted
with: the IP address of each connected phone, when it connected, the room id it
joined, how many sockets a room has, and the size and timing of frames. It never
sees a position, a name, or a rider's id: which connection a frame came in on
is all it knows about its sender.

## 11. Other requests

A relay SHOULD answer `GET /` (a plain HTTP request, not a WebSocket) with 200
and a short text saying it is a Trail Blazer relay speaking protocol v1, so a
person can open the address in a browser and see that it is up.

## 12. Versions

This is version 1. The version is in the path (`/v1/`), and `ok 1` confirms it.

- A change that an existing client or relay would not understand gets a new
  path (`/v2/`). A relay MAY serve several versions side by side.
- A client asking an older relay for a newer version gets HTTP 404, and should
  tell the rider the relay needs updating.
- The app ships with support for every version it has ever used, so a relay
  that stays on v1 keeps working.

## 13. Conformance

Your relay is compatible when this passes:

```
npx trailblazer-relay-check wss://your-relay.example <token>
```

It opens fresh random rooms (it never joins a real group's room) and checks:
a malformed room id is refused; the right token is accepted with `ok 1`; a wrong
token gets 4001; a binary frame before auth gets 4003, and `auth <token>` and a
frame sent straight after it go nowhere; a socket that has not authenticated is
sent nothing, then `ok 1` and catch-up once it does; text after auth gets 4003
and is not forwarded; a client's close is answered; silence gets 4002 after
5 s; frames reach every other socket and not the sender; a 256-byte frame
passes intact; a 257-byte frame gets 4004 and goes nowhere; a late joiner gets
exactly the last 64 frames in order, before live ones; an emptied room is
forgotten; the rate limit allows a burst of 10 and then about 1 per second
without closing; rooms are isolated; the 25th socket gets 4005 and a freed place
can be reused.

On a slow link, add `--quiet-ms=3000` to wait longer before deciding that
nothing more is coming.

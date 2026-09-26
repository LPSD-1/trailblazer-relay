# Security

## What the relay is trusted with

**Nothing readable.** Every frame is encrypted on the rider's phone
(AES-256-GCM, with a key derived from the group's secret, which lives only in
the group's QR code and on the members' phones). The relay never has the key,
so it cannot read or forge a frame, and the phones reject any frame it alters.
The one exception is a hop-count byte the phones leave outside the
authentication on purpose, so they can pass frames along without re-encrypting
them; changing it only makes a frame travel slightly further or stop sooner.

What a relay, its operator and its host unavoidably see is connection metadata:
phone IP addresses, connection times, the room id (random-looking, derived from
the group key), how many sockets a room has, and the timing and size of frames.
The code keeps none of it: it writes nothing to storage, logs nothing per
connection, and forgets a room's frames when the last phone leaves.

## What the access token protects

The token stops strangers using someone's relay and its free allowance. It is
not what keeps positions private; the encryption is. Everyone in the group
holds the token (it travels in the group QR code), so it cannot keep a group
member out. To remove someone from a group, the app starts a new group.

## Known limits

- Anyone who holds the token and a room id (that is, a group member) can send
  junk into that room. The rate limit (a burst of 10, then 1 frame a second per
  socket) and the room limit (24 sockets) bound it; the phones drop anything
  that does not decrypt.
- Anyone can open sockets without a token; each is closed within 5 seconds and
  counts towards the room's 24. They cannot find a real group's room without
  its key. A relay on your own server gets no protection against a flood of
  connections beyond this; use your host's or firewall's connection limits if
  that matters to you.
- A relay could replay old frames. The phones accept a frame only if its
  sequence number is newer than the last one they accepted from that rider, so
  replays are ignored.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
(**Security > Report a vulnerability**) rather than a public issue. Include the
component (`worker/`, `node/`, `checker/` or `PROTOCOL.md`) and how to
reproduce it.

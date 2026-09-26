# trailblazer-relay-check

Conformance checker for [Trail Blazer relays](https://github.com/LPSD-1/trailblazer-relay),
protocol v1.

```sh
npx trailblazer-relay-check wss://your-relay.example <token>
```

It opens fresh random rooms on the relay and checks every rule in
[PROTOCOL.md](https://github.com/LPSD-1/trailblazer-relay/blob/main/PROTOCOL.md):
authentication, fan-out, catch-up, frame size, rate limit, room isolation and
room size. It prints `PASS` or `FAIL` per rule and exits 0 when all pass, 1 when
any fails, 2 on bad arguments. Add `--quiet-ms=3000` on a slow link.

A relay is compatible with the Trail Blazer app when this passes.

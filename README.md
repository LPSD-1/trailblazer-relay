# Trail Blazer relay

A small, free server that lets a group of riders using the Trail Blazer app see
each other on the map **when they are too far apart for their phones to reach
each other directly**.

You do not need this to use group ride. Phones in a group already share
positions phone to phone over Bluetooth and Wi-Fi, passing them along the group.
A relay adds one thing: riders who are out of radio range of everyone else
(a mile back, over a hill, or waiting at the café) still show up, as long as
their phone has mobile data.

**We do not run a relay, and we never see your group's data.** One rider in the
group sets one up on their own account, using the instructions below, and
shares it with the group through the group's QR code. The whole thing is free:
the software is free, the app feature is free, and a typical group fits well
inside Cloudflare's free plan.

- [What the relay can and cannot see](#what-the-relay-can-and-cannot-see)
- [What it costs](#what-it-costs)
- [Step 1: make a token](#step-1-make-a-token)
- [Option A: Cloudflare (recommended)](#option-a-cloudflare-recommended)
- [Option B: your own computer or server](#option-b-your-own-computer-or-server)
- [Put it in the app](#put-it-in-the-app)
- [Check it works](#check-it-works)
- [Update it](#update-it) · [Shut it down](#shut-it-down) · [Troubleshooting](#troubleshooting)
- [Build your own relay](#build-your-own-relay) · [For developers](#for-developers)

## What the relay can and cannot see

Every position is encrypted on the rider's phone with the group's key before it
leaves the phone. The key is in the group's QR code and nowhere else. The relay
never has it.

| The relay **cannot** see | The relay **can** see |
|---|---|
| anyone's position, speed or heading | the IP address of each phone that connects |
| riders' names | when each phone connects and disconnects |
| who sent a message (only which connection it came in on) | which room a phone joins (a random-looking id, not the group's name) |
| whether someone pressed help | how many phones are connected to a room |
| anything about the group, even its name | how often phones send, and how big each message is (at most 256 bytes) |

The relay passes each encrypted message on to the other phones in the room and
keeps the last 64 **in memory only**, so a rider who joins mid-ride sees
everyone at once. It never writes them to disk and never logs them, and it
forgets a room as soon as the last phone leaves. The code is short enough to
read: [`worker/src/index.js`](worker/src/index.js) and
[`node/relay.js`](node/relay.js).

The person who runs the relay (you) and the company that hosts it (Cloudflare,
if you choose option A) are trusted with the right-hand column, and nothing
more. See [SECURITY.md](SECURITY.md).

## What it costs

**Nothing, for a normal group.** Figures checked against Cloudflare's own
documentation on 26 September 2026 ([Workers limits][cf-workers-limits],
[Durable Objects pricing][cf-do-pricing]):

| Cloudflare free plan allowance (per day) | A 10-rider group riding 8 hours |
|---|---|
| 100,000 Worker requests | about 10 to 500 (one per phone connection, more if signal keeps dropping) |
| 100,000 Durable Object requests (incoming WebSocket messages count 1 per 20) | about 2,900 (10 riders sending every 5 s is about 2 messages a second: 57,600 messages ÷ 20) |
| 13,000 GB-seconds of Durable Object time (charged at 128 MB while the room is active) | about 3,600 (8 h × 3,600 s × 0.125 GB) |
| 5 GB storage | none used: the relay stores nothing |

So one account comfortably carries a 10-rider group riding all day, and even a
room kept open for a full 24 hours (about 10,800 GB-s) fits. On the free plan
Cloudflare **never charges you**: if a daily allowance ran out, the relay would
simply stop working until the allowance resets (Worker requests reset at
midnight UTC), and phones would carry on sharing phone to phone.

Option B costs whatever your computer costs to run, plus a domain name if you
do not already have one.

[cf-workers-limits]: https://developers.cloudflare.com/workers/platform/limits/
[cf-do-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/

## Step 1: make a token

The token is the relay's password. It stops strangers using your relay (and
your free allowance). It is 16 random bytes written as 22 letters, digits, `-`
and `_`. Make one with **any one** of these, and keep it somewhere safe for the
next steps:

- **Windows** (PowerShell):
  ```powershell
  $b = New-Object byte[] 16; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_')
  ```
- **Mac or Linux** (Terminal):
  ```sh
  openssl rand -base64 16 | tr '+/' '-_' | tr -d '='
  ```
- **Anywhere with Node.js**:
  ```sh
  node -e "console.log(require('crypto').randomBytes(16).toString('base64url'))"
  ```

It looks like `q3VJ0Zb8Ht2rXcY5nA7pLw` (do not use that one). Every rider who
scans your group's QR code receives the token with it, so treat the QR as a
secret, which it already is.

## Option A: Cloudflare (recommended)

Cloudflare runs the relay for you on its free plan. There is no server to look
after and nothing to keep switched on. You need a free
[Cloudflare account](https://dash.cloudflare.com/sign-up).

### A1. With the button (no command line)

You also need a free [GitHub](https://github.com/signup) account: the button
copies this repository into your GitHub account and deploys it from there.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LPSD-1/trailblazer-relay/tree/main/worker)

1. Click the button and sign in to Cloudflare, then to GitHub when asked.
2. Keep the suggested names, or change them. The Worker's name becomes part of
   its address.
3. When it asks for **`RELAY_TOKEN`**, paste the token you made in step 1.
4. Click **Deploy** and wait for it to finish (a minute or two).
5. Open the Worker in the Cloudflare dashboard (**Workers & Pages**, then your
   Worker). Its address is shown there, like
   `https://trailblazer-relay.your-name.workers.dev`.
6. Open that address in your browser. You should see
   *Trail Blazer relay, protocol v1*. If you see *RELAY_TOKEN is not set*, go to
   the Worker's **Settings > Variables and Secrets**, add a secret named
   `RELAY_TOKEN` with your token, and save.

Now [put it in the app](#put-it-in-the-app).

### A2. From the command line

You need [Node.js](https://nodejs.org/) (version 18 or newer) installed.

```sh
# 1. Get the code (or download the ZIP from GitHub and unzip it)
git clone https://github.com/LPSD-1/trailblazer-relay.git
cd trailblazer-relay/worker
npm install

# 2. Sign in to Cloudflare (opens your browser)
npx wrangler login

# 3. Deploy. The first time, it may ask you to choose a workers.dev subdomain.
npx wrangler deploy

# 4. Set the token. Paste the token from step 1 when it asks.
npx wrangler secret put RELAY_TOKEN
```

`wrangler deploy` prints the address, like
`https://trailblazer-relay.your-name.workers.dev`. Open it in a browser: you
should see *Trail Blazer relay, protocol v1*.

Now [put it in the app](#put-it-in-the-app).

## Option B: your own computer or server

Any machine that stays on while you ride and can be reached from the internet:
a home server, a Raspberry Pi, a cheap VPS. The relay itself is one small Node
file ([`node/relay.js`](node/relay.js)) that needs only the `ws` package.

**The app only connects over `wss://` (encrypted WebSocket).** The relay speaks
plain `ws://`, so it has to sit behind something that adds HTTPS. The easiest is
[Caddy](https://caddyserver.com/), which gets and renews a free certificate by
itself. For that you need:

- a domain name pointing at your machine (an `A` record such as
  `relay.example.com`), and
- ports **80** and **443** reachable from the internet (on a home connection,
  forward them on your router to this machine).

### B1. With Docker (relay and HTTPS together)

> These Docker files were written carefully but were **not tested** on the
> machine this repository was built on (Docker was not installed there). The
> relay inside them is the same `node/relay.js` that the tests run. If you hit
> a problem, please open an issue.

```sh
git clone https://github.com/LPSD-1/trailblazer-relay.git
cd trailblazer-relay/node

# Put your domain name in the Caddyfile, in place of relay.example.com
nano Caddyfile

# Put your token in a file named .env
echo "RELAY_TOKEN=paste-your-token-here" > .env

docker compose up -d
```

On Windows (PowerShell), edit the Caddyfile with `notepad Caddyfile`, and make
the `.env` file with this instead, because PowerShell's `echo ... > .env`
writes a text encoding Docker cannot read:

```powershell
Set-Content -Path .env -Value "RELAY_TOKEN=paste-your-token-here" -Encoding ascii
```

Your relay's address is `wss://relay.example.com` (your domain). Open
`https://relay.example.com` in a browser: you should see
*Trail Blazer relay, protocol v1*.

To run just the relay container, with your own HTTPS in front:

```sh
docker build -t trailblazer-relay .
docker run -d --restart unless-stopped -p 8080:8080 -e RELAY_TOKEN=paste-your-token-here trailblazer-relay
```

### B2. With Node.js directly

```sh
git clone https://github.com/LPSD-1/trailblazer-relay.git
cd trailblazer-relay/node
npm install --omit=dev
RELAY_TOKEN=paste-your-token-here PORT=8080 node relay.js
```

(On Windows PowerShell: `$env:RELAY_TOKEN="paste-your-token-here"; $env:PORT="8080"; node relay.js`.)

It refuses to start without a valid token. Then put Caddy in front. Install
Caddy, and use this as its `Caddyfile`:

```
relay.example.com {
	reverse_proxy localhost:8080
}
```

Keep the relay running after you log out with whatever your system uses
(systemd, pm2, a Windows scheduled task, or the Docker route above).

## Put it in the app

You need two things: the **address** and the **token**.

- The address is your relay's address with `wss://` in place of `https://`,
  for example `wss://trailblazer-relay.your-name.workers.dev`. No path after it.
- The token is the one from step 1.

In Trail Blazer:

1. **Settings > Group ride > Use your own relay.**
2. Enter the address and the token.
3. Tap **Test the relay**. It tells you plainly if something is wrong
   (address unreachable, token refused, not a Trail Blazer relay, relay too
   old).
4. Tap **Add it to the group QR**.
5. Show the group's QR code to the others. Everyone who scans it gets the
   relay too; nobody else has to set anything up. Riders who scanned the old
   code need to scan the new one.

## Check it works

The conformance checker runs every rule of the protocol against your relay,
using throwaway rooms (it never sees a real group's messages):

```sh
npx trailblazer-relay-check wss://trailblazer-relay.your-name.workers.dev your-token
```

It prints `PASS` or `FAIL` for each rule and takes about 25 seconds.

The `npx` command works once the checker is published to npm. Until then, or
if you prefer, run the same thing from a copy of this repository (these lines
work in PowerShell and in a Mac or Linux terminal alike):

```sh
git clone https://github.com/LPSD-1/trailblazer-relay.git
cd trailblazer-relay/checker
npm install
node check.js wss://trailblazer-relay.your-name.workers.dev your-token
```

## Update it

- **Button (A1):** the button put a copy of this repository in your GitHub
  account. On GitHub, open that copy and click **Sync fork** (if it offers it),
  or copy over the changed files. Cloudflare rebuilds and redeploys it
  automatically when your copy changes.
- **Command line (A2):** in the `worker` folder, run `git pull`, then
  `npm install`, then `npx wrangler deploy`. Your token is kept.
- **Docker (B1):** `git pull`, then `docker compose up -d --build`.
- **Node (B2):** `git pull`, then restart `node relay.js`.

Updates never change the address or the token, so the group's QR code stays
valid.

## Shut it down

- **Cloudflare:** in the dashboard, **Workers & Pages >** your Worker **>
  Settings > Delete**, or run `npx wrangler delete` in the `worker` folder.
- **Docker:** `docker compose down` in the `node` folder.
- **Node:** stop the process.

Phones that still have the relay in their group simply stop reaching it and
carry on sharing phone to phone. To take it out of the group entirely, remove
it in the app and show the group a fresh QR code.

**If the token leaks** to someone outside the group: make a new token, set it
(`npx wrangler secret put RELAY_TOKEN`, or change `.env` and restart), then put
the new token in the app and show the group the new QR code. A leaked token
lets a stranger use your free allowance; it never lets them see positions,
because they do not have the group's key.

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| "Test the relay" says the address is unreachable | Wrong address, `https://` or `ws://` instead of `wss://`, or the relay is not running | Open the `https://` version in a browser; it should say *Trail Blazer relay, protocol v1* |
| The browser says *RELAY_TOKEN is not set* | The token secret is missing or not 22 characters | Set it again (A1 step 6, or `npx wrangler secret put RELAY_TOKEN`) |
| "Token refused" | The token in the app differs from the relay's, or you changed the relay's | Copy the token again exactly; no spaces |
| "Not a Trail Blazer relay" | The address points at something else, or has a path after the domain | Use just `wss://your-address`, nothing after it |
| "Relay too old" | The app speaks a newer protocol than your relay | [Update it](#update-it) |
| Works at home, not out riding | You used a local address (`192.168…`, `localhost`) or `ws://` | The relay must be reachable from the internet over `wss://` |
| Stopped working late in the day (Cloudflare), or "Error 1027" in a browser | A free daily allowance ran out | Worker requests reset at midnight UTC. Check usage in the dashboard. Phones keep sharing phone to phone meanwhile |
| Some riders cannot join | Room full: 24 phones at once | Very large groups need two groups |
| Docker: Caddy cannot get a certificate | The domain does not point at this machine, or ports 80/443 are not reachable | Check the `A` record and your router's port forwarding |
| `npx wrangler deploy` asks to register a workers.dev subdomain | First Worker on the account | Pick any name; it becomes part of the address |
| `npm install` warns that `esbuild` or `workerd` have install scripts not covered by `allowScripts` | Newer npm versions hold back install scripts until you approve them | Nothing: deploying works without them (checked with npm 11.17) |
| The checker fails on timing checks over a slow connection | Messages take longer than it waits | Add `--quiet-ms=3000` |

## Build your own relay

The protocol is small and fully written down in [PROTOCOL.md](PROTOCOL.md): the
address, how the token is sent, frames, catch-up, limits and close codes, and
what a relay must never do (store, log or try to read messages). Write it in
any language. **It works with the app when the checker passes against it.**

## For developers

```
worker/    Cloudflare Worker + Durable Object (one per room), WebSocket Hibernation API
node/      Single-file Node relay, Dockerfile, docker-compose.yml, Caddyfile
checker/   Conformance checker CLI (published as trailblazer-relay-check)
test/      Runs the checker against both relays locally; proves the checker can fail
```

```sh
npm install                      # at the repository root (npm workspaces)
npm test                         # checker vs the Node relay and vs the Worker under wrangler dev
npm run test:node                # just the Node relay
npm run test:worker              # just the Worker (starts wrangler dev locally)
npm run test:checker-can-fail    # 16 deliberately broken relays; the checker must fail each one
```

The **Deploy to Cloudflare** button's link contains this repository's address
(`https://github.com/LPSD-1/trailblazer-relay/tree/main/worker`). The button
only works while the repository is public, and a fork must change the link to
its own address. The button asks for `RELAY_TOKEN` because
[`worker/.dev.vars.example`](worker/.dev.vars.example) lists it.

Licence: [MIT](LICENSE).

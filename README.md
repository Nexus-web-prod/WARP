# WARP

WARP is a fresh implementation of an in-browser socket tunnel with a local development relay.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

```sh
npm install
npm run check
npm test
npm start
```

By default the server binds to `127.0.0.1:8787`.

- Health: http://127.0.0.1:8787/health
- Wisp WebSocket: ws://127.0.0.1:8787/wisp/

Set `PORT` to change the port. Set `WARP_HOST` to change the bind address.

## Current implementation

WARP uses the maintained `@mercuryworkshop/wisp-js` implementation for Wisp v1/v2 packet framing, handshakes, multiplexed streams, TCP sockets, buffering, flow control, and cleanup.

- TCP forwarding: enabled for permitted destinations.
- UDP forwarding: disabled in this milestone.
- Private and loopback destination IPs: blocked by default.
- Direct public IP destinations: allowed, subject to IP and port restrictions.
- Limits: 64 streams per WebSocket and 8 streams per hostname.
- Common administration/service ports are blocked.
- Browser WebSocket origins are restricted to localhost by default.
- The HTTP service binds to localhost by default.

**Do not bind this development relay to a public interface.** There is no user authentication yet. If remote access is added later, implement authentication, stronger origin policy, and deployment-specific abuse controls first.

## Protocol reference and dependency

- Wisp protocol: https://github.com/MercuryWorkshop/wisp-protocol
- Wisp JS server: https://github.com/MercuryWorkshop/wisp-js
- The Wisp JS library is licensed under LGPL-3.0-or-later; see its upstream repository for license terms.

## Project rules

- Build from scratch; no previous WARP implementation is reused.
- Develop and test locally before considering remote deployment.
- No GitHub Actions workflows are required.
- WARP is independent of NOVA.

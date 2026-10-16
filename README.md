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
- Browser view: http://127.0.0.1:8787/browser-test

Set `PORT` to change the port. Set `WARP_HOST` to change the bind address.

## Browser view

With `npm start` running, open http://127.0.0.1:8787/browser-test. The page provides a full-size browser view with an address field and back, forward, reload, and Go controls. The view loads pages through the local `/proxy?url=...` HTTP compatibility proxy, which fetches public HTTP/HTTPS pages and rewrites common HTML, CSS, image, script, and navigation URLs so they load through the local server.

This is an initial reverse-proxy layer, not a full browser engine or a complete Wisp-backed browser networking integration. Modern sites can still fail when they rely on complex client-side routing, service workers, WebSockets, strict origin checks, streaming APIs, or login cookies. Only GET and HEAD requests are currently proxied; form submissions and authenticated sessions are not fully supported. Private/local destinations are blocked and the server binds to localhost by default. The Wisp TCP relay remains available at `/wisp/`, but HTTP page fetches currently use Node's outbound fetch rather than being tunneled through Wisp.

## Current implementation

WARP uses the maintained `@mercuryworkshop/wisp-js` implementation for Wisp v1/v2 packet framing, handshakes, multiplexed streams, TCP sockets, buffering, flow control, and cleanup.

- TCP forwarding: enabled for permitted destinations.
- UDP forwarding: disabled in this milestone.
- Private and loopback destination IPs: blocked by default.
- Direct public IP destinations: allowed, subject to IP and port restrictions.
- Limit: 64 streams per WebSocket. The optional per-host limit is disabled because Wisp JS 0.5.0 has an object/iterable mismatch in that code path.
- Common administration/service ports are blocked.
- Browser WebSocket origins are restricted to localhost by default.
- The local browser proxy permits public HTTP/HTTPS targets only and rejects private/local hostnames and IP addresses.
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

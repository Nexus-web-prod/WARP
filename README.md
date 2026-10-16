# WARP

WARP is a fresh implementation of an in-browser socket tunnel with a local development relay.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

```sh
npm install
npm test
npm run check
npm start
```

By default the server binds to `127.0.0.1:8787`.

- Health: http://127.0.0.1:8787/health
- WebSocket transport: ws://127.0.0.1:8787/wisp/

Set `PORT` to change the port. Set `WARP_HOST` to change the bind address.

## Current implementation

The initial milestone establishes the local HTTP service and binary WebSocket transport smoke test. Binary WebSocket messages are echoed to validate end-to-end delivery.

**This is not yet a complete Wisp implementation and does not forward TCP or UDP sockets.** Those are subsequent milestones. Do not expose this development server to untrusted networks.

## Project rules

- Build from scratch; no previous WARP implementation is reused.
- Develop and test locally before considering remote deployment.
- No GitHub Actions workflows are required.
- WARP is independent of NOVA.

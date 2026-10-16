'use strict';

const http = require('node:http');
const { server: wisp, logging } = require('@mercuryworkshop/wisp-js/server');

const HOST = process.env.WARP_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const MAX_CONNECTIONS_PER_HOST = 8;
const MAX_STREAMS_PER_CONNECTION = 64;

// WARP is deliberately a TCP-only development relay for this milestone.
// Keep private/loopback destinations blocked even if a caller supplies a hostname
// that resolves to one of those ranges. The relay binds to localhost by default.
Object.assign(wisp.options, {
  wisp_version: 2,
  allow_tcp_streams: true,
  allow_udp_streams: false,
  allow_direct_ip: true,
  allow_private_ips: false,
  allow_loopback_ips: false,
  stream_limit_total: MAX_STREAMS_PER_CONNECTION,
  stream_limit_per_host: MAX_CONNECTIONS_PER_HOST,
  parse_real_ip: false,
  hostname_blacklist: null,
  hostname_whitelist: null,
  port_whitelist: null,
  // Block common local-administration and abuse-prone service ports.
  port_blacklist: [0, 22, 23, 25, 53, 135, 139, 445, 3389, 5900, 6379, 11211, 27017],
  wisp_motd: 'WARP local relay: TCP only; private and loopback destinations are blocked.'
});

logging.set_level(logging.INFO);

function isLocalOrigin(origin) {
  if (!origin) return true; // non-browser clients may omit Origin
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function createWarpServer() {
  const server = http.createServer((req, res) => {
    let pathname;

    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        name: 'WARP Local Relay',
        status: 'ok',
        websocket: '/wisp/',
        protocol: 'Wisp v1/v2',
        transport: 'websocket',
        milestone: 'wisp-tcp-relay',
        tcpForwarding: true,
        udpForwarding: false,
        privateDestinations: false,
        maxStreamsPerConnection: MAX_STREAMS_PER_CONNECTION,
        maxStreamsPerHost: MAX_CONNECTIONS_PER_HOST
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        'WARP local development relay\n' +
        'Health: /health\n' +
        'WebSocket: /wisp/\n' +
        'Protocol: Wisp v1/v2\n' +
        'TCP forwarding: enabled for permitted public destinations\n' +
        'UDP forwarding: disabled\n' +
        'Private and loopback destinations: blocked\n'
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname;

    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== '/wisp/') {
      socket.end(
        'HTTP/1.1 404 Not Found\r\n' +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n\r\n'
      );
      return;
    }

    if (!isLocalOrigin(req.headers.origin)) {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\n' +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n\r\n'
      );
      return;
    }

    // The upstream Wisp implementation handles framing, the v2 handshake,
    // stream multiplexing, TCP sockets, buffering, flow control and cleanup.
    wisp.routeRequest(req, socket, head);
  });

  return { server };
}

if (require.main === module) {
  const { server } = createWarpServer();

  server.on('error', (error) => {
    console.error('[WARP] Server error:', error.message);
    process.exitCode = 1;
  });

  server.listen(PORT, HOST, () => {
    console.log(`[WARP] Listening at http://${HOST}:${PORT}`);
    console.log(`[WARP] Health: http://${HOST}:${PORT}/health`);
    console.log(`[WARP] Wisp endpoint: ws://${HOST}:${PORT}/wisp/`);
    console.log('[WARP] Wisp v1/v2; TCP enabled; UDP disabled.');
    console.log('[WARP] Private/loopback destinations and selected admin ports are blocked.');
  });

  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createWarpServer, isLocalOrigin };

'use strict';

const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');

const HOST = process.env.WARP_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const MAX_PAYLOAD = 1024 * 1024;

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

    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        name: 'WARP Local Relay',
        status: 'ok',
        websocket: '/wisp/',
        transport: 'websocket',
        milestone: 'binary-transport-foundation',
        tcpForwarding: false,
        udpForwarding: false
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        'WARP local development relay\n' +
        'Health: /health\n' +
        'WebSocket: /wisp/\n' +
        'TCP/UDP forwarding: not implemented yet\n'
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: false
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        ws.close(1003, 'Binary frames required');
        return;
      }

      // Temporary smoke test for binary transport only.
      // The framed socket-tunnel protocol will replace this echo handler.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: true });
      }
    });
  });

  return { server, wss };
}

if (require.main === module) {
  const { server, wss } = createWarpServer();

  server.on('error', (error) => {
    console.error('[WARP] Server error:', error.message);
    process.exitCode = 1;
  });

  server.listen(PORT, HOST, () => {
    console.log(`[WARP] Listening at http://${HOST}:${PORT}`);
    console.log(`[WARP] Health: http://${HOST}:${PORT}/health`);
    console.log(`[WARP] WebSocket: ws://${HOST}:${PORT}/wisp/`);
    console.log('[WARP] TCP/UDP forwarding is not implemented yet.');
  });

  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }

    wss.close(() => {
      server.close(() => process.exit(0));
    });

    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createWarpServer };

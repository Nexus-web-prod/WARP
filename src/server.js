'use strict';

const http = require('node:http');
const { server: wisp, logging } = require('@mercuryworkshop/wisp-js/server');

const HOST = process.env.WARP_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
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
  // Wisp JS 0.5.0 currently iterates connection.streams as an array here,
  // while its ServerConnection stores it as an object. Disable that optional
  // per-host limiter to avoid crashing stream creation; the global cap remains.
  stream_limit_per_host: -1,
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
        maxStreamsPerHost: null
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/browser-test') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ws://127.0.0.1:8787 ws://localhost:8787" });
      res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WARP TCP Browser Test</title>
<style>
body{font:16px system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#222}
button{padding:7px 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:12px;min-height:120px}
</style>
</head>
<body>
<h1>WARP TCP test</h1>
<p>This sends one HTTP request through WARP's Wisp TCP relay. It is a transport test, not a web proxy; it does not rewrite or render remote websites.</p>
<button id="run">Request example.com over WARP</button>
<p id="status">Ready.</p>
<pre id="output">Click the button to test TCP forwarding from this browser.</pre>
<script>
(() => {
  const status = document.getElementById('status');
  const output = document.getElementById('output');
  const button = document.getElementById('run');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const streamId = 17;
  let ws;
  let response = '';
  let done = false;
  let timeout;

  function packet(type, id, payload = new Uint8Array()) {
    const bytes = new Uint8Array(5 + payload.length);
    const view = new DataView(bytes.buffer);
    bytes[0] = type;
    view.setUint32(1, id, true);
    bytes.set(payload, 5);
    return bytes;
  }

  function finish(message) {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    status.textContent = message;
    button.disabled = false;
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
  }

  button.addEventListener('click', () => {
    button.disabled = true;
    response = '';
    done = false;
    output.textContent = '';
    status.textContent = 'Connecting to local WARP relay…';

    try {
      ws = new WebSocket('ws://' + location.host + '/wisp/', 'wisp-v2');
      ws.binaryType = 'arraybuffer';
    } catch (error) {
      finish('Failed to create WebSocket: ' + error.message);
      return;
    }

    timeout = setTimeout(() => finish('Timed out waiting for the HTTP response.'), 12000);

    ws.addEventListener('open', () => {
      status.textContent = 'WebSocket connected; negotiating Wisp…';
    });

    ws.addEventListener('message', (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (bytes.length < 5) return;
      const view = new DataView(event.data);
      const type = bytes[0];
      const id = view.getUint32(1, true);
      const payload = bytes.subarray(5);

      // Wisp v2 INFO handshake.
      if (type === 5 && id === 0) {
        ws.send(packet(5, 0, new Uint8Array([2, 0])));
        status.textContent = 'Wisp connected; opening example.com:80…';
        return;
      }

      if (type === 3 && id === 0) {
        // The relay has granted initial connection credit.
        const host = encoder.encode('example.com');
        const connect = new Uint8Array(3 + host.length);
        connect[0] = 1; // TCP
        new DataView(connect.buffer).setUint16(1, 80, true);
        connect.set(host, 3);
        ws.send(packet(1, streamId, connect));
        ws.send(packet(2, streamId, encoder.encode(
          'GET / HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n'
        )));
        status.textContent = 'HTTP request sent through WARP; waiting for response…';
        return;
      }

      if (id === streamId && type === 2 && payload.length) {
        response += decoder.decode(payload, { stream: true });
        output.textContent = response;
        if (/\\r\\n\\r\\n/.test(response)) {
          const match = response.match(/^HTTP\\/\\d(?:\\.\\d)?\\s+(\\d+)/);
          if (match) status.textContent = 'Received HTTP response: ' + match[0] + ' (raw response shown below).';
          if (match && match[1] === '200') finish('PASS — WARP returned HTTP 200 from example.com.');
        }
      }
    });

    ws.addEventListener('error', () => finish('WebSocket error. Check that WARP is running on this same port.'));
    ws.addEventListener('close', () => {
      if (!done) finish(response ? 'Connection closed; partial response shown.' : 'Connection closed before a response arrived.');
    });
  });
})();
</script>
</body>
</html>`);
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
    console.log('[WARP] Global stream limit: ' + MAX_STREAMS_PER_CONNECTION + '; per-host limit disabled due to upstream library incompatibility.');
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

'use strict';

const http = require('node:http');
const { handleWebProxy, handlePokiPathProxy } = require('./web-proxy');
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

    if (pathname === '/proxy') {
      void handleWebProxy(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/browser-test') {
      const localPort = new URL('http://' + (req.headers.host || ('127.0.0.1:' + PORT))).port || PORT;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws:; frame-src 'self' http://poki.localhost:" + localPort + " http://*.poki.localhost:" + localPort
      });
      res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WARP Browser</title>
<style>
:root{color-scheme:dark;font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101114;color:#f3f4f6}
*{box-sizing:border-box}
html,body{height:100%;width:100%;margin:0;overflow:hidden}
body{display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;gap:10px;padding:12px;background:#191a20;border-bottom:1px solid #30313a}
.brand{font-weight:750;letter-spacing:.04em;white-space:nowrap}
.controls{display:flex;gap:6px}
button{border:1px solid #41424d;border-radius:8px;background:#252630;color:#f3f4f6;padding:9px 12px;font:inherit;cursor:pointer}
button:hover{background:#333542}
button:disabled{opacity:.45;cursor:default}
#address{flex:1;min-width:40px;border:1px solid #41424d;border-radius:9px;background:#101116;color:#fff;padding:10px 12px;font:inherit;outline:none}
#address:focus{border-color:#8b8df6}
#go{background:#5b5ee5;border-color:#5b5ee5;font-weight:650}
.notice{font-size:12px;color:#c4c5cf;background:#202129;padding:7px 14px;border-bottom:1px solid #30313a}
#frame{flex:1;width:100%;height:100%;border:0;background:#fff}
#blocked{display:none;padding:20px;background:#202129;color:#ddd}
@media(max-width:650px){.topbar{gap:6px;padding:8px}.brand{display:none}.controls{gap:4px}button{padding:9px}.notice{font-size:11px}}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">WARP</div>
  <div class="controls">
    <button id="back" title="Back" aria-label="Back">←</button>
    <button id="forward" title="Forward" aria-label="Forward">→</button>
    <button id="reload" title="Reload" aria-label="Reload">↻</button>
  </div>
  <input id="address" type="text" value="https://example.com/" aria-label="Website address" autocomplete="url" spellcheck="false">
  <button id="go">Go</button>
</header>
<div class="notice">WARP local browser proxy. Pages and common assets are fetched through the local WARP server; compatibility varies by site.</div>
<iframe id="frame" title="Website view" src="/proxy?url=https%3A%2F%2Fexample.com%2F" referrerpolicy="no-referrer" allow="fullscreen; autoplay; clipboard-read; clipboard-write"></iframe>
<section id="blocked" aria-live="polite">If a site still fails, it may use browser features this compatibility proxy cannot reproduce.</section>
<script>
(() => {
  const address = document.getElementById('address');
  const frame = document.getElementById('frame');
  const history = [];
  let index = -1;

  function normalize(value) {
    let text = value.trim();
    if (!text) return null;
    if (!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(text)) {
      text = /^[^\\s.]+$/.test(text) && !text.includes('localhost')
        ? 'https://www.google.com/search?q=' + encodeURIComponent(text)
        : 'https://' + text;
    }
    try {
      const url = new URL(text);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function navigate(value, record = true) {
    const url = normalize(value);
    if (!url) {
      address.setCustomValidity('Enter a valid http:// or https:// website address.');
      address.reportValidity();
      address.setCustomValidity('');
      return;
    }
    address.value = url;
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    // Keep every Poki subdomain on a matching local virtual host. Game launches
    // can cross from www.poki.com to another *.poki.com host; sending those
    // routes through /proxy changes the origin/path the game's router expects.
    // Never open external tabs.
    const isPoki = hostname === 'poki.com' || hostname === 'www.poki.com' || hostname.endsWith('.poki.com');
    if (isPoki) {
      const localPoki = new URL(location.protocol + '//poki.localhost:' + location.port);
      localPoki.hostname = hostname === 'poki.com' || hostname === 'www.poki.com'
        ? 'poki.localhost'
        : hostname.slice(0, -'.poki.com'.length) + '.poki.localhost';
      localPoki.pathname = parsed.pathname;
      localPoki.search = parsed.search;
      localPoki.hash = parsed.hash;
      frame.src = localPoki.href;
    } else {
      frame.src = '/proxy?url=' + encodeURIComponent(url);
    }
    if (record) {
      history.splice(index + 1);
      history.push(url);
      index = history.length - 1;
    }
    document.getElementById('back').disabled = index <= 0;
    document.getElementById('forward').disabled = index >= history.length - 1;
  }

  document.getElementById('go').addEventListener('click', () => navigate(address.value));
  address.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') navigate(address.value);
  });
  document.getElementById('reload').addEventListener('click', () => {
    try { frame.contentWindow.location.reload(); } catch { frame.src = frame.src; }
  });
  document.getElementById('back').addEventListener('click', () => {
    if (index > 0) navigate(history[--index], false);
    document.getElementById('back').disabled = index <= 0;
    document.getElementById('forward').disabled = index >= history.length - 1;
  });
  document.getElementById('forward').addEventListener('click', () => {
    if (index < history.length - 1) navigate(history[++index], false);
    document.getElementById('back').disabled = index <= 0;
    document.getElementById('forward').disabled = index >= history.length - 1;
  });
  navigate('https://example.com/');
})();
</script>
</body>
</html>`);
      return;
    }

    const requestHost = String(req.headers.host || '').split(':')[0].toLowerCase();
    if (requestHost === 'poki.localhost' || requestHost.endsWith('.poki.localhost')) {
      void handlePokiPathProxy(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        'WARP local development relay\n' +
        'Health: /health\n' +
        'WebSocket: /wisp/\n' +
        'Browser: /browser-test\n' +
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

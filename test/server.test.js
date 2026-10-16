'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const WebSocket = require('ws');
const { server: wisp } = require('@mercuryworkshop/wisp-js/server');
const { createWarpServer, isLocalOrigin } = require('../src/server');
const { rewriteHtml, rewriteCss, proxyUrl } = require('../src/web-proxy');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function withServer(callback) {
  const { server } = createWarpServer();
  const port = await listen(server);
  try {
    await callback({ baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/wisp/` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: body ? { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) } : {} }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function packet(type, streamId, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(streamId, 1);
  return Buffer.concat([header, payload]);
}

function parsePacket(data) {
  const bytes = Buffer.from(data);
  assert.ok(bytes.length >= 5, 'Wisp packet must contain the 5-byte header');
  return {
    type: bytes.readUInt8(0),
    streamId: bytes.readUInt32LE(1),
    payload: bytes.subarray(5)
  };
}

function waitForPacket(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Wisp packet'));
    }, timeoutMs);
    const onMessage = (data, isBinary) => {
      if (!isBinary) return;
      let parsed;
      try { parsed = parsePacket(data); } catch { return; }
      if (!predicate(parsed)) return;
      cleanup();
      resolve(parsed);
    };
    const onError = (error) => { cleanup(); reject(error); };
    function cleanup() {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('error', onError);
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

test('GET /health reports the Wisp TCP relay capabilities', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await get(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.protocol, 'Wisp v1/v2');
    assert.equal(body.tcpForwarding, true);
    assert.equal(body.udpForwarding, false);
    assert.equal(response.headers['cache-control'], 'no-store');
  });
});

test('GET /browser-test serves the WARP-proxied browser view', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await get(`${baseUrl}/browser-test`);
    assert.equal(response.status, 200);
    assert.ok(response.headers['content-type'].startsWith('text/html'));
    assert.ok(response.headers['content-security-policy'].includes("frame-src 'self'"));
    assert.ok(response.headers['content-security-policy'].includes('http://poki.localhost:' + new URL(baseUrl).port), 'The frame policy must permit the local path-preserving Poki host');
    assert.ok(response.headers['content-security-policy'].includes('http://*.poki.localhost:' + new URL(baseUrl).port), 'The frame policy must permit path-preserving Poki subdomains');
    assert.ok(response.body.includes('<iframe id="frame"'));
    assert.ok(response.body.includes('id="address"'));
    assert.ok(response.body.includes('/proxy?url=https%3A%2F%2Fexample.com%2F'));
    assert.ok(response.body.includes("const localPoki = new URL(location.protocol + '//poki.localhost:' + location.port)"), 'Poki must use a path-preserving local origin');
    assert.ok(response.body.includes('frame.src = localPoki.href'), 'Poki routes must remain inside the WARP iframe');
    assert.ok(response.body.includes("frame.src = '/proxy?url=' + encodeURIComponent(url)"), 'Other sites must keep using the normal compatibility proxy');
    assert.ok(!response.body.includes("window.open(url, '_blank')"), 'Poki navigation must not open an external browser tab');
    assert.ok(response.body.includes('WARP local browser proxy'));
  });
});

test('browser proxy rejects missing and private destination URLs', async () => {
  await withServer(async ({ baseUrl }) => {
    assert.equal((await get(`${baseUrl}/proxy`)).status, 400);
    assert.equal((await get(`${baseUrl}/proxy?url=http%3A%2F%2F127.0.0.1%2Fhealth`)).status, 403);
    assert.equal((await get(`${baseUrl}/proxy?url=http%3A%2F%2Flocalhost%2F`)).status, 403);
  });
});

test('browser proxy routes POST requests and rejects unsupported methods clearly', async () => {
  await withServer(async ({ baseUrl }) => {
    const post = await request('POST', `${baseUrl}/proxy`, 'telemetry');
    assert.equal(post.status, 400, 'POST should reach the proxy handler instead of returning route 404');
    assert.match(post.body, /Missing url parameter/);
    const unsupported = await request('PUT', `${baseUrl}/proxy`);
    assert.equal(unsupported.status, 405);
    assert.match(unsupported.headers.allow, /POST/);
  });
});

test('browser proxy rewrites common HTML and CSS resource URLs', () => {
  const html = rewriteHtml('<html><head></head><body><a href="/next">next</a><img src="img/a.png"></body></html>', 'https://www.iana.org/dir/page');
  assert.ok(html.includes('/proxy?url=https%3A%2F%2Fwww.iana.org%2Fnext'));
  assert.ok(html.includes('/proxy?url=https%3A%2F%2Fwww.iana.org%2Fdir%2Fimg%2Fa.png'));
  assert.ok(html.includes('window.fetch ='));
  assert.ok(html.includes('new Request(next, input)'), 'fetch Request objects must retain their method, headers, and body');
  assert.ok(html.includes('Element.prototype.setAttribute'), 'dynamically assigned asset URLs must be proxied');
  assert.ok(html.includes('HTMLImageElement') && html.includes('HTMLLinkElement'), 'image and icon property URLs must be proxied');
  assert.ok(html.includes('event.stopImmediatePropagation()'), 'proxy navigation must run before client-side routers inspect rewritten links');
  assert.ok(!html.includes('<base href=') && !html.includes('<base target='), 'base tags should be removed so relative URLs do not escape the proxy');
  const css = rewriteCss('body{background:url("../img/bg.png")} @import "theme.css";', 'https://example.com/css/site.css');
  assert.ok(css.includes('/proxy?url=https%3A%2F%2Fexample.com%2Fimg%2Fbg.png'));
  assert.ok(css.includes('/proxy?url=https%3A%2F%2Fexample.com%2Fcss%2Ftheme.css'));
});

test('Poki URLs preserve SPA paths on the local virtual host', () => {
  const html = rewriteHtml(
    '<html><body><a href="/en/games/example">game</a><script>window.gameIcon="/icons/game.svg"</script></body></html>',
    'https://www.poki.com/',
    'http://poki.localhost:8787'
  );
  assert.ok(html.includes('href="http://poki.localhost:8787/en/games/example"'), 'Poki navigation paths must remain visible to its SPA router');
  assert.ok(html.includes('const localPokiOrigin = "http://poki.localhost:8787"'), 'The bootstrap must know the local virtual origin');
  const css = rewriteCss('body{background:url("/assets/bg.webp")}', 'https://www.poki.com/css/site.css', 'http://poki.localhost:8787');
  assert.ok(css.includes('http://poki.localhost:8787/assets/bg.webp'), 'Same-origin Poki CSS assets must preserve their paths');

  assert.equal(
    proxyUrl('https://games.poki.com/assets/game.wasm?build=42', 'https://www.poki.com/en/games/example', 'http://poki.localhost:8787'),
    'http://games.poki.localhost:8787/assets/game.wasm?build=42',
    'Poki subdomain assets must keep their original hostname, path, and query'
  );
  const subdomainHtml = rewriteHtml(
    '<html><body><a href="https://games.poki.com/en/games/example?mode=full">game</a><img src="https://games.poki.com/assets/icon.svg"></body></html>',
    'https://www.poki.com/',
    'http://poki.localhost:8787'
  );
  assert.ok(subdomainHtml.includes('href="http://games.poki.localhost:8787/en/games/example?mode=full"'), 'Cross-subdomain game routes must preserve path and query');
  assert.ok(subdomainHtml.includes('src="http://games.poki.localhost:8787/assets/icon.svg"'), 'Cross-subdomain icons must preserve their local virtual host');
});

test('HTML URL rewriting leaves JavaScript source untouched', () => {
  const script = `const sample = 'src="data:text/plain,hello"'; const text = "href=/example";`;
  const html = rewriteHtml(
    '<html><head><base href="https://example.com/"></head><body><script>' + script + '</script><img src="/icon.svg"></body></html>',
    'https://example.com/page'
  );
  assert.ok(html.includes('<script>' + script + '</script>'), 'inline JavaScript must remain unchanged');
  assert.ok(!html.includes('<base href='), 'base tags should be removed');
  assert.ok(html.includes('/proxy?url=https%3A%2F%2Fexample.com%2Ficon.svg'));
});

test('browser proxy preserves CDN srcset URLs with commas and source referrers', () => {
  const html = rewriteHtml(
    '<html><body><img srcset="https://cdn.example/image.webp?format=webp,quality=80 1x, https://cdn.example/image@2x.webp 2x"></body></html>',
    'https://www.poki.com/en/games/example'
  );
  assert.ok(html.includes('format%3Dwebp%2Cquality%3D80'));
  assert.ok(html.includes('referer=https%3A%2F%2Fwww.poki.com%2Fen%2Fgames%2Fexample'));
  assert.ok(html.includes('https%3A%2F%2Fcdn.example%2Fimage%402x.webp'));
});

test('unknown HTTP routes return 404', async () => {
  await withServer(async ({ baseUrl }) => {
    assert.equal((await get(`${baseUrl}/missing`)).status, 404);
  });
});

test('WebSocket upgrades on paths other than /wisp/ are rejected', async () => {
  await withServer(async ({ baseUrl }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(baseUrl).port}/wrong-path`);
    await new Promise((resolve, reject) => {
      ws.once('unexpected-response', (_req, response) => {
        assert.equal(response.statusCode, 404);
        response.resume();
        resolve();
      });
      ws.once('open', () => reject(new Error('Unexpected WebSocket upgrade')));
      ws.once('error', (error) => {
        if (error.message.includes('Unexpected server response')) return;
        reject(error);
      });
    });
    ws.terminate();
  });
});

test('Wisp v2 performs INFO handshake and grants initial stream credit', async () => {
  await withServer(async ({ wsUrl }) => {
    const ws = new WebSocket(wsUrl, 'wisp-v2');
    const serverInfoPromise = waitForPacket(ws, (p) => p.type === 5 && p.streamId === 0);
    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      const serverInfo = await serverInfoPromise;
      assert.equal(serverInfo.payload.readUInt8(0), 2);
      assert.equal(serverInfo.payload.readUInt8(1), 0);

      const creditPromise = waitForPacket(ws, (p) => p.type === 3 && p.streamId === 0);
      ws.send(packet(5, 0, Buffer.from([2, 0])));
      const credit = await creditPromise;
      assert.equal(credit.payload.readUInt32LE(0), 128);
    } finally {
      if (ws.readyState === WebSocket.OPEN) {
        await new Promise((resolve) => {
          ws.once('close', resolve);
          ws.close();
        });
      } else if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
    }
  });
});

test('browser origins outside localhost are rejected', () => {
  assert.equal(isLocalOrigin('http://localhost:3000'), true);
  assert.equal(isLocalOrigin('http://127.0.0.1:8080'), true);
  assert.equal(isLocalOrigin('https://example.com'), false);
  assert.equal(isLocalOrigin('not a url'), false);
});

test('Wisp TCP stream forwards data to and from a permitted destination', async () => {
  const originalOptions = {
    allow_private_ips: wisp.options.allow_private_ips,
    allow_loopback_ips: wisp.options.allow_loopback_ips,
    allow_direct_ip: wisp.options.allow_direct_ip,
    allow_udp_streams: wisp.options.allow_udp_streams,
    port_blacklist: wisp.options.port_blacklist,
    stream_limit_total: wisp.options.stream_limit_total,
    stream_limit_per_host: wisp.options.stream_limit_per_host
  };

  const target = net.createServer((socket) => {
    socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), data])));
  });
  const targetPort = await listen(target);

  // Permit loopback only inside this isolated test so a local fake TCP target
  // can exercise the real forwarding path. Production defaults remain blocked.
  Object.assign(wisp.options, {
    allow_private_ips: true,
    allow_loopback_ips: true,
    allow_direct_ip: true,
    allow_udp_streams: false,
    port_blacklist: [0],
    stream_limit_total: 64,
    stream_limit_per_host: -1
  });

  try {
    await withServer(async ({ wsUrl }) => {
      const ws = new WebSocket(wsUrl);
      const initialCredit = waitForPacket(ws, (p) => p.type === 3 && p.streamId === 0);
      try {
        await new Promise((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });

        const credit = await initialCredit;
        assert.equal(credit.payload.readUInt32LE(0), 128);

        const streamId = 17;
        const response = waitForPacket(ws, (p) => p.type === 2 && p.streamId === streamId);
        const connectPayload = Buffer.alloc(3);
        connectPayload.writeUInt8(1, 0); // TCP
        connectPayload.writeUInt16LE(targetPort, 1);
        ws.send(packet(1, streamId, Buffer.concat([connectPayload, Buffer.from('127.0.0.1')])));

        // The protocol allows DATA immediately after CONNECT; the server queues it
        // until the TCP connection is ready.
        ws.send(packet(2, streamId, Buffer.from('hello')));
        const received = await response;
        assert.equal(received.payload.toString(), 'echo:hello');
      } finally {
        if (ws.readyState === WebSocket.OPEN) {
          await new Promise((resolve) => {
            ws.once('close', resolve);
            ws.close();
          });
        } else if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
      }
    });
  } finally {
    target.close();
    Object.assign(wisp.options, originalOptions);
  }
});

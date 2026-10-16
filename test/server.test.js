'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const WebSocket = require('ws');
const { server: wisp } = require('@mercuryworkshop/wisp-js/server');
const { createWarpServer, isLocalOrigin } = require('../src/server');

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

test('GET /browser-test serves the local Wisp TCP diagnostic page', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await get(`${baseUrl}/browser-test`);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /text\\/html/);
    assert.match(response.body, /Request example\\.com over WARP/);
    assert.match(response.body, /not a web proxy/);
    assert.match(response.body, /Wisp TCP/);
  });
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

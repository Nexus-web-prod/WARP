'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createWarpServer } = require('../src/server');

async function withServer(callback) {
  const { server, wss } = createWarpServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/wisp/`;

  try {
    await callback({ baseUrl, wsUrl });
  } finally {
    for (const client of wss.clients) client.terminate();

    await new Promise((resolve) => {
      wss.close(() => {
        if (!server.listening) return resolve();
        server.close(resolve);
      });
    });
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body
      }));
    }).on('error', reject);
  });
}

test('GET /health returns a healthy local relay status', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await get(`${baseUrl}/health`);
    assert.equal(response.status, 200);

    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.websocket, '/wisp/');
    assert.equal(body.tcpForwarding, false);
    assert.equal(response.headers['cache-control'], 'no-store');
  });
});

test('unknown HTTP routes return 404', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await get(`${baseUrl}/missing`);
    assert.equal(response.status, 404);
  });
});

test('WebSocket endpoint echoes binary frames unchanged', async () => {
  await withServer(async ({ wsUrl }) => {
    const ws = new WebSocket(wsUrl);
    const payload = Buffer.from([0x57, 0x41, 0x52, 0x50, 0x00, 0xff]);

    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      const received = new Promise((resolve, reject) => {
        ws.once('message', (data, isBinary) => {
          if (!isBinary) return reject(new Error('Expected binary response'));
          resolve(data);
        });
        ws.once('error', reject);
      });

      ws.send(payload, { binary: true });
      assert.deepEqual(await received, payload);
    } finally {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
  });
});

test('WebSocket upgrades on paths other than /wisp/ are rejected', async () => {
  await withServer(async ({ baseUrl }) => {
    const port = new URL(baseUrl).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/wrong-path`);

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

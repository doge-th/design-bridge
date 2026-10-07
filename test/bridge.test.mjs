// Integration tests with fully local mocks: a fake official cloud gateway
// (upstream) and a fake MiniMax OpenPlatform. No network, no real keys.
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { MinimaxOpenProvider, ProviderError } from '../lib/minimax-open.mjs';
import { TaskMap } from '../lib/taskmap.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('provider maps Design payload -> OpenPlatform and back', async () => {
  const calls = [];
  const { srv, port } = await startServer((req, res) => {
    calls.push(req.url);
    if (req.url === '/v1/video_generation') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push(JSON.parse(body));
        res.end(JSON.stringify({ task_id: 'plat-1', base_resp: { status_code: 0 } }));
      });
    } else if (req.url.startsWith('/v1/query/video_generation')) {
      res.end(JSON.stringify({ status: 'Success', file_id: 'file-9' }));
    } else if (req.url.startsWith('/v1/files/retrieve')) {
      assert.match(req.url, /GroupId=g-1/);
      res.end(JSON.stringify({ file: { download_url: 'https://cdn.example/v.mp4' } }));
    } else {
      res.writeHead(404); res.end('{}');
    }
  });

  const p = new MinimaxOpenProvider({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'sk-test', groupId: 'g-1', model: 'MiniMax-Hailuo-02',
  });

  // generate
  const submitted = await p.generate({
    model: 'H3-internal-name', prompt: 'a cat', duration: 6,
    aspect_ratio: '16:9', resolution: '768P', generate_audio: true,
    first_frame_image: 'https://oss/ref0.png',
    reference_images: ['https://oss/ref1.png'], // dropped, Hailuo-02 has no slot
  });
  assert.equal(submitted.task_id, 'plat-1');
  const openBody = calls.find((c) => c && c.model === 'MiniMax-Hailuo-02');
  assert.ok(openBody, 'openplatform payload seen');
  assert.equal(openBody.model, 'MiniMax-Hailuo-02');           // model replaced
  assert.equal(openBody.duration, 6);
  assert.equal(openBody.first_frame_image, 'https://oss/ref0.png');
  assert.match(openBody.prompt, /a cat/);
  assert.match(openBody.prompt, /16:9/);                        // ratio folded into prompt
  assert.ok(!openBody.reference_images, 'unsupported field dropped');

  // query status mapping
  const q = await p.query('plat-1');
  assert.equal(q.status, 'success');
  assert.equal(q.file_id, 'file-9');

  // file retrieve
  const f = await p.file('file-9');
  assert.equal(f.file.download_url, 'https://cdn.example/v.mp4');

  // auth header
  assert.deepEqual(calls[0], '/v1/video_generation');
  srv.close();
});

test('provider maps provider failures honestly', async () => {
  const { srv, port } = await startServer((req, res) => {
    if (req.url.startsWith('/v1/query/video_generation')) {
      res.end(JSON.stringify({
        status: 'Fail',
        base_resp: { status_code: 1004, status_msg: 'content filtered' },
      }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  const p = new MinimaxOpenProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k' });
  const q = await p.query('t');
  assert.equal(q.status, 'failed');
  assert.equal(q.base_resp.status_msg, 'content filtered');
  srv.close();
});

test('provider surfaces HTTP errors as ProviderError', async () => {
  const { srv, port } = await startServer((req, res) => {
    res.writeHead(401); res.end(JSON.stringify({ base_resp: { status_msg: 'invalid key' } }));
  });
  const p = new MinimaxOpenProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'bad' });
  await assert.rejects(() => p.generate({ prompt: 'x' }), ProviderError);
  srv.close();
});

test('status vocabulary tolerant mapping', async () => {
  const seen = [];
  const { srv, port } = await startServer((req, res) => {
    res.end(JSON.stringify({ status: seen.shift() ?? 'Prepare' }));
  });
  const p = new MinimaxOpenProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k' });
  assert.equal((await p.query('t')).status, 'processing');   // Prepare
  srv.close();
});

test('TaskMap persists across restart and creates distinct bridge ids', async () => {
  const file = path.join(tmpdir(), `tm-${Date.now()}.json`);
  const tm1 = new TaskMap(file, 1);
  const a = tm1.create('plat-A', 'minimax-open');
  const b = tm1.create('plat-B', 'minimax-open');
  assert.notEqual(a, b);
  const tm2 = new TaskMap(file, 1); // "restart"
  assert.equal(tm2.get(a).providerTaskId, 'plat-A');
  assert.equal(tm2.get(b).providerTaskId, 'plat-B');
  assert.equal(tm2.get('nope'), null);
});

// ── full bridge smoke test: routing + double-layer cloud shape ─────────────
test('bridge server end-to-end with mocks', async () => {
  const upstreamCalls = [];
  const { srv: up, port: upPort } = await startServer((req, res) => {
    upstreamCalls.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, via: 'upstream' }));
  });

  const { srv: plat, port: platPort } = await startServer((req, res) => {
    if (req.url === '/v1/video_generation') {
      res.end(JSON.stringify({ task_id: 'plat-xyz' }));
    } else if (req.url.includes('video_generation')) {
      res.end(JSON.stringify({ status: 'Success', file_id: 'f-1' }));
    } else if (req.url.startsWith('/v1/files/retrieve')) {
      res.end(JSON.stringify({ file: { download_url: 'https://cdn/v.mp4' } }));
    } else { res.writeHead(404); res.end('{}'); }
  });

  // boot the real bridge as a subprocess, config injected via env
  const { spawn } = await import('node:child_process');
  const bridge = spawn(process.execPath, [
    path.resolve(import.meta.dirname, '..', 'bridge.mjs'), '--port=0',
    `--upstream=http://127.0.0.1:${upPort}`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DESIGN_BRIDGE_API_KEY: 'sk-test',
      DESIGN_BRIDGE_PROVIDER_BASE_URL: `http://127.0.0.1:${platPort}`,
    },
  });
  let stderr = '';
  bridge.stderr.on('data', (d) => (stderr += d));

  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`bridge did not start\n${stderr}`)), 5000);
    bridge.stdout.on('data', (d) => {
      const m = String(d).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
  });

  try {
    // 1. hijacked generate -> bridge task id (root + data both carry it)
    const gen = await (await fetch(`http://127.0.0.1:${port}/api/v1/video/minimax-v3/generate`, {
      method: 'POST', headers: { token: 'jwt-x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'doge', duration: 5, aspect_ratio: '9:16' }),
    })).json();
    assert.equal(gen.task_id, gen.data.task_id);
    assert.equal(gen.base_resp.status_code, 0);

    // 2. query -> success + file_id in both layers
    const q = await (await fetch(`http://127.0.0.1:${port}/api/v1/video/minimax-v3/tasks/${gen.task_id}`)).json();
    assert.equal(q.status, 'success');
    assert.equal(q.data.status, 'success');
    assert.equal(q.file_id, 'f-1');

    // 3. files -> download_url in both layers
    const f = await (await fetch(`http://127.0.0.1:${port}/api/v1/video/minimax/files/f-1`)).json();
    assert.equal(f.file.download_url, 'https://cdn/v.mp4');
    assert.equal(f.data.file.download_url, 'https://cdn/v.mp4');

    // 4. untouched path goes to the official upstream with the app's token intact
    const pas = await (await fetch(`http://127.0.0.1:${port}/api/v1/client_config`, {
      headers: { token: 'jwt-x' },
    })).json();
    assert.equal(pas.via, 'upstream');
    assert.ok(upstreamCalls.includes('/api/v1/client_config'));

    // 5. health endpoint
    const h = await (await fetch(`http://127.0.0.1:${port}/__bridge/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.provider.name, 'minimax-open');
  } finally {
    bridge.kill();
    for (const s of [up, plat]) { s.closeAllConnections?.(); s.close(); }
  }
});

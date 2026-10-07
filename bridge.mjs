#!/usr/bin/env node
// design-bridge — let MiniMax Design render video through your own video API.
//
// MiniMax Design (desktop) spawns a local gateway that sends every media
// generation call to its cloud gateway (design.minimax.cn). The gateway's
// base URL is overridable via the CLOUD_GATEWAY_BASE_URL environment
// variable — an official escape hatch declared in the app's own
// conf/external_api_conf.yaml. Point it at this bridge and:
//
//   * /api/v1/video/minimax*(generate|tasks|files)  -> YOUR provider key
//   * everything else (login, client_config, LLM,
//     uploads, image/audio, kling/veo3/wan/...)     -> passed through
//     to the official cloud untouched
//
// Run with --record to dump every hijacked exchange as JSONL so the exact
// protocol can be audited and new providers aligned.

import http from 'node:http';
import { loadConfig, ROOT } from './lib/config.mjs';
import { TaskMap } from './lib/taskmap.mjs';
import { Recorder } from './lib/recorder.mjs';
import { passthrough, jsonRequest } from './lib/passthrough.mjs';
import { MinimaxOpenProvider, ProviderError } from './lib/minimax-open.mjs';
import { bootstrapTls } from './lib/tls-bootstrap.mjs';
import path from 'node:path';

const VERSION = '0.1.0';
const log = (...a) => console.log('[bridge]', ...a);

// ── helpers ────────────────────────────────────────────────────────────────

const MAX_HIJACK_BODY = 64 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_HIJACK_BODY) {
        reject(new ProviderError('body', 413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw.slice(0, 2048) }); }
    });
    req.on('error', reject);
  });
}

// The official gateway reads some endpoints from the JSON root and others
// from a `.data` wrapper — mirror the payload in both places so either
// parser finds it.
function cloudShape(obj) {
  const out = { ...obj };
  if (out.data === undefined) out.data = { ...obj };
  if (out.base_resp === undefined) out.base_resp = { status_code: 0, status_msg: 'success' };
  if (out.data && out.data.base_resp === undefined) out.data.base_resp = out.base_resp;
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendProviderError(res, err, label) {
  log(`ERROR ${label}: ${err.message}`);
  // Report failures inside the task protocol so Design surfaces a retryable
  // error instead of an opaque poll timeout.
  sendJson(res, 200, cloudShape({
    status: 'failed',
    base_resp: { status_code: err.status ?? -1, status_msg: `design-bridge: ${err.message}` },
  }));
}

function passthroughToken(req) {
  if (typeof req.headers.token === 'string' && req.headers.token) return req.headers.token;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

// ── server ─────────────────────────────────────────────────────────────────

// Hijacked cloud-gateway paths. minimax (v1) and minimax-v3 (H3) share the
// same file_retrieve endpoint.
const RE_GENERATE = /^\/api\/v1\/video\/minimax(-v3)?\/(enhancement\/|continuation\/)?generate$/;
const RE_TASKS = /^\/api\/v1\/video\/minimax(-v3)?\/tasks\/([^/?]+)$/;
const RE_FILES = /^\/api\/v1\/video\/minimax\/files\/([^/?]+)$/;

export function startBridge(cfg, deps = {}) {
  bootstrapTls(cfg, log);
  const tasks = deps.tasks ?? new TaskMap(cfg.stateFile, cfg.taskTtlHours);
  const recorder = cfg.record ? new Recorder(path.join(ROOT, 'recordings')) : null;
  if (recorder) log(`recording session -> ${recorder.file}`);
  const provider = cfg.provider && cfg.provider !== 'off'
    ? new MinimaxOpenProvider(cfg.providers[cfg.provider], log)
    : null;

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/__bridge/health') {
      return sendJson(res, 200, {
        ok: true, version: VERSION,
        provider: provider ? { name: cfg.provider, model: provider.model, baseUrl: provider.baseUrl } : null,
        upstream: cfg.upstream, recording: !!recorder,
      });
    }

    if (req.method === 'POST' && RE_GENERATE.test(url)) return void handleGenerate(req, res).catch((e) => sendProviderError(res, e, 'generate'));
    if (req.method === 'GET' && RE_TASKS.test(url)) {
      const id = url.match(RE_TASKS)[2];
      return void handleQuery(req, res, id).catch((e) => sendProviderError(res, e, 'query'));
    }
    if (req.method === 'GET' && RE_FILES.test(url)) {
      const fid = url.match(RE_FILES)[1];
      return void handleFile(req, res, fid).catch((e) => sendProviderError(res, e, 'file'));
    }

    return passthrough(req, res, cfg.upstream);
  });

  return { server, tasks, recorder, provider };

  // ── hijacked handlers (close over provider/tasks/recorder) ───────────────

  async function handleGenerate(req, res) {
    const designBody = await readJsonBody(req);
    if (!provider) { // record-only mode: forward untouched so a real task still runs
      return void passthroughWithRecord(req, res, designBody);
    }
    try {
      const { task_id: providerTaskId } = await provider.generate(designBody);
      const bridgeTaskId = tasks.create(providerTaskId, cfg.provider);
      const resp = cloudShape({ task_id: bridgeTaskId });
      recorder?.log({ kind: 'generate', path: req.url, status: 200, reqHeaders: req.headers, reqBody: designBody, resBody: resp });
      sendJson(res, 200, resp);
    } catch (err) {
      recorder?.log({ kind: 'generate', path: req.url, status: 502, reqHeaders: req.headers, reqBody: designBody, resBody: { error: err.message } });
      sendProviderError(res, err, 'generate');
    }
  }

  async function handleQuery(req, res, bridgeTaskId) {
    if (!provider) return void passthroughWithRecord(req, res);
    const rec = tasks.get(bridgeTaskId);
    if (!rec) {
      // Unknown task (cleared state file / task from another machine): fail it
      // loudly rather than spinning forever.
      return sendJson(res, 200, cloudShape({
        status: 'failed',
        base_resp: { status_code: 404, status_msg: `design-bridge: unknown bridge task ${bridgeTaskId}` },
      }));
    }
    try {
      const q = await provider.query(rec.providerTaskId);
      const resp = cloudShape(q);
      recorder?.log({ kind: 'query', path: req.url, status: 200, reqHeaders: req.headers, resBody: resp });
      sendJson(res, 200, resp);
    } catch (err) {
      sendProviderError(res, err, `query ${bridgeTaskId}`);
    }
  }

  async function handleFile(req, res, fileId) {
    if (!provider) return void passthroughWithRecord(req, res);
    try {
      const f = await provider.file(fileId);
      const resp = cloudShape(f);
      recorder?.log({ kind: 'file', path: req.url, status: 200, reqHeaders: req.headers, resBody: resp });
      sendJson(res, 200, resp);
    } catch (err) {
      sendProviderError(res, err, `file ${fileId}`);
    }
  }

  // Record-only passthrough for hijack-shaped paths: buffer the exchange fully
  // (these paths are small JSON, no SSE) and replay it upstream so the real
  // task still runs while we capture the exact schema.
  async function passthroughWithRecord(req, res, bufferedBody) {
    const token = passthroughToken(req);
    try {
      const init = { method: req.method };
      if (bufferedBody !== undefined && !('_raw' in (bufferedBody || {}))) {
        init.body = JSON.stringify(bufferedBody);
      } else if (bufferedBody?._raw) {
        init.body = bufferedBody._raw;
      }
      const resp = await jsonRequest(cfg.upstream, req.url, init, {
        headers: {
          ...(token ? { token, Authorization: `Bearer ${token}` } : {}),
        },
      });
      recorder?.log({
        kind: 'passthrough-captured', path: req.url, status: resp.status,
        reqHeaders: req.headers, reqBody: bufferedBody, resBody: resp.body,
      });
      sendJson(res, resp.status, resp.body);
    } catch (err) {
      recorder?.log({ kind: 'passthrough-captured', path: req.url, status: 502, reqHeaders: req.headers, reqBody: bufferedBody, resBody: { error: err.message } });
      sendProviderError(res, err, 'passthrough-capture');
    }
  }
}

// ── run as a script ────────────────────────────────────────────────────────

const isMain = process.argv[1] && process.argv[1].endsWith('bridge.mjs');

if (isMain) {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`[bridge] ${err.message}`);
    process.exit(1);
  }
  if (cfg.record) log(`recording session -> see recordings/`);
  const { server, provider } = startBridge(cfg);
  server.listen(cfg.port, cfg.host, () => {
    const realPort = server.address().port;
    log(`listening on http://${cfg.host}:${realPort}`);
    log(`upstream (untouched traffic) -> ${cfg.upstream}`);
    if (provider) {
      log(`provider: ${cfg.provider} model=${provider.model} baseUrl=${provider.baseUrl}`);
      log(`hijacked: POST /api/v1/video/minimax*/.../generate`);
      log(`hijacked: GET  /api/v1/video/minimax*/tasks/:id`);
      log(`hijacked: GET  /api/v1/video/minimax/files/:id`);
    } else {
      log('provider: OFF — pure transparent proxy');
    }
    log('');
    log('Point MiniMax Design at this bridge:');
    log('  ./scripts/enable-mac.sh   # sets CLOUD_GATEWAY_BASE_URL for the app, then restart it');
    log('  ./scripts/disable-mac.sh  # undo');
  });
  const shutdown = () => { log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

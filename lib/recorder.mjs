// Traffic recorder (--record): JSONL dump of every exchange the bridge sees.
// Purpose: aligning the exact request/response schema of MiniMax Design's
// cloud-gateway protocol with your own provider. Credentials are redacted.
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const SENSITIVE_HEADERS = new Set([
  'token', 'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
  'x-group-id', 'api-key',
]);

function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase())
      ? `<redacted:${String(v).length}ch>`
      : v;
  }
  return out;
}

// Long media payloads make recordings unreadable; clip them but keep shape.
function clip(value, depth = 0) {
  if (depth > 8) return '...';
  if (typeof value === 'string') {
    if (value.length > 512) return { clipped: true, length: value.length, head: value.slice(0, 128) };
    return value;
  }
  if (Array.isArray(value)) return value.length > 20 ? [...value.slice(0, 20).map((v) => clip(v, depth + 1)), `...+${value.length - 20}`] : value.map((v) => clip(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clip(v, depth + 1);
    return out;
  }
  return value;
}

export class Recorder {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    mkdirSync(dir, { recursive: true });
  }

  log(entry) {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      ...entry,
      reqHeaders: redactHeaders(entry.reqHeaders),
      resHeaders: entry.resHeaders ? redactHeaders(entry.resHeaders) : undefined,
      reqBody: entry.reqBody !== undefined ? clip(entry.reqBody) : undefined,
      resBody: entry.resBody !== undefined ? clip(entry.resBody) : undefined,
    });
    try { appendFileSync(this.file, line + '\n'); } catch { /* disk full etc. */ }
  }
}

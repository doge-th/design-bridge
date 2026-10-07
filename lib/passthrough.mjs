// Transparent reverse proxy to the real cloud gateway (design.minimax.cn).
// Everything the bridge does not explicitly hijack goes through here,
// streaming both ways (LLM SSE, big upload bodies), headers preserved.
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import { extraCa } from './tls-bootstrap.mjs';

// Hop-by-hop headers that must not be forwarded (RFC 7230 §6.1).
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

export function passthrough(req, res, upstreamBase) {
  const target = new URL(req.url, upstreamBase);
  const lib = target.protocol === 'http:' ? httpRequest : httpsRequest;

  const headers = { ...req.headers };
  for (const h of HOP_HEADERS) delete headers[h];
  headers.host = target.host;
  // the Design gateway talks to a bare API host; keep referer-origin out of it
  delete headers.origin;
  delete headers.referer;

  const upstreamReq = lib(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      method: req.method,
      path: target.pathname + target.search,
      headers,
      servername: target.hostname, // SNI for IP-less certs
      ...(target.protocol === 'https:' && extraCa() ? { ca: extraCa() } : {}),
    },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers };
      for (const h of HOP_HEADERS) delete outHeaders[h];
      res.writeHead(upstreamRes.statusCode, outHeaders);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ base_resp: { status_code: -1, status_msg: `design-bridge passthrough: ${err.message}` } }));
  });

  // client abort should abort upstream too
  res.on('close', () => upstreamReq.destroy());
  req.pipe(upstreamReq);
}

/**
 * Small JSON request helper used for upstream cloud-gateway replays AND by
 * provider bridges (api.minimax.chat shares the incomplete-chain problem).
 * Built on node:https rather than global fetch on purpose: the TLS trust
 * bundle is assembled at runtime, and NODE_EXTRA_CA_CERTS only applies to
 * fetch if it was set before the process started.
 */
export function jsonRequest(baseUrl, pathName, init = {}, { headers: extraHeaders = {} } = {}) {
  const target = new URL(pathName, baseUrl);
  const lib = target.protocol === 'http:' ? httpRequest : httpsRequest;

  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  return new Promise((resolve, reject) => {
    const req = lib(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        method: init.method || 'GET',
        path: target.pathname + target.search,
        headers,
        servername: target.hostname,
        ...(target.protocol === 'https:' && extraCa() ? { ca: extraCa() } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let body = text;
          try { body = JSON.parse(text); } catch { /* keep text */ }
          resolve({ status: res.statusCode, ok: res.statusCode < 400, body });
        });
      }
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

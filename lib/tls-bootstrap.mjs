// TLS trust bootstrap.
//
// design.minimax.cn serves an incomplete chain (DNSPod DV TLS whose
// intermediate is not shipped in Node's built-in Mozilla roots). Browsers
// survive via AIA fetching; Node does not. The official app solves this by
// exporting system trust into the gateway process (HILO_SYSTEM_CA_CERTS).
// We do the same: export macOS system roots once, cache them, and apply to
// both node:https requests and (via NODE_EXTRA_CA_CERTS) global fetch.
//
// Order of preference:
//   1. an explicit config.extraCaFile / NODE_EXTRA_CA_CERTS from the user
//   2. macOS Keychain export (SystemRootCertificates + System keychain)
//   3. otherwise: rely on Node built-ins (fine on typical Linux setups)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE = path.join(os.homedir(), '.design-bridge', 'ca-bundle.pem');

let caPem = null;
let done = false;

/** Returns a PEM bundle of extra CAs, or null when none could be built. */
export function extraCa() {
  return caPem;
}

export function bootstrapTls(cfg = {}, log = () => {}) {
  if (done) return;
  done = true;

  if (cfg.extraCaFile) {
    try {
      caPem = readFileSync(cfg.extraCaFile, 'utf-8');
      process.env.NODE_EXTRA_CA_CERTS = cfg.extraCaFile;
      log(`TLS: using extra CA file from config (${cfg.extraCaFile})`);
      return;
    } catch (err) {
      log(`TLS: config.extraCaFile unreadable (${err.message}), falling back`);
    }
  }

  if (process.env.NODE_EXTRA_CA_CERTS && existsSync(process.env.NODE_EXTRA_CA_CERTS)) {
    try {
      caPem = readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf-8');
      log(`TLS: honoring existing NODE_EXTRA_CA_CERTS`);
      return;
    } catch { /* fall through */ }
  }

  if (process.platform !== 'darwin') {
    // Linux: ca-certificates usually covers public CAs; nothing to do.
    return;
  }

  try {
    const parts = [
      '/System/Library/Keychains/SystemRootCertificates.keychain',
      '/Library/Keychains/System.keychain',
    ].map((kc) =>
      execFileSync('security', ['find-certificate', '-a', '-p', kc], {
        maxBuffer: 16 * 1024 * 1024,
      }).toString()
    );
    caPem = parts.join('\n');
    mkdirSync(path.dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, caPem);
    process.env.NODE_EXTRA_CA_CERTS = CACHE;
    log(`TLS: exported macOS system roots (${(caPem.length / 1024) | 0} KB) -> ${CACHE}`);
  } catch (err) {
    log(`TLS: could not export system roots (${err.message}). ` +
      `If passthrough fails with certificate errors, export your CA bundle and ` +
      `set NODE_EXTRA_CA_CERTS or config.extraCaFile.`);
  }
}

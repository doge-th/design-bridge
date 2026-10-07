// Config loading: config.json next to the script, every field overridable via env.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  port: 9527,
  host: '127.0.0.1',
  upstream: 'https://design.minimax.cn',
  provider: 'minimax-open',
  providers: {
    'minimax-open': {
      baseUrl: 'https://api.minimax.chat',
      apiKey: '',
      groupId: '',
      model: 'MiniMax-Hailuo-02',
    },
  },
  stateFile: './tasks.json',
  taskTtlHours: 72,
  record: false,
};

export function loadConfig(argv = process.argv) {
  const cli = parseArgs(argv);
  const file = (() => {
    try {
      return JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
    } catch {
      return {};
    }
  })();

  const cfg = { ...DEFAULTS, ...file };
  if (cli.port !== undefined) cfg.port = cli.port;
  if (cli.upstream) cfg.upstream = cli.upstream;
  if (cli.provider) cfg.provider = cli.provider;
  if (cli.record) cfg.record = true;

  // env fallbacks, handy for LaunchAgent / CI
  if (process.env.DESIGN_BRIDGE_PORT) cfg.port = Number(process.env.DESIGN_BRIDGE_PORT);
  if (process.env.DESIGN_BRIDGE_UPSTREAM) cfg.upstream = process.env.DESIGN_BRIDGE_UPSTREAM.replace(/\/+$/, '');
  if (process.env.DESIGN_BRIDGE_PROVIDER) cfg.provider = process.env.DESIGN_BRIDGE_PROVIDER;
  // per-provider env overrides (active provider only)
  if (cfg.provider && cfg.provider !== 'off' && cfg.providers[cfg.provider]) {
    const p = cfg.providers[cfg.provider];
    if (process.env.DESIGN_BRIDGE_API_KEY) p.apiKey = process.env.DESIGN_BRIDGE_API_KEY;
    if (process.env.DESIGN_BRIDGE_PROVIDER_BASE_URL) p.baseUrl = process.env.DESIGN_BRIDGE_PROVIDER_BASE_URL.replace(/\/+$/, '');
  }

  // strip our _comment fields, they are only for humans; merge each provider
  // over the default skeleton so partial configs work
  cfg.providers = Object.fromEntries(
    Object.entries(cfg.providers || {}).map(([k, v]) => [
      k,
      { ...(DEFAULTS.providers[k] ?? { baseUrl: '', apiKey: '', groupId: '', model: '' }), ...stripComments(v) },
    ])
  );

  if (cfg.provider && cfg.provider !== 'off') {
    const p = cfg.providers[cfg.provider];
    if (!p) {
      throw new Error(`config: provider "${cfg.provider}" has no entry under providers{}`);
    }
    if (!p.apiKey) {
      throw new Error(
        `config: providers.${cfg.provider}.apiKey is empty — copy config.example.json to config.json and paste your key` +
        ` (or set DESIGN_BRIDGE_API_KEY)`
      );
    }
  }

  cfg.stateFile = path.resolve(ROOT, cfg.stateFile);
  cfg.upstream = cfg.upstream.replace(/\/+$/, '');
  return cfg;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--record') out.record = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--upstream') out.upstream = argv[++i];
    else if (a.startsWith('--upstream=')) out.upstream = a.slice(11);
    else if (a === '--provider') out.provider = argv[++i];
    else if (a.startsWith('--provider=')) out.provider = a.slice(11);
  }
  return out;
}

function stripComments(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

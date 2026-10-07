// Provider bridge: MiniMax OpenPlatform video API (api.minimax.chat /
// api.minimaxi.com) spoken in the cloud-gateway dialect that the local
// MiniMax Design gateway understands.
//
// Design (cloud dialect)                      OpenPlatform
// POST /api/v1/video/minimax-v3/generate  ->  POST /v1/video_generation
// GET  /api/v1/video/minimax-v3/tasks/:id ->  GET  /v1/query/video_generation?task_id=
// GET  /api/v1/video/minimax/files/:fid   ->  GET  /v1/files/retrieve?GroupId=&file_id=
//
// Uploading (POST /api/v1/files/upload) is intentionally NOT hijacked: it is
// free on the official cloud and returns a public OSS URL the OpenPlatform
// can consume directly, so the bridge passes it through untouched.

import { jsonRequest } from './passthrough.mjs';
import { extraCa } from './tls-bootstrap.mjs';

export class MinimaxOpenProvider {
  constructor(opts, log = () => {}) {
    this.baseUrl = String(opts.baseUrl || 'https://api.minimax.chat').replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.groupId = opts.groupId || opts.group_id || '';
    this.model = opts.model || 'MiniMax-Hailuo-02';
    this.log = log;
  }

  async #fetchJson(path, init, label) {
    const resp = await jsonRequest(this.baseUrl, path, init, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const text = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
    let body = resp.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = { raw: text.slice(0, 500) }; }
    }
    if (!resp.ok) {
      const msg = body?.base_resp?.status_msg || body?.message || text.slice(0, 200);
      throw new ProviderError(label, resp.status, msg);
    }
    return body;
  }

  /**
   * Handle POST .../generate. `designBody` is the cloud-gateway payload.
   * Returns the cloud-gateway style response (task created).
   */
  async generate(designBody) {
    const open = this.#mapGenerateBody(designBody);
    this.log('provider:minimax-open submit', open);
    const resp = await this.#fetchJson('/v1/video_generation', {
      method: 'POST',
      body: JSON.stringify(open),
    }, 'video_generation');

    const providerTaskId = resp?.task_id
      ?? resp?.data?.task_id
      ?? resp?.base_resp?.task_id;
    if (!providerTaskId) {
      throw new ProviderError('video_generation', 200,
        `no task_id in response: ${JSON.stringify(resp).slice(0, 300)}`);
    }
    return { task_id: providerTaskId };
  }

  /** Map a Design cloud-gateway generate payload to an OpenPlatform payload. */
  #mapGenerateBody(designBody = {}) {
    const out = { model: this.model };

    let prompt = String(designBody.prompt ?? '');
    // Design sends aspect_ratio (or ratio); Hailuo-02 controls framing through
    // the prompt, so we append it instead of dropping it silently.
    const ratio = designBody.aspect_ratio || designBody.ratio;
    if (ratio && ratio !== 'adaptive' && !/--ar|画幅|画面比例/.test(prompt)) {
      prompt = `${prompt.trim()}，画幅比例 ${ratio}`;
    }
    out.prompt = prompt;

    for (const key of ['first_frame_image', 'last_frame_image']) {
      const v = designBody[key];
      if (typeof v === 'string' && v) out[key] = v;
    }
    if (designBody.duration != null) out.duration = Number(designBody.duration) || undefined;

    // Fields with no direct Hailuo-02 equivalent: keep them in the log so the
    // schema gap is visible instead of silently swallowed.
    const dropped = Object.keys(designBody).filter((k) =>
      !['prompt', 'aspect_ratio', 'ratio', 'duration', 'first_frame_image', 'last_frame_image'].includes(k)
      && designBody[k] != null && designBody[k] !== '' && designBody[k] !== false
    );
    if (dropped.length) this.log('provider:minimax-open unmapped fields dropped:', dropped);

    return out;
  }

  /**
   * Handle GET .../tasks/:id. `providerTaskId` is what generate() returned.
   * Returns cloud-gateway style query response.
   */
  async query(providerTaskId) {
    const resp = await this.#fetchJson(
      `/v1/query/video_generation?task_id=${encodeURIComponent(providerTaskId)}`,
      { method: 'GET' },
      'query_video_generation'
    );

    const rawStatus = String(resp?.status ?? 'processing').toLowerCase();
    const status =
      rawStatus === 'success' || rawStatus === 'succeed' ? 'success'
      : rawStatus === 'fail' || rawStatus === 'failed' ? 'failed'
      : 'processing';

    const out = { status, provider_task_id: providerTaskId };
    if (status === 'success' && resp?.file_id) out.file_id = String(resp.file_id);
    if (status === 'failed') {
      out.base_resp = {
        status_code: resp?.base_resp?.status_code ?? 1,
        status_msg: resp?.base_resp?.status_msg || 'provider task failed',
      };
    }
    return out;
  }

  /**
   * Handle GET .../files/:fid. Returns cloud-gateway style file response
   * with a download_url the local gateway can fetch.
   */
  async file(providerFileId) {
    const qs = new URLSearchParams({ file_id: String(providerFileId) });
    if (this.groupId) qs.set('GroupId', this.groupId);
    const resp = await this.#fetchJson(`/v1/files/retrieve?${qs}`, { method: 'GET' }, 'files_retrieve');
    const url = resp?.file?.download_url;
    if (!url) {
      throw new ProviderError('files_retrieve', 200,
        `no file.download_url: ${JSON.stringify(resp).slice(0, 300)}`);
    }
    return { file: { download_url: url } };
  }
}

export class ProviderError extends Error {
  constructor(label, status, detail) {
    super(`[minimax-open] ${label} failed (${status}): ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

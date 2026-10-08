# design-bridge

**Use your own video API key inside MiniMax Design.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](#)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue)](#)

[中文](README.md) | English

MiniMax Design (the desktop agentic video creation tool) sends every video
generation request to MiniMax's cloud gateway and bills your subscription.
`design-bridge` is a tiny zero-dependency local proxy that redirects video
generation to your own MiniMax OpenPlatform key instead:

```
MiniMax Design ──> local design-bridge (127.0.0.1:9527) ──┬─ generate/query/retrieve ──> YOUR API key (pay-as-you-go)
                                                          └─ everything else (auth, LLM,
                                                             uploads, image/audio, kling…) ──> official cloud, untouched
```

It works through a hook MiniMax left themselves: the app's
`conf/external_api_conf.yaml` documents that the cloud gateway URL can be
overridden with the `CLOUD_GATEWAY_BASE_URL` environment variable. No app
patching, no repacking, survives app updates, and `disable` reverts everything.

## Who is this for

- **Your Design subscription runs out mid-project**: keep working pay-as-you-go
  with an OpenPlatform key instead of waiting for the quota reset
- **Developers with a Hailuo API key** who want Design's agentic workflow
  (storyboards, assets, editing) on their own quota
- **The curious**: [docs/protocol.md](docs/protocol.md) is a full
  reverse-engineering writeup of Design's cloud gateway protocol

Not for bypassing payment — generation still bills your own key. This is a
personal interoperability tool.

## Quick start (macOS)

```bash
git clone https://github.com/doge-th/design-bridge.git
cd design-bridge

# 1. Configure your key (create one at platform.minimax.io / platform.minimax.cn)
cp config.example.json config.json
#   edit config.json: set apiKey (required) and groupId (visible on the account page)

# 2. Inject the env var + install the background service (LaunchAgent)
./scripts/enable-mac.sh

# 3. Fully quit MiniMax Design (including the tray icon) and reopen it
#    Generate a video in Design — it now bills YOUR key
```

Verify:

```bash
curl -s http://127.0.0.1:9527/__bridge/health
```

Restore official billing:

```bash
./scripts/disable-mac.sh   # then fully quit and reopen MiniMax Design
```

## What gets hijacked, what passes through

| Path | Destination |
|---|---|
| `POST /api/v1/video/minimax*/…/generate` | **your** OpenPlatform `/v1/video_generation` |
| `GET /api/v1/video/minimax*/tasks/:id` | **your** `/v1/query/video_generation` |
| `GET /api/v1/video/minimax/files/:id` | **your** `/v1/files/retrieve` |
| `POST /api/v1/files/upload` (reference media) | official (free, returns a public OSS URL both sides accept) |
| everything else (auth / client_config / LLM / image / speech / kling / veo3 / wan / seedance…) | official, streamed through untouched |

Built-in provider: `minimax-open` (MiniMax OpenPlatform, mainland
`api.minimax.chat` / overseas `api.minimaxi.com`, model configurable,
default `MiniMax-Hailuo-02`).

## `--record`: protocol capture & alignment

The mapping layer was written from static reverse engineering (full field
tables in [docs/protocol.md](docs/protocol.md)). If a field doesn't line up
(a generation fails), run record mode: it dumps every hijacked exchange as
credential-redacted JSONL so you can patch the provider mapping against real
traffic:

```bash
node bridge.mjs --record
# recordings/session-*.jsonl
```

You can also run `provider: off` + `--record` for a pure transparent capture:
requests still go to the official cloud (normal billing) while the gateway
protocol is recorded for adapting new providers.

## Configuration

`config.json` (copy from `config.example.json`); every field has an env override:

| Field | Default | Notes |
|---|---|---|
| `port` | `9527` | local listen port |
| `upstream` | `https://design.minimax.cn` | passthrough target (overseas build: `design.minimax.io`) |
| `provider` | `minimax-open` | active provider; `off` = pure transparent proxy |
| `providers.minimax-open.baseUrl` | `https://api.minimax.chat` | overseas: `api.minimaxi.com` |
| `providers.minimax-open.apiKey` | — | **required** (or `DESIGN_BRIDGE_API_KEY`) |
| `providers.minimax-open.groupId` | empty | GroupId for files/retrieve, visible on the account page |
| `providers.minimax-open.model` | `MiniMax-Hailuo-02` | see the platform model list |

## FAQ

**A generation failed — now what?**
Check `bridge.log` (LaunchAgent mode) or terminal output; `--record` JSONL has
the full exchange. Provider errors are returned in Design's own task-failure
protocol, so the app shows a retryable error instead of hanging.

**How does billing work?**
Hijacked generation bills your own key at OpenPlatform prices; uploads and
everything else go through the official cloud (uploads are free).

**Does an app update break it?**
No. The env var is injected at the OS level (`launchctl setuserenv`), which is
independent of app versions. If the protocol itself changes, re-align with
`--record`.

**Windows / Linux?**
The bridge itself is cross-platform (pure Node); only `scripts/*-mac.sh` are
macOS-specific. On Windows, set the user env var `CLOUD_GATEWAY_BASE_URL`
yourself and run the bridge — PRs for scripts welcome.

**Is this allowed?**
This is personal interoperability: your own key, your own account, no billing
bypass, no abuse automation. Please follow MiniMax's terms of service.

## Known limitations (v0.1)

* Multi-reference-image / `enhancement` / `continuation` modes degrade to plain
  generation; unmapped fields are logged, not swallowed
* `aspect_ratio` is folded into the prompt (Hailuo-02 has no dedicated slot)
* Only MiniMax-family video endpoints are hijacked; kling / veo3 / wan /
  seedance go through the official cloud. To add a provider:
  `lib/minimax-open.mjs` is the template, `--record` is the tool.

## Roadmap

- [ ] End-to-end screencast with a real key
- [ ] Windows enable script
- [ ] More providers: Alibaba Bailian (wan family), local ComfyUI workflows
- [ ] Full H3 parameter mapping (multi-ref / enhancement / continuation)

## License

MIT

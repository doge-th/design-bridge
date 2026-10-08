# design-bridge

**让 MiniMax Design 用你自己的视频 API key 出片。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](#)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue)](#)

English | [中文](#让-minimax-design-用你自己的视频-api-key-出片)

MiniMax Design（桌面端 agentic 视频创作工具）默认把所有视频生成请求发给
MiniMax 官方云网关，扣订阅额度。`design-bridge` 是一个跑在本机的零依赖小代理：

```
MiniMax Design ──> 本地 design-bridge(127.0.0.1:9527) ──┬─ 视频生成/查询/取结果 ──> 你的 API key（按量计费）
                                                        └─ 其余一切（登录/配置/LLM/
                                                           上传/图片/语音/kling…）──> 官方，原样透传
```

它利用的是官方自己留的口子：app 内 `conf/external_api_conf.yaml` 明确声明云网关地址
可由 `CLOUD_GATEWAY_BASE_URL` 环境变量覆盖。不改 app、不破解、不改包、更新不受影响，
`disable` 一步即可还原。

## 适合谁

- **Design 订阅额度不够用 / 不想为偶尔出片买订阅**：有开放平台 key 的话，按量付费，用多少扣多少
- **手上有 Hailuo API key 的开发者**：想在 Design 的 agentic 工作流（分镜、资产、剪辑）里用自己的额度跑
- **想看 MiniMax Design 怎么工作的人**：[docs/protocol.md](docs/protocol.md) 是完整的云网关协议逆向笔记

不适合：想绕过付费的人——生成照常走你自己的 key 计费，本项目只做互操作。

## 快速开始（macOS）

```bash
git clone https://github.com/doge-th/design-bridge.git
cd design-bridge

# 1. 配置你的 key（MiniMax 开放平台 platform.minimax.cn 创建）
cp config.example.json config.json
#   编辑 config.json，填 apiKey（必填）和 groupId（账户管理页可见）

# 2. 注入环境变量 + 安装常驻服务（LaunchAgent）
./scripts/enable-mac.sh

# 3. 完全退出 MiniMax Design（菜单栏托盘也要退）再重开
#    然后在 Design 里生成一个视频 —— 走的就是你自己的 key
```

验证：

```bash
curl -s http://127.0.0.1:9527/__bridge/health
```

还原官方计费：

```bash
./scripts/disable-mac.sh    # 然后再次完全退出并重开 MiniMax Design
```

## 它劫持了什么、透传了什么

| 路径 | 去向 |
|---|---|
| `POST /api/v1/video/minimax*/…/generate` | **你的**开放平台 `/v1/video_generation` |
| `GET /api/v1/video/minimax*/tasks/:id` | **你的** `/v1/query/video_generation` |
| `GET /api/v1/video/minimax/files/:id` | **你的** `/v1/files/retrieve` |
| `POST /api/v1/files/upload`（参考图上传） | 官方（免费，产出公开 OSS URL，两边都能用） |
| 其余全部（登录 / client_config / LLM / 图片 / 语音 / kling / veo3 / wan / seedance…） | 官方，流式透传 |

当前内置 provider：`minimax-open`（MiniMax 开放平台，国内 `api.minimax.chat` /
海外 `api.minimaxi.com`，模型可在 config 里改，默认 `MiniMax-Hailuo-02`）。

## `--record`：协议对齐 & 抓包

映射层是按逆向出来的协议写的（见 [docs/protocol.md](docs/protocol.md)，含完整字段表）。
如果某个字段没对上（表现为生成失败），跑一次录制模式，把劫持路径的真实交换
（自动打码凭证）落成 JSONL，对着修 provider 即可：

```bash
node bridge.mjs --record          # 劫持路径 + record-only 模式均可
# recordings/session-*.jsonl
```

也可以 `provider: null` + `--record` 跑纯透传录制：请求照常走官方（正常扣费出片），
同时把云网关协议原样录下来，用于适配新 provider。

## 配置

`config.json`（由 `config.example.json` 复制），全部可用环境变量覆盖：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `9527` | 本地监听端口 |
| `upstream` | `https://design.minimax.cn` | 透传目标（海外版改 `design.minimax.io`） |
| `provider` | `minimax-open` | 激活的 provider；`off` = 纯透传 |
| `providers.minimax-open.baseUrl` | `https://api.minimax.chat` | 海外用 `api.minimaxi.com` |
| `providers.minimax-open.apiKey` | — | **必填**（或 `DESIGN_BRIDGE_API_KEY`） |
| `providers.minimax-open.groupId` | 空 | files/retrieve 用的 GroupId，账户管理页可见 |
| `providers.minimax-open.model` | `MiniMax-Hailuo-02` | 按平台模型列表改 |

## 常见问题

**生成失败怎么排查？**
看 `bridge.log`（LaunchAgent 模式）或终端输出；`--record` 的 JSONL 里有完整交换。
provider 的错误会按 Design 的任务失败协议返回，app 内会显示可重试的报错。

**计费怎么算？**
劫持路径的生成走你自己的 key、按开放平台价格扣；上传和其余请求走官方（上传免费）。

**app 更新会失效吗？**
不会。环境变量注入在系统层，`launchctl setuserenv` 与 app 版本无关。
协议字段变化的极端情况再用 `--record` 对齐。

**Windows / Linux？**
桥本身跨平台（纯 Node），只有 `scripts/*-mac.sh` 是 macOS 的。
Windows 下用系统方式设置用户环境变量 `CLOUD_GATEWAY_BASE_URL` 后启动 bridge 即可，
欢迎 PR 补脚本。

**合法/合规？**
本项目只做个人互操作：走你自己的 key、为你自己的账号服务，不含任何绕过计费、
批量滥用或攻击官方服务的逻辑。请遵守 MiniMax 服务条款。

## 已知限制（v0.1）

* 多参考图（`reference_images`）/ `enhancement` / `continuation` 模式按普通生成降级处理，
  未映射字段会在日志里列出；
* `aspect_ratio` 通过追加 prompt 实现（Hailuo-02 无独立参数位）；
* 仅劫持 MiniMax 家视频端点；kling / veo3 / wan / seedance 走官方。
  想接别的家：`lib/minimax-open.mjs` 是模板，`--record` 是工具。

## Roadmap

- [ ] 真实 key 的端到端生成实录（GIF/视频）
- [ ] Windows 启用脚本（桥本体已跨平台，只差 launchctl 的替代方案）
- [ ] 更多 provider：阿里云百炼（wan 系列）、ComfyUI 本地工作流
- [ ] H3 参数完整映射（多参考图 / enhancement / continuation）
- [ ] 设计一个更优雅的密钥管理（现在是明文 config.json）

欢迎 PR：新增 provider 只需照着 `lib/minimax-open.mjs` 写一个同接口的类，
用 `--record` 抓目标平台的真实交换对齐字段，测试里加一个 mock 用例即可。

## 许可

MIT

# MiniMax Design 云网关协议逆向笔记

> 基于 MiniMax Design 3.0.21（bundle id `com.minimax.hub`，macOS 版）的
> `Contents/Resources/gateway/dist/main.js`（本地 hilo-gateway，约 16 MB 打包 JS）静态分析整理。
> 本笔记仅记录与桥接相关的部分，供新 provider 适配和协议演进时对照。

## 1. 三层架构

```
Electron 渲染进程/主进程 (app.asar)
        │  spawn（环境变量黑名单式过滤，几乎全透传）
        ▼
本地 gateway（hilo-gateway，Node 子进程，监听 127.0.0.1:8001）
        │  所有媒体生成请求 → 云端网关（cloud gateway）
        ▼
https://design.minimax.cn（国内）/ https://design.minimax.io（海外）
```

* 本地 gateway **不持有第三方模型密钥**；生成能力全部由云端网关代理，认证用的是
  MiniMax 账号 JWT（请求头 `token: <JWT>` + `Authorization: Bearer <JWT>`）。
* 云网关地址解析优先级（`resolveExternalApi`）：

  ```
  process.env.CLOUD_GATEWAY_BASE_URL
    > external_api_conf.yaml 的 cloud_gateway.base_url
    > CLOUD_GATEWAY_URLS[region][channel]   # dev 默认 hub-pre.xaminim.com，prod=design.minimax.cn
  ```

  `Contents/Resources/conf/external_api_conf.yaml` 头部注释明确写明该环境变量可覆盖——
  这是官方留给开发/测试的口子，design-bridge 正是利用它。
* 主进程把环境变量传给 gateway 子进程时使用**黑名单过滤**
  （`filterAgentProfileOwnedEnv` 只删 agent-profile 专属键），因此
  `launchctl setuserenv CLOUD_GATEWAY_BASE_URL ...` 对 GUI 启动的 app 生效。

## 2. 视频生成端点（cloud 方言）

端点清单来自 `external_api_conf.yaml` 的 `cloud_gateway.video` 段；
后端家族：`minimax`（旧版）、`minimax_v3`（H3/Hailuo03，主力）、`kling`、`veo3`、`wan`、
`wan3`、`seedance`、`kling_avatar`。各家统一遵循同一交互形状：

### 2.1 提交

```
POST {base}/api/v1/video/minimax-v3/generate
     /api/v1/video/minimax-v3/enhancement/generate
     /api/v1/video/minimax-v3/continuation/generate
```

请求体（由本地 gateway 构造，参考素材已先行上传为 URL）：

```jsonc
{
  "model": "<内部模型名>",
  "prompt": "...",
  "duration": 5,                     // 4/5 ~ 15 秒，H3 Max 最小 5
  "aspect_ratio": "16:9",            // 或 "ratio"；"adaptive" 表示随参考图
  "resolution": "768P",              // 768P / 2K 等
  "generate_audio": true,
  "image_mode": "reference | first-last-frame | video-extension | text-to-video",
  "first_frame_image": "<OSS url 或 data: URI>",   // 可选
  "last_frame_image": "<OSS url>",                 // 可选
  "reference_images": ["<url>"],                   // 可选，多参考图
  "reference_videos": ["<url>"],
  "reference_video_durations_ms": [1234],
  "prompt_expansion_mode": "..."      // 可选
}
```

响应：任务 id。本地侧按 `task_id` 解析（`mapVideoQueryResp` 同族逻辑取根字段）。

### 2.2 查询

```
GET {base}/api/v1/video/minimax-v3/tasks/<task_id>
```

响应（`mapVideoQueryResp` 的取值口径，根字段直取）：

```jsonc
{
  "status": "success | failed | fail | cancelled | <其他=进行中>",
  "file_id": "...",                        // 成功时出现
  "provider_task_id": "...",               // 可选，透传给 UI
  "estimated_remaining_wait_seconds": 30,  // 可选
  "base_resp": { "status_code": 0, "status_msg": "...", "user_message": "..." }  // 失败时
}
```

### 2.3 取结果文件

```
GET {base}/api/v1/video/minimax/files/<file_id>
```

响应（`mapFileRetrieveResp`）：

```jsonc
{ "file": { "download_url": "https://..." } }
```

本地 gateway 拿到 `download_url` 后自行 `downloadMediaToDir` 下载 mp4 并 ffprobe。

### 2.4 素材上传（桥接不劫持）

```
POST {base}/api/v1/files/upload
{ "file_data": "<data: URI>", "file_prefix": "image" }
→ { "url": "<公开 OSS URL>" }
```

上传不消耗生成额度，且返回的是公开 URL，MiniMax 开放平台可直接消费，
所以 design-bridge 将其透传官方。

### 2.5 一个已知不一致

部分端点（如 mediakit 系列）的响应走 `data.*` 包装，而 minimax-v3 系列根字段直取。
桥接对劫持路径的响应做**根字段 + `data` 镜像双层返回**，两种解析器都能命中。

## 3. 与 MiniMax 开放平台 API 的对应

| cloud 方言 | 开放平台 | 备注 |
|---|---|---|
| `POST /api/v1/video/minimax-v3/generate` | `POST /v1/video_generation` | `Authorization: Bearer <你的key>` |
| `GET /api/v1/video/minimax-v3/tasks/:id` | `GET /v1/query/video_generation?task_id=` | 状态映射 Success→success / Fail→failed |
| `GET /api/v1/video/minimax/files/:fid` | `GET /v1/files/retrieve?GroupId=&file_id=` | 返回 `file.download_url` |

两者同构并非巧合：Design 云网关本身就是开放平台 API 的计费/账号包装层。

## 4. 诚实的边界（待真实流量对齐）

以下细节来自静态分析，尚未抓包复核，适配新 provider 时建议先跑 `--record`：

* generate 响应中 task id 的确切字段层级（已用根 + `data` 双层兜底）；
* `image_mode: reference` 多参考图在开放平台的等价参数（Hailuo-02 无多参考图，
  目前丢弃并记录日志；H3 上开放平台后补映射）；
* `enhancement/continuation` 两个变体目前按普通生成处理。

`--record` 模式会把劫持路径的完整交换（凭证打码）写进 `recordings/*.jsonl`，
对着 dump 修 provider 映射即可，不需要再逆向。

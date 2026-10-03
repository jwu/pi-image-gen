# pi-image-gen 设计

让 coding agent 通过一个 `image_gen` tool 调用图像生成，支持三条通道：

| 通道     | 上游                                                    | 授权                          |
| -------- | ------------------------------------------------------- | ----------------------------- |
| `codex`  | `https://chatgpt.com/backend-api/codex/images/*`         | **复用 pi 已登录的 `openai-codex`** |
| `grok`   | `https://api.x.ai/v1/images/*`                           | x.ai OAuth2 device code（自建）|
| `openai` | `{baseUrl}/images/generations`、multipart `/images/edits` | `OPENAI_API_KEY` 优先，其次自建 auth 文件 |

参考实现来自 `~/dev/ai-canvas/`（`server/codexAuth.ts`、`scripts/codex-image-probe.ts`、
`scripts/grok-image-probe.ts`、`docs/generation.md`），本设计把其中可移植的部分抽出来，并改造成 pi 原生形态。

## 1. 已确认的决策

| 项         | 决策                                                                 |
| ---------- | -------------------------------------------------------------------- |
| 通道范围   | codex / grok / openai（不含 openrouter）                             |
| 架构       | 自包含 tool；不注册 pi image model                                   |
| 产出       | 保存 PNG 到 `<cwd>/generated/` 并返回路径，同时内联返回 `ImageContent` |
| 参考图     | 第一版就支持（不含 mask）                                            |
| 形态       | 多文件 pi package（`pi` manifest + `src/`）                          |
| 入口       | 插件自己的 `/image-gen` 命令                                          |
| 核心密钥   | **完全自持**：Codex / Grok 的 OAuth 与可选的 OpenAI Key 都存在插件自己的 auth 文件 |
| OpenAI Key | `OPENAI_API_KEY` 环境变量优先，文件回退                              |
| 通道选择   | 默认通道 + 优先级链自动选；静态 description + 报错纠正；冲突不换通道 |

## 2. 为什么是自包含 tool

调研结论（pi 0.99.2）：

- pi 已经有图像生成基础设施：`ModelType: "image"`、`ctx.modelRegistry.generateImages()`、
  `pi.registerProvider({ models: [{type:"image"}], images: { [api]: { generateImages } } })`。
- 但内置的 image API 只有 `openrouter-images`（`IMAGE_MODELS.openrouter` 有 flux 等，其余 provider 为空）。
  **openai / codex / grok 的生图端点都没有实现** —— 这才是插件的价值。
- `registerProvider` 带 `models` 时会**整体替换**该 provider 的模型列表（`dist/core/provider-composer.js:171-177`），
  给 `openai-codex` 加 image model 必须重建 chat 模型列表；而 `oauth.toAuth()` 只返回
  `{ apiKey: credential.access }`，表达不了 Codex 生图需要的 `ChatGPT-Account-ID` header。
  → 注册 image model 的收益不足以抵消这两处成本。
- pi 本身也是从 access token 的 JWT 里解析 `chatgpt_account_id`
  （`pi-ai/dist/api/openai-codex-responses.js:1271`），插件可以用同样的办法。
- pi 的 tool result 支持 `ImageContent`（`{ type: "image", data, mimeType }`），且 pi 会按当前 chat 模型的
  `inputLimits.images.resize` 自动压缩 tool-result 图片。

结论：注册一个 `image_gen` tool，通道实现自持 HTTP，凭据能复用 pi 的（codex）就复用，其余自建。

## 3. 目录结构

```text
pi-image-gen/
├── package.json                 # pi manifest（extensions 指向 src/extension.ts）+ peerDependencies
├── tsconfig.json
├── DESIGN.md                    # 本文
├── README.md                    # 用户向：安装、登录、参数速查
├── src/
│   ├── extension.ts             # 工厂：注册 tool + /image-gen 命令
│   ├── tool.ts                  # image_gen 的 schema / execute / details / renderResult
│   ├── config.ts                # 默认模型、输出目录、通道解析
│   ├── channels/
│   │   ├── types.ts             # Channel 契约、能力约束、GenerateInput/GenerateOutput
│   │   ├── openai.ts            # API Key 通道
│   │   ├── codex.ts             # ChatGPT 后端通道（pi 凭据）
│   │   └── grok.ts              # x.ai 通道
│   ├── auth/
│   │   ├── store.ts             # 插件 auth.json：0600/0700、跨进程锁、原子写
│   │   ├── codex.ts             # Codex PKCE 登录 + 本地回调 + token 刷新
│   │   └── grok.ts              # x.ai device code 登录 + token 刷新
│   └── util/
│       ├── image.ts             # MIME 探测、PNG 校验、data URL、尺寸/字节上限
│       ├── errors.ts            # 上游错误 → 本地固定文案
│       └── limits.ts            # 响应体读取上限、超时
└── tests/
    ├── channels.test.ts         # 三条通道的请求构造与响应解析（mock fetch）
    ├── auth.test.ts             # 存储锁/权限/原子写、grok 轮询、JWT 解析
    ├── tool.test.ts             # schema 校验、能力约束、输出路径
    └── errors.test.ts           # 错误映射
```

`package.json` 要点：

```json
{
  "name": "pi-image-gen",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./src/extension.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  }
}
```

宿主提供的包只放 `peerDependencies`，不打包、不放 `dependencies`。tool 的 `parameters` 用 TypeBox（宿主机提供），
上游响应校验用 TypeBox 的 `Value.Check`，不引入 zod。

## 4. `image_gen` tool

```ts
pi.registerTool({
  name: "image_gen",
  label: "Generate Image",
  description: "...",
  promptSnippet: "Generate an image from a text prompt (and optional reference images).",
  parameters: T.Object({ ... }),
  executionMode: "sequential",   // 通道有并发闸门，见 §5.6
  annotations: { openWorldHint: true, idempotentHint: false },
  renderCall: (args, theme, ctx) => { ... },     // 折叠提示词首行；展开完整提示词 + 非默认参数
  renderResult: (result, options, theme, ctx) => { ... }, // 折叠摘要 + 前 3 条路径；展开全部
  execute: async (toolCallId, params, signal, onUpdate, ctx) => { ... },
});
```

### 4.1 参数

| 参数          | 类型 / 取值                                                        | 说明 |
| ------------- | ------------------------------------------------------------------ | ---- |
| `prompt`      | string，1–12000，去空白后非空                                      | 必填 |
| `provider`    | `"codex" \| "grok" \| "openai"`                                  | 省略时按优先级链自动选择，见 §4.3 |
| `model`       | string                                                             | 省略时用该通道默认模型 |
| `n`           | int 1–10                                                           | codex 只能 1；grok 1–10；openai 1–10 |
| `size`        | `"auto"` 或 `WxH`                                                  | openai 与 codex 通道 |
| `quality`     | `auto\|low\|medium\|high\|xhigh\|max`                              | openai 全量；codex 到 `high`；grok 到 `medium` |
| `background`  | `auto\|transparent\|opaque`                                        | openai 与 codex 通道 |
| `aspectRatio` | 见 ai-canvas `ASPECT_RATIOS`                                       | 仅 grok 通道 |
| `resolution`  | `1k\|1.5k\|2k`                                                     | 仅 grok 通道 |
| `references`  | string[]，本地图片路径，最多 5（openai 可放宽到 16）               | 参考图 → `/images/edits` |
| `outputPath`  | string                                                             | 覆盖输出文件或目录；默认 `<cwd>/generated/` |
| `returnImage` | boolean，默认 `true`                                               | 是否内联返回 `ImageContent` |

放错通道的参数不静默丢弃：要么报错，要么在返回文案里说明该参数被忽略（与 ai-canvas 的
「不降级、不静默丢弃」原则一致）。

### 4.2 返回

```ts
{
  content: [
    { type: "text", text: "Generated 1 image(s) with codex / gpt-image-2 in 3.2s:\n- /abs/path/generated/xxx.png" },
    { type: "image", data: "<base64>", mimeType: "image/png" },   // returnImage 为 false 时省略
  ],
  details: { paths, provider, model, imageCount, upstreamMs, warnings, usage? },
  structuredContent: { ...同 details },
}
```

- `outputSchema` + `structuredContent` 一起给，codemode 脚本可以直接拿到结构化结果。
- 图片内联给模型看，路径给人和后续工具用；`truncated-tool` 式的体积控制交给 pi 的 `inputLimits`。
- 多张图：`content` 里放多张 `ImageContent`，但设上限（例如默认最多内联 4 张，其余只给路径），避免上下文爆炸。
- **面向用户与模型的文案统一用英文**（工具结果、错误文案、命令输出、登录指引）；中文只保留在代码注释与
  文档里。上游错误也先在本机判定，再输出英文固定文案，原文不外泄。

### 4.3 通道选择

工具**静态注册一次**，不做随登录状态变化的动态刷新：`description` 写清三条通道、默认优先级与各自能力差异，
`provider` 的 enum 列出全部三个可选值。

省略 `provider` 时的解析顺序，取第一个「已配置」的通道：

1. 配置文件的 `defaultProvider`（`/image-gen default` 写入）；
2. 配置文件的 `providerOrder`；
3. 内置顺序 `codex → grok → openai`。

「已配置」的判定：三条通道都只看插件自己的凭据文件（codex / grok 的 OAuth、openai 的 key），
外加 `OPENAI_API_KEY` 环境变量。**不读 pi 的登录状态。**

三条边界：

- **指定了未配置的通道** → 报错，并列出当前可用通道及各自的登录方式，让模型一次往返就能纠正。
- **一个可用通道都没有** → 报错，提示 `/image-gen login grok` 或 `/image-gen key`。
- **参数与通道能力冲突** → 报错并写明哪个通道支持（例如 `codex generates at most 1 image(s) per
  request (asked for n=4). Supported by: grok, openai.`），**不自动换通道**。codex / grok 走订阅、openai 是付费 Key，静默切换等于替用户花钱；生成失败也
  **不重试、不降级到其它通道**。

结果里始终回报实际使用的通道与模型，让用户看得出这次花的是订阅还是 API Key。

## 5. 通道实现

三者共用 `Channel` 契约（`src/channels/types.ts`）：

```ts
interface Channel {
  id: "codex" | "grok" | "openai";
  defaultModel: string;
  capabilities: { maxImages: number; maxReferenceImages: number; qualities: string[] };
  isConfigured(ctx): Promise<boolean>;
  generate(input: GenerateInput, ctx, signal): Promise<GenerateOutput>;
}
interface GenerateOutput { images: Uint8Array[]; model: string; upstreamMs: number; usage?: Usage }
```

所有通道统一：只接受 `b64_json` 字节，绝不下载上游返回的 `url`（SSRF）；响应体读取设上限。

### 5.1 codex（自持 OAuth）

- 凭据：插件自己的 `codex` 条目，由 `/image-gen login codex` 写入（PKCE + 本地回调 `127.0.0.1:1455`）。
  **不复用 pi 的登录**，理由见 §6.1。
- accountId：登录/刷新后从 access token 的 JWT 本地解析 `https://api.openai.com/auth` → `chatgpt_account_id`
  （兼容顶层字段）。
- 端点：无参考图 `POST https://chatgpt.com/backend-api/codex/images/generations`；有参考图 `.../images/edits`。
- Headers：`Authorization: Bearer <access>`、`ChatGPT-Account-ID: <accountId>`、
  `originator: codex_cli_rs`、`x-codex-image-turn-id: <randomUUID>`。
- 参考图用 **JSON** `images: [{ image_url: "data:image/png;base64,..." }]`，不是 multipart。
- 请求体：`model`、`prompt`、`size`、`quality`、`background`（缺省一律补 `auto`），有参考图时加 `images`。
- **不发送 `n`、不发送 `moderation`**。
- 本地能力校验（触达上游之前）：`n !== 1` → 400；参考图 > 5 → 400；`quality` 超出
  `auto|low|medium|high` → 400；不支持 mask。

### 5.2 grok

- 端点：`https://api.x.ai/v1/images/generations`（无参考图）/ `/images/edits`（有参考图）。
- Headers：`Authorization: Bearer <access>`、`x-xai-token-auth: xai-grok-cli`。
- 请求体：`{ model, prompt, n, response_format: "b64_json", image? | images?, aspect_ratio?, resolution? }`；
  无参考图且未指定 `aspect_ratio` 时补 `aspect_ratio: "auto"`。
- 参考图元素 `{ type: "image_url", url: "data:..." }`；单张用 `image`、多张用 `images`。
- **WebP 参考图直接拒绝**（`supportsWebpReferences: false`）：转码需要引入图像解码器，而 coding agent 的参考图
  基本是 PNG/JPEG；拒绝比静默失败好，错误文案会写明原因。
- 能力：每次 1–10 张、参考图 ≤ 5、`quality` 到 `medium`、`resolution` `1k|1.5k|2k`、不支持 mask。

### 5.3 openai（API Key）

- Key 解析顺序（取第一个可用的）：`process.env.OPENAI_API_KEY` → 插件 auth 文件的 `openai` 条目。
- **不复用 pi 的 ChatGPT 订阅凭据**（provider `openai`）：实测被服务端硬边界拦住，
  `POST /v1/images/generations` 返回 `401 hardened_oauth_rule_missing`，
  chatgpt 生图端点返回 `401 no_matching_rule`；且它的 `GET /v1/models` 返回的是 ChatGPT 内部的
  `{models:[{slug:…}]}` 结构而非标准 `{data:[…]}`。接上它只会让状态显示“已配置”而实际必顶 401。
  代码里把这段结论写在 `channels/openai.ts` 的 `resolveOpenAiApiKey` 注释里，避免后人重试。
- 无参考图：JSON `POST {baseUrl}/images/generations`；有参考图：multipart `POST {baseUrl}/images/edits`，
  参考图按顺序以 `image[]` 追加。`baseUrl` 默认 `https://api.openai.com/v1`，可用 `OPENAI_BASE_URL` 覆盖。
- 请求字段：`model`、`prompt`、`n`、`size`、`quality`、`background`、`moderation`。
- 请求头：`Authorization: Bearer <key>`、`Accept: application/json`。
- 只接受 `data[].b64_json`（PNG/JPEG/WebP 按字节探测）；上游少给图片按实际张数返回（不重发、不降级）；
  `data` 为空才 502。

### 5.4 参考图处理

- 读文件后校验 MIME 与体积；总量上限（grok 5 张 / 40 MB，codex 5 张，openai 16 张）。
- 相对路径按 `ctx.cwd` 解析；不跟随符号链接到工作目录之外不做特殊限制（本地工具，与 pi 的 read 一致）。
- 第一版不做 crop / mask；`crop`、`mask` 参数直接拒绝并说明。

### 5.5 超时与并发

- 每通道超时默认 180s（`imageTimeoutMs`），`n` 张不做线性放大（与 ai-canvas 的 `× n` 不同，因为 tool 是单次调用）。
- 插件内并发闸门：同时最多 2 个生成任务，超出直接报错（不排队），避免烧额度。

### 5.6 错误映射

照搬 `docs/generation.md` §7 的映射表，但落成 tool 的失败结果（`throw` 出错误 → pi 记成 failed tool result）：

| 上游条件                       | 本地文案                       |
| ------------------------------ | ------------------------------ |
| 审核拦截                       | 提示调整提示词或参考图         |
| 参数不支持                     | 写明参数名                     |
| 额度不足 / 429                 | 账户额度不足 / 稍后重试        |
| 鉴权失败 401 / 403             | 检查凭据；codex 提示重新登录   |
| 404 / model_not_found          | 检查 model 名称                |
| 5xx                            | 上游暂时不可用                 |
| 超时                           | 请求超时                       |
| 网络失败                       | 无法连接上游                   |
| 未识别                         | 通用文案 + `code` / `requestId` |

不把上游原文、提示词、密钥写进结果或日志；日志只记状态码、`code`、`requestId`、耗时。
**不自动重试**（可能产生费用），失败也不换通道降级。

## 6. 凭据与授权

### 6.1 codex：为什么自持而不用 pi 的登录

pi 里同时存在两个 OpenAI OAuth，语义重叠且都不能直接用：

| provider       | 登录项                          | token 里有 account id | 能生图 |
| -------------- | ------------------------------- | --------------------- | ------ |
| `openai`       | OpenAI (ChatGPT subscription)   | ❌                    | ❌（实测 401 `hardened_oauth_rule_missing`） |
| `openai-codex` | OpenAI (ChatGPT Plus/Pro)       | ✅                    | 未验证，且 pi 已标为 legacy |

更关键的是：这两个 provider 与「生图」是两套不同的授权语义，混在一起后「到底认到哪份凭据」会变得
很难查（本项目就为此排查了一整轮）。所以改成与 ai-canvas 一致：用 Codex CLI 的公开 client
（`app_EMoamEEZ…`）自己走一遍 PKCE，凭据落在自己的 `codex` 条目里。

代价是要多登录一次；换来的是：不依赖 pi 的 provider 语义、不受其 legacy 状态影响、状态一目了然。

### 6.2 插件 auth 文件

路径 `~/.pi/agent/image-gen/auth.json`（可用 `PI_IMAGE_GEN_AUTH_FILE` 覆盖），目录 `0700`、文件 `0600`：

```jsonc
{
  "version": 1,
  "providers": {
    "codex":  { "type": "oauth", "access": "...", "refresh": "...", "expires": 0, "accountId": "..." },
    "grok":   { "type": "oauth", "access": "...", "refresh": "...", "expires": 0 },
    "openai": { "type": "api_key", "key": "sk-..." }
  }
}
```

读改写：`<file>.lock` 跨进程锁（等待 10s、10min 视为过期、30s 心跳）+ 临时文件 `rename` 原子替换；
损坏文件不自动覆盖，直接报错。照搬 `server/authStorage.ts` 的语义与测试。

### 6.3 grok device code 登录

端点与参数照搬 `scripts/grok-image-probe.ts`：

- `POST https://auth.x.ai/oauth2/device/code`，`{ client_id, scope }` → `user_code` + `verification_uri_complete`
- 轮询 `POST https://auth.x.ai/oauth2/token`，`{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", ... }`，
  处理 `authorization_pending` / `slow_down` / 超时
- 刷新：`{ grant_type: "refresh_token", refresh_token, client_id }`
- 校验 `verification_uri` 必须是 https 且主机在白名单内，防被上游塞任意链接

device code 与 user code 通过 `ctx.ui` 展示（TUI 用 `ctx.ui.custom` 或 `notify` + `confirm`；
非交互模式只提示 URL 与 code，让用户自己完成）。

### 6.4 `/image-gen` 命令

登录时会**自动在系统浏览器里打开授权页**（`util/browser.ts`，实现与 pi 的 `utils/open-browser` 一致）：

- 不经过 shell —— Windows 上不能用 `cmd /c start`，cmd.exe 会先重新解析 URL 里的 `&`、`|`、`^`。
- 尽力而为：启动器失败只记一个 error 事件，不抛错；URL 始终会显示出来当兼底。
- SSH 会话与无显示服务器的 Linux 不尝试打开（打开的会是服务器那侧），直接给 URL。
- Grok 的 device code 用的是 `verification_uri_complete`（已含 user code），所以通常不用手输。

| 子命令                     | 行为                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `/image-gen`（无参数）     | 状态总览：三条通道是否可用、凭据来源、凭据是否过期             |
| `/image-gen login codex`   | PKCE + 本地回调 `127.0.0.1:1455`，展示授权链接                  |
| `/image-gen login grok`    | device code 流程，展示 code + URL                              |
| `/image-gen login`         | 无参数：弹出选择界面（codex / grok / OpenAI API key，与 pi 的 `/login` 一致） |
| `/image-gen login openai`  | 进入 API Key 输入框（省略 Key 时）                              |
| `/image-gen key [value]`   | 设置 OpenAI Key（无 value 时用 `ctx.ui` 输入，输入内容不回显）  |
| `/image-gen logout <id>`   | 删除对应凭据（codex / grok / openai）                           |
| `/image-gen logout`        | 无参数：列出已存凭据供选择（环境变量不在此列）                  |
| `/image-gen default <id>`  | 设置默认通道（写插件配置）                                      |

命令通过 `getArgumentCompletions` 提供 Tab 补全，不带参数时用 `ctx.ui.select` 弹选择界面；
两者并存，带参数的形式保留给非交互模式。补全的契约：回调收到的是**光标前的完整参数串**
（如 `"login c"`），且返回项的 `value` **替换整串** —— 所以二级候选必须给出 `"login codex"`，
只给 `"codex"` 会把前面的 `login` 吃掉。

命令在 `ctx.mode !== "tui"` 时降级为纯文本提示，不做自定义渲染。
凭据正文永不进 UI 回显、不进响应、不进日志。

## 7. 配置

`~/.pi/agent/image-gen/config.json`（可选）：

```jsonc
{
  "defaultProvider": "codex",
  "providerOrder": ["codex", "grok", "openai"],
  "outputDir": "generated",            // 相对 cwd
  "timeoutMs": 180000,
  "maxConcurrent": 2,
  "inlineImages": 4,                   // 最多内联几张
  "models": { "codex": "gpt-image-2", "grok": "grok-imagine-image-2.0", "openai": "gpt-image-2" }
}
```

默认值内联在代码里，文件不存在也能跑。tool 参数优先级：tool 参数 > 配置文件 > 内置默认。

## 8. 安全边界

- 凭据只存插件 auth 文件或复用 pi 的，不回显、不落日志、不写进 tool result。
- 绝不下载上游返回的 `url`；只接受 base64 字节并做签名/格式校验。
- 上游响应体上限 30 MiB（×n 时按通道实际张数计）。
- device code 的 `verification_uri` 白名单校验。
- 不自动重试、不自动降级、不自动切换通道。
- 生成的文件 `0600`。

## 9. 测试

全部 mock `fetch`，**不发起真实 OAuth 或生图请求、不产生费用**：

- `channels.test.ts`：三条通道的 URL/headers/body（含 codex 的 JSON 参考图、openai 的 multipart）、
  参数能力约束、响应解析（`b64_json`、缺图、空 data、非 PNG、超大响应）。
- `auth.test.ts`：存储的锁/权限/原子写/损坏文件 fail closed。
- `codex-auth.test.ts`：PKCE、授权 URL 参数、回调校验（state/error/方法/路径）、完整登录流程（真实回调）、
  端口占用、刷新与写回。
- `grok-auth.test.ts`：device code 轮询状态机、刷新、授权网址白名单。
- `tool.test.ts`：schema 校验、通道自动选择与歧义报错、输出路径解析、`returnImage` 行为。
- `errors.test.ts`：错误映射表逐条。
- 手动验证（可选脚本）：`scripts/probe.ts` 用真实凭据各通道跑一张最小图，需要人工显式调用。

## 10. 分阶段实现（已完成）

1. ✅ **骨架 + openai 通道**：package.json / extension 工厂 / tool schema / `util/` / auth store /
   openai 通道 / 保存 + 内联返回 / 测试。
2. ✅ **codex 通道**：pi 凭据桥接 + JWT accountId + 能力约束 / 测试。
3. ✅ **grok 通道 + 登录**：device code 登录、刷新 / 测试。
4. ✅ **`/image-gen` 命令**：status / login / key / logout / default / 测试。
5. ✅ **收尾**：README、`.gitignore`、`npm run verify`（typecheck + 149 测试 + 真实加载器冒烟）。

### 与 ai-canvas 的有意差异

对照 `docs/features/{openai,codex,grok}-images.md` 逐参数核对后，以下三处是**故意不同**的，不是遗漏：

1. **Grok 的 WebP 参考图直接拒绝**（ai-canvas 会解码后转 PNG）。转码需要引入原生图像解码器
   （sharp / @napi-rs/canvas），而 Pi 的 local package 不自动装依赖，用户得自己 `npm install`。
   coding agent 的参考图基本都是 PNG/JPEG，报错比带一个重依赖便宜。
2. **`background` 省略时不发送**（ai-canvas 会解析成 `opaque` 再发）。它的场景是界面上的「透明背景」
   开关，关掉就是 `opaque`；我们的场景是参数化的工具调用，省略就不发、让上游用默认值更可预期。
3. **不做 mask**（ai-canvas 的 OpenAI API Key 通道支持 `references[0].mask`）。这是第一版就定下的范围，
   三条通道的 `capabilities` 里都没有 mask 字段，传了会被 schema 拒绝。

另：`moderation` 默认值与 ai-canvas 一致取 `low`（它的规则是「请求值 → 项目设置 → low」；
我们没有“项目设置”这一层）。

### 实现与原设计的差异

- **codex 也支持 `size` / `background`**。原设计写的是「仅 openai」，重新读 ai-canvas 的 `codexImageBody`
  后确认它确实会透传这两个字段，已同步修正描述与能力表。
- **Grok 的 WebP 参考图直接拒绝**，不做内存转 PNG。转码需要引入图像解码器；coding agent 的参考图
  基本都是 PNG/JPEG，明确拒绝比隐式失败好。
- **新增 `channels/request.ts` 与 `channels/response.ts`**：三个通道的超时、错误映射、响应上限、
  `b64_json` 解析完全一致，抽出来避免三份实现漂移。
- **`scripts/smoke.ts`**：用 pi 真实的 `loadExtensions` 验证模块能被 jiti 解析且工具/命令注册成功，
  不调用模型、不花钱，适合当作 `verify` 的一环。
- **参考图合计字节上限改到 `assertCapabilities` 里判定**：最初写在 runner 且取了所有通道的最大值，
  等于永远用最宽松的通道 —— 是个真 bug，已有回归测试。

## 11. 待确认 / 开放问题

1. Codex 生图端点对 `gpt-image-2` 之外的模型是否可用、是否接受 `output_format`。
2. 自定义 TUI 渲染已实现（见 §4）：`renderCall` 折叠显示提示词首行、展开显示完整提示词与非默认
   参数；`renderResult` 折叠显示图片数 / 通道 / 耗时与前三条路径，展开补齐 warning 与 usage。
   `ctrl+o`（`app.tools.expand`）与鼠标点击共用同一个 `expanded` 状态。
3. `openai-codex` 登录在 pi 里标为 legacy；本插件已改成自持 OAuth，不再受这个状态影响。
   但如果未来 Codex CLI 的公开 client（`app_EMoamEEZ…`）被回收，需要换 client 或改用其他通道。

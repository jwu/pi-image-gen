# pi-image-gen

给 coding agent 用的图片生成工具：在 pi 里注册一个 `image_gen` 工具，让模型直接生图。

三条通道，按你的订阅/Key 自由选择：

| 通道     | 上游                                    | 凭据                                                    |
| -------- | --------------------------------------- | ------------------------------------------------------- |
| `codex`  | `chatgpt.com/backend-api/codex/images/*` | 插件自己的 ChatGPT OAuth（`/image-gen login codex`）      |
| `grok`   | `api.x.ai/v1/images/*`                  | 插件自己的 x.ai 设备码登录（`/image-gen login grok`）     |
| `openai` | `{OPENAI_BASE_URL}/images/*`            | `OPENAI_API_KEY` 环境变量，或插件保存的 Key              |

凭据**完全由本插件自己维护**（`<agent-dir>/image-gen/auth.json`），与 pi 的 `/login` 互不干扰。

## 安装

```bash
# 本地试用，不写任何配置
pi -e /path/to/pi-image-gen

# 或作为包安装
pi install ./pi-image-gen
```

装好后：

- 让 agent「生成一张 XXX 的图」→ 模型调用 `image_gen`
- `/image-gen` 查看通道状态

## 先用起来

**Codex（用 ChatGPT 订阅生图）**：

```
/image-gen login codex
```

会启动一个本地回调服务（`127.0.0.1:1455`）并**自动在浏览器里打开授权页**，登录完成后会自动回到本机。
用的是 Codex CLI 的公开 client（PKCE），凭据存在插件自己的文件里。

> 端口 1455 如果被 Codex CLI 占着，会直接报错并告诉你是这个原因 —— 关掉那个进程再试。
> 回调地址是 `127.0.0.1`，记得让代理软件把它排除在外（`NO_PROXY`），否则回调可能被代理拦掉。

**Grok（x.ai 订阅）**：

```
/image-gen login grok
```

会自动打开授权页面，确认页面上显示的代码即可（链接里已经带上了 code，通常不用手输）。
因为是 device code 流程，**这个链接在另一台设备上打开也行** —— 比如在服务器上跑 pi 时，
可以用自己电脑的浏览器完成授权。

**OpenAI API Key**：

```
/image-gen login          # 选单里选 “OpenAI API key”
/image-gen login openai   # 同上，直接进入输入框
/image-gen key sk-...     # 快捷方式，适合脚本
```

也可以直接用 `OPENAI_API_KEY` 环境变量（优先级最高）：`OPENAI_API_KEY` → 插件凭据文件。

## 通道能力对照

|                        | codex        | grok         | openai        |
| ---------------------- | ------------ | ------------ | ------------- |
| 单次张数 `n`           | 仅 1         | 1–10         | 1–10          |
| 参考图                 | ≤ 5          | ≤ 5          | ≤ 16          |
| `size`                 | ✅           | —            | ✅            |
| `quality`              | 到 `high`    | 到 `medium`  | 全部          |
| `background`           | ✅           | —            | ✅            |
| `moderation`           | —（不发）    | —（不发）    | ✅（默认 low）|
| `aspectRatio`          | —            | ✅           | —             |
| `resolution`           | —            | ✅           | —             |
| WebP 参考图            | ✅           | ❌（自己转） | ✅            |
| 计费                   | 订阅额度     | 订阅额度     | **按量付费**  |

参数与通道不匹配时**直接报错**，并告诉你哪个通道支持，不会静默换通道 —— 因为从订阅通道悄悄切到
付费 Key 等于替你花钱。

## 工具参数

| 参数          | 说明                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `prompt`      | 必填，1–12000 字                                                      |
| `provider`    | `codex` / `grok` / `openai`；省略时按 `codex → grok → openai` 选第一个已配置的 |
| `model`       | 覆盖该通道的默认模型                                                  |
| `n`           | 生成几张                                                              |
| `size`        | `auto` 或 `1024x1024`（单边 ≤3840、16 的倍数、比例 1:3–3:1）           |
| `quality`     | `auto` / `low` / `medium` / `high` / `xhigh` / `max`                  |
| `background`  | `auto` / `transparent` / `opaque`                                     |
| `moderation`  | `auto` / `low`；**仅 openai 通道**，省略时会发 `low`                 |
| `aspectRatio` | 如 `16:9`（grok）                                                     |
| `resolution`  | `1k` / `1.5k` / `2k`（grok）                                          |
| `references`  | 参考图路径数组（图生图/编辑）                                          |
| `outputPath`  | 目录，或带图片扩展名的文件路径；默认 `<cwd>/generated/`                |
| `returnImage` | 是否把图片内联返回给模型看，默认 `true`                                |

生成的文件按实际格式落盘（`.png` / `.jpg` / `.webp`），权限 `0600`，路径会写进工具结果。

## 配置（可选）

`<agent-dir>/image-gen/config.json`，默认目录是 `~/.pi/agent/`：

```jsonc
{
  "defaultProvider": "codex",              // 省略 provider 时的首选
  "providerOrder": ["grok", "openai"],     // 其次的尝试顺序
  "outputDir": "generated",                // 相对 cwd
  "timeoutMs": 180000,
  "maxConcurrent": 2,
  "inlineImages": 4,                       // 最多内联几张给模型
  "models": { "codex": "gpt-image-2" }
}
```

优先级：工具参数 > 配置文件 > 内置默认。

常用环境变量：

| 变量                      | 作用                                    |
| ------------------------- | --------------------------------------- |
| `OPENAI_API_KEY`          | OpenAI 通道的 Key（优先于插件凭据文件） |
| `OPENAI_BASE_URL`         | 中转地址，默认 `https://api.openai.com/v1` |
| `PI_CODING_AGENT_DIR`     | 改 agent 目录                           |
| `PI_IMAGE_GEN_CONFIG_FILE`| 直接指定 config.json 路径               |
| `PI_IMAGE_GEN_AUTH_FILE`  | 直接指定凭据文件路径                    |

## 命令

| 命令                            | 作用                          |
| ------------------------------- | ----------------------------- |
| `/image-gen`                    | 查看三条通道的状态与凭据来源  |
| `/image-gen login`              | 选择通道登录或粘贴 API Key（codex / grok / openai）|
| `/image-gen login codex`        | 直接登录 Codex（脚本/非交互场景用）    |
| `/image-gen login grok`         | 设备码登录 Grok               |
| `/image-gen login openai sk-...`| 直接存入 OpenAI Key           |
| `/image-gen key [sk-...]`       | `login openai` 的快捷方式     |
| `/image-gen logout`             | 列出已存凭据供选择删除        |
| `/image-gen logout <codex\|grok\|openai>` | 直接删除指定凭据   |
| `/image-gen default [通道]`     | 设置默认通道                  |

`/image-gen` 支持 Tab 补全：输入 `/image-gen ` 后按 Tab 列出子命令，`login` / `logout` / `default`
后面继续按 Tab 会列出通道名。（`key` 后面是自由输入，不补全。）

不带参数时，`login` 与 `logout` 会弹出选择界面（与 pi 的 `/login` 一致）；带参数的形式仍然保留，
方便在非交互模式下使用。不带参数的 `logout` 只列出插件自己存下来的凭据 —— `OPENAI_API_KEY`
环境变量不归它管。

## 网络与代理

pi 用 `undici.EnvHttpProxyAgent` 装了**全局 HTTP dispatcher**，所以只要代理在 pi 进程的环境里，插件发出的请求会自动走它：

```jsonc
// ~/.pi/agent/settings.json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

或者在启动 pi 的终端里 `export HTTPS_PROXY=...`。二者等效 —— `httpProxy` 也只是被写进 `HTTP_PROXY` / `HTTPS_PROXY`。

注意：Node 原生的 `fetch` **不会**自己读这两个环境变量（除非 Node 24+ 开了 `NODE_USE_ENV_PROXY=1`）。插件之所以能走代理，是因为 pi 装了全局 dispatcher；如果哪天直接拿这个包在裸 Node 里跑，需要自己配。

## 安全与成本

- 凭据只存两处：插件自己的 `<agent-dir>/image-gen/auth.json`（目录 `0700`、文件 `0600`、跨进程锁 +
  原子写），以及可选的 `OPENAI_API_KEY` 环境变量。任何提示、日志、工具结果都不回显凭据正文。
- **不碰 pi 的登录**：不读也不写 `~/.pi/agent/auth.json`，登录/退出完全走 `/image-gen`。
- **只接受上游返回的 base64 图片**。上游若只给 `url`，一律拒绝 —— 不下载任意 URL。
- **不自动重试、不自动降级、不自动换通道**。失败就是失败，避免重复计费。
- 有并发闸门（默认同时 2 个任务），超出直接报错。
- 错误只映射成本地固定文案，上游原文不外泄；`code` / `requestId` / `upstreamMs` 会照实回显，便于排查。

## 开发

```bash
npm run verify   # typecheck + 全部测试 + 真实 pi 加载器冒烟
```

测试全部使用假 `fetch` 与临时凭据文件，**不发起真实请求、不产生费用**。

设计文档见 [DESIGN.md](./DESIGN.md)。

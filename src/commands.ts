/**
 * `/image-gen` 命令：查看通道状态、登录 Grok、保存 OpenAI Key、设置默认通道。
 *
 * 三条约束：
 * - **凭据正文永不回显**：既不显示已存的 Key，也不把它写进任何提示文本。
 * - 非交互模式（print / json）没有可用 UI，降级成纯文本通知，不做自定义渲染。
 * - Codex 的凭据属于 pi，这里只管读取状态；要退出请在 pi 里用 `/logout`。
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { CodexAuth } from "./auth/codex.ts"
import { GrokAuth } from "./auth/grok.ts"
import type { ImageGenAuthStore } from "./auth/store.ts"
import type { Channel, ChannelDeps, ProviderId } from "./channels/types.ts"
import { PROVIDER_IDS } from "./channels/types.ts"
import { OPENAI_KEY_SOURCE_LABELS, detectOpenAiKeySource } from "./channels/openai.ts"
import { loadConfig, resolveConfigPath, updateConfig, type ImageGenConfig } from "./config.ts"
import { ImageGenError } from "./util/errors.ts"
import { openBrowser } from "./util/browser.ts"

export interface ImageGenCommandOptions {
  channels: readonly Channel[]
  store: ImageGenAuthStore
  grokAuth: GrokAuth
  codexAuth: CodexAuth
  createDeps: (ctx: ExtensionContext, config: ImageGenConfig) => ChannelDeps
  /** 打开授权链接。测试注入假实现，避免真去启动浏览器。 */
  openBrowser?: (url: string) => boolean
}

const USAGE = [
  "Usage:",
  "  /image-gen                            show channel status",
  "  /image-gen login [codex|grok|openai]  sign in / save a key (prompts when omitted)",
  "  /image-gen logout [codex|grok|openai] remove stored credentials (prompts when omitted)",
  "  /image-gen default [channel]          set the default channel (codex / grok / openai)",
  "  /image-gen key [sk-...]               shortcut for `login openai`",
].join("\n")

function parseProvider(value: string | undefined): ProviderId | undefined {
  if (value === undefined) return undefined
  return (PROVIDER_IDS as readonly string[]).includes(value) ? (value as ProviderId) : undefined
}

// ---------------------------------------------------------------------------
// Tab 补全
// ---------------------------------------------------------------------------

interface Completion {
  value: string
  label: string
  description?: string
}

const SUBCOMMANDS: readonly Completion[] = [
  { value: "status", label: "status", description: "Show channel status" },
  { value: "login", label: "login", description: "Sign in to Codex or Grok" },
  { value: "key", label: "key", description: "Save an OpenAI API key" },
  { value: "logout", label: "logout", description: "Remove a stored credential" },
  { value: "default", label: "default", description: "Set the default channel" },
]

const LOGIN_TARGETS: readonly Completion[] = [
  { value: "codex", label: "codex", description: "ChatGPT subscription" },
  { value: "grok", label: "grok", description: "x.ai subscription" },
  { value: "openai", label: "openai", description: "OpenAI API key" },
]

const CHANNEL_TARGETS: readonly Completion[] = [
  { value: "codex", label: "codex", description: "ChatGPT subscription" },
  { value: "grok", label: "grok", description: "x.ai subscription" },
  { value: "openai", label: "openai", description: "OpenAI API key" },
]

/**
 * Tab 补全。
 *
 * 收到的 `argumentText` 是**光标前的完整参数串**（例如 `"login c"`），而且返回项的 `value`
 * 会替换整串 —— 所以二级补全必须给出 `"login codex"`，只给 `"codex"` 会把前面的 `login` 吃掉。
 */
export function completeImageGenArguments(argumentText: string): Completion[] | null {
  const lastSpace = argumentText.lastIndexOf(" ")

  // 还没输入空格：补全子命令。
  if (lastSpace === -1) {
    const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(argumentText))
    return matches.length > 0 ? [...matches] : null
  }

  const head = argumentText.slice(0, lastSpace).trim()
  const partial = argumentText.slice(lastSpace + 1)

  let targets: readonly Completion[]
  switch (head) {
    case "login":
      targets = LOGIN_TARGETS
      break
    case "logout":
    case "default":
      targets = CHANNEL_TARGETS
      break
    // `key` 后面是自由输入的密钥，不做补全。
    default:
      return null
  }

  const matches = targets
    .filter((item) => item.value.startsWith(partial))
    .map((item) => ({
      value: `${head} ${item.value}`,
      label: item.value,
      ...(item.description !== undefined ? { description: item.description } : {}),
    }))
  return matches.length > 0 ? matches : null
}

async function statusText(options: ImageGenCommandOptions, ctx: ExtensionContext): Promise<string> {
  let config: ImageGenConfig
  try {
    config = await loadConfig()
  } catch (error) {
    return error instanceof ImageGenError ? error.message : "Could not read the config."
  }

  const deps = options.createDeps(ctx, config)
  const lines: string[] = ["Image channels:"]

  for (const channel of options.channels) {
    const configured = await channel.isConfigured(deps).catch(() => false)
    if (channel.id === "openai") {
      // 只回报来源，从不回报内容。
      const source = await detectOpenAiKeySource(deps).catch(() => "none" as const)
      const detail =
        source === "none"
          ? `not configured - ${channel.loginHint}`
          : `configured (${OPENAI_KEY_SOURCE_LABELS[source]})`
      lines.push(`- openai: ${detail}`)
      continue
    }
    if (channel.id === "grok") {
      const status = await options.grokAuth.status().catch(() => ({ configured: false, expired: false }))
      const detail = status.configured
        ? status.expired
          ? "signed in (credential expired; refreshes on next generation)"
          : "signed in"
        : `not signed in - ${channel.loginHint}`
      lines.push(`- grok: ${detail}`)
      continue
    }
    if (channel.id === "codex") {
      const status = await options
        .codexAuth
        .status()
        .catch(() => ({ configured: false, expired: false }))
      const detail = status.configured
        ? status.expired
          ? "signed in (credential expired; refreshes on next generation)"
          : "signed in"
        : `not signed in - ${channel.loginHint}`
      lines.push(`- codex: ${detail}`)
      continue
    }
    lines.push(
      `- ${channel.id}: ${configured ? "ready" : `not ready - ${channel.loginHint}`}`,
    )
  }

  lines.push(`Default channel: ${config.defaultProvider ?? "unset (auto-selects codex -> grok -> openai)"}`)
  lines.push(`Output directory: <cwd>/${config.outputDir}/`)
  lines.push(`Config file: ${resolveConfigPath()}`)
  lines.push(`Credential file: ${options.store.path}`)
  return lines.join("\n")
}

async function loginGrok(
  options: ImageGenCommandOptions,
  ctx: ExtensionCommandContext,
): Promise<void> {
  ctx.ui.notify("Starting Grok authorization...", "info")
  try {
    await options.grokAuth.login((code) => {
      // device code 的链接里已经带了 user code，自动打开能省掉手输。
      const opened = (options.openBrowser ?? openBrowser)(code.verificationUrl)
      const minutes = Math.round(code.expiresInSeconds / 60)
      ctx.ui.notify(
        opened
          ? `Opened ${code.verificationUrl} in your browser. Confirm the code ${code.userCode} (valid for ${minutes} minutes).`
          : `Open ${code.verificationUrl} and enter the code ${code.userCode} (valid for ${minutes} minutes).`,
        "info",
      )
    })
    ctx.ui.notify("Grok sign-in complete.", "info")
  } catch (error) {
    ctx.ui.notify(error instanceof ImageGenError ? error.message : "Grok sign-in failed.", "error")
  }
}

async function loginCodex(
  options: ImageGenCommandOptions,
  ctx: ExtensionCommandContext,
): Promise<void> {
  ctx.ui.notify("Starting Codex authorization (local callback on 127.0.0.1:1455)...", "info")
  try {
    await options.codexAuth.login((prompt) => {
      // 回调在 127.0.0.1:1455 上等着，所以必须在**本机**浏览器里打开。
      const opened = (options.openBrowser ?? openBrowser)(prompt.url)
      ctx.ui.notify(
        opened
          ? `Opened the authorization page in your browser. If nothing happened, open this URL:\n${prompt.url}`
          : `Open this URL in your browser to authorize. It redirects back to this machine when done:\n${prompt.url}`,
        "info",
      )
    })
    ctx.ui.notify("Codex sign-in complete.", "info")
  } catch (error) {
    ctx.ui.notify(error instanceof ImageGenError ? error.message : "Codex sign-in failed.", "error")
  }
}

const LOGIN_CHOICES = [
  { id: "codex", label: "Codex  -  ChatGPT subscription (browser sign-in)" },
  { id: "grok", label: "Grok  -  x.ai subscription (device code)" },
  { id: "openai", label: "OpenAI API key  -  paste a key" },
] as const

/**
 * 无参数时给选择界面，与 pi 的 `/login` 一致（API Key 也在里面，它也是一种“登录”）。
 * `/image-gen login codex` 这类显式写法仍然可用，方便脚本与非交互场景。
 */
async function loginInteractively(
  options: ImageGenCommandOptions,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Usage: /image-gen login <codex|grok|openai>", "warning")
    return
  }
  const selected = await ctx.ui.select(
    "Sign in to which channel?",
    LOGIN_CHOICES.map((choice) => choice.label),
  )
  if (selected === undefined) return
  const choice = LOGIN_CHOICES.find((item) => item.label === selected)
  if (choice === undefined) return
  if (choice.id === "codex") await loginCodex(options, ctx)
  else if (choice.id === "grok") await loginGrok(options, ctx)
  else await saveOpenAiKey(options, ctx, undefined)
}

async function saveOpenAiKey(
  options: ImageGenCommandOptions,
  ctx: ExtensionCommandContext,
  inline: string | undefined,
): Promise<void> {
  let value = inline
  if (value === undefined || value.trim().length === 0) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Cannot prompt for a key in non-interactive mode. Pass it directly: /image-gen key sk-...", "error")
      return
    }
    value = await ctx.ui.input("OpenAI API Key", "sk-...")
    if (value === undefined) return
  }
  const key = value.trim()
  if (key.length === 0) {
    ctx.ui.notify("No key provided; nothing changed.", "warning")
    return
  }
  await options.store.set("openai", { type: "api_key", key })
  ctx.ui.notify("Saved the OpenAI API key (value not echoed).", "info")
}

async function removeCredential(
  options: ImageGenCommandOptions,
  ctx: ExtensionCommandContext,
  target: string,
): Promise<boolean> {
  if (target === "codex") {
    await options.codexAuth.logout()
    ctx.ui.notify("Removed the stored Codex credential.", "info")
    return true
  }
  if (target === "grok") {
    await options.grokAuth.logout()
    ctx.ui.notify("Removed the stored Grok credential.", "info")
    return true
  }
  if (target === "openai") {
    await options.store.delete("openai")
    ctx.ui.notify("Removed the stored OpenAI key.", "info")
    return true
  }
  return false
}

/** 插件自己存下来的凭据，用于登出选择。环境变量里的 `OPENAI_API_KEY` 不归这里管。 */
async function storedCredentials(
  options: ImageGenCommandOptions,
): Promise<Array<{ id: string; label: string }>> {
  const stored: Array<{ id: string; label: string }> = []

  const codex = await options.codexAuth.status().catch(() => ({ configured: false }))
  if (codex.configured) stored.push({ id: "codex", label: "Codex (ChatGPT subscription)" })

  const grok = await options.grokAuth.status().catch(() => ({ configured: false }))
  if (grok.configured) stored.push({ id: "grok", label: "Grok (x.ai)" })

  const credential = await options.store.read("openai").catch(() => undefined)
  if (credential?.type === "api_key") stored.push({ id: "openai", label: "OpenAI API key" })

  return stored
}

async function logout(
  options: ImageGenCommandOptions,
  ctx: ExtensionCommandContext,
  target: string | undefined,
): Promise<void> {
  if (target === undefined) {
    const stored = await storedCredentials(options)
    if (stored.length === 0) {
      ctx.ui.notify("No stored credentials to remove.", "info")
      return
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("Usage: /image-gen logout <codex|grok|openai>", "warning")
      return
    }
    const selected = await ctx.ui.select(
      "Remove which credential?",
      stored.map((item) => item.label),
    )
    if (selected === undefined) return
    const choice = stored.find((item) => item.label === selected)
    if (choice === undefined) return
    await removeCredential(options, ctx, choice.id)
    return
  }

  if (!(await removeCredential(options, ctx, target))) {
    ctx.ui.notify("Usage: /image-gen logout <codex|grok|openai>", "warning")
  }
}

async function setDefault(
  options: ImageGenCommandOptions,
  ctx: ExtensionCommandContext,
  value: string | undefined,
): Promise<void> {
  let provider = parseProvider(value)
  if (provider === undefined && value !== undefined) {
    ctx.ui.notify(`Unknown channel: ${value}`, "error")
    return
  }
  if (provider === undefined) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Usage: /image-gen default <codex|grok|openai>", "warning")
      return
    }
    const choice = await ctx.ui.select("Select the default image channel", [...PROVIDER_IDS])
    if (choice === undefined) return
    provider = parseProvider(choice)
    if (provider === undefined) return
  }
  try {
    await updateConfig({ defaultProvider: provider })
    ctx.ui.notify(`Default channel set to ${provider}.`, "info")
  } catch (error) {
    ctx.ui.notify(error instanceof ImageGenError ? error.message : "Could not write the config.", "error")
  }
}

export function registerImageGenCommand(pi: ExtensionAPI, options: ImageGenCommandOptions): void {
  pi.registerCommand("image-gen", {
    description: "Manage image generation channels (status / sign-in / credentials / default)",
    getArgumentCompletions: completeImageGenArguments,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter((part) => part.length > 0)
      const [subcommand, ...rest] = parts

      try {
        switch (subcommand) {
          case undefined:
          case "status": {
            ctx.ui.notify(await statusText(options, ctx), "info")
            return
          }
          case "login": {
            const target = rest[0]
            if (target === undefined) {
              await loginInteractively(options, ctx)
              return
            }
            if (target === "grok") {
              await loginGrok(options, ctx)
              return
            }
            if (target === "codex") {
              await loginCodex(options, ctx)
              return
            }
            if (target === "openai") {
              // `/image-gen login openai sk-...` 可直接给 key；省略则弹输入框。
              await saveOpenAiKey(options, ctx, rest.slice(1).join(" ").trim() || undefined)
              return
            }
            ctx.ui.notify("Usage: /image-gen login <codex|grok|openai>", "warning")
            return
          }
          case "key": {
            await saveOpenAiKey(options, ctx, rest.join(" ").trim() || undefined)
            return
          }
          case "logout": {
            await logout(options, ctx, rest[0])
            return
          }
          case "default": {
            await setDefault(options, ctx, rest[0])
            return
          }
          default: {
            ctx.ui.notify(USAGE, "warning")
          }
        }
      } catch (error) {
        ctx.ui.notify(error instanceof ImageGenError ? error.message : "Command failed.", "error")
      }
    },
  })
}

export { USAGE as IMAGE_GEN_USAGE }

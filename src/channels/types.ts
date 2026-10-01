/**
 * 通道契约。
 *
 * 一个通道 = 一个上游生图端点族（codex / grok / openai）。通道只负责「把已解析的输入变成图片字节」，
 * 它不决定选哪个通道，也不管文件落盘与 tool 结果组装 —— 那些在 `tool.ts` 里。
 *
 * 所有依赖通过 `ChannelDeps` 注入，因此每条通道都能用假 fetch / 假时钟做测试，不会发真实请求。
 */
import type { CodexAuth } from "../auth/codex.ts"
import type { GrokAuth } from "../auth/grok.ts"
import type { ImageGenAuthStore } from "../auth/store.ts"
import type { ReferenceImage } from "../util/image.ts"

export type ProviderId = "codex" | "grok" | "openai"

export const PROVIDER_IDS: readonly ProviderId[] = ["codex", "grok", "openai"]

export type Quality = "auto" | "low" | "medium" | "high" | "xhigh" | "max"
export type Background = "auto" | "transparent" | "opaque"
export type Resolution = "1k" | "1.5k" | "2k"
/** 内容审核强度。只有 OpenAI API Key 通道接受它。 */
export type Moderation = "auto" | "low"

export interface GenerateInput {
  prompt: string
  /** 已解析出具体值的模型名（调用方填好默认值）。 */
  model: string
  n: number
  /** `WxH` 或 `auto`，仅 OpenAI 通道支持。 */
  size?: string
  quality?: Quality
  background?: Background
  /** 仅 OpenAI API Key 通道支持；省略时按 `low` 发送（跟 ai-canvas 一致）。 */
  moderation?: Moderation
  /** 仅 Grok 通道支持。 */
  aspectRatio?: string
  /** 仅 Grok 通道支持。 */
  resolution?: Resolution
  references: ReferenceImage[]
}

export interface GenerateUsage {
  input?: number
  output?: number
  total?: number
}

export interface GenerateOutput {
  images: Uint8Array[]
  model: string
  /** 上游 fetch 的实际耗时：发出前开始、响应体读完为止。 */
  upstreamMs: number
  usage?: GenerateUsage
}

export interface ChannelCapabilities {
  /** 单次请求最多几张输出。 */
  maxImages: number
  /** 最多几张参考图。 */
  maxReferenceImages: number
  /** 参考图合计字节上限。 */
  maxReferenceBytes: number
  qualities: readonly Quality[]
  /** 是否接受 `moderation`。Codex 与 Grok 都不发这个字段。 */
  supportsModeration: boolean
  supportsSize: boolean
  supportsBackground: boolean
  supportsAspectRatio: boolean
  supportsResolution: boolean
  /** 参考图里是否接受 WebP；不接受的通道需要调用方先转码。 */
  supportsWebpReferences: boolean
}

/** Codex 凭据由插件自己维护（见 `auth/codex.ts`）。 */
export interface CodexCredentials {
  access: string
  accountId: string
}

export interface ChannelDeps {
  fetch: typeof fetch
  store: ImageGenAuthStore
  /** Grok 的登录与刷新；刷新在凭据库的锁内做。 */
  grokAuth: GrokAuth
  /** Codex 的登录与刷新；同样在凭据库的锁内做。 */
  codexAuth: CodexAuth
  env: NodeJS.ProcessEnv
  timeoutMs: number
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface Channel {
  readonly id: ProviderId
  readonly displayName: string
  readonly defaultModel: string
  readonly capabilities: ChannelCapabilities
  /** 未配置时提示用户怎么配置。 */
  readonly loginHint: string
  isConfigured(deps: ChannelDeps): Promise<boolean>
  generate(
    input: GenerateInput,
    deps: ChannelDeps,
    signal?: AbortSignal,
  ): Promise<GenerateOutput>
}

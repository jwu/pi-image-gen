/**
 * OpenAI Images 通道（API Key）。
 *
 * 对接的是 **OpenAI Images 兼容协议**，不是 Responses 或 Chat Completions：
 * - 无参考图 → JSON `POST {baseUrl}/images/generations`
 * - 有参考图 → multipart `POST {baseUrl}/images/edits`，参考图按顺序以 `image[]` 追加
 *
 * 只接受 `data[].b64_json`：仅返回 `url` 的上游会被拒绝，因为服务端不下载任意 URL（SSRF）。
 */
import { ImageGenError } from "../util/errors.ts"
import { MAX_UPSTREAM_RESPONSE_BYTES } from "../util/limits.ts"
import { sendAndParse } from "./request.ts"
import { parseImageResponse, parseUsage } from "./response.ts"
import type { Channel, ChannelDeps, GenerateOutput, Quality } from "./types.ts"

export const OPENAI_PROVIDER_ID = "openai"
export const OPENAI_DEFAULT_MODEL = "gpt-image-2"
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"

export const OPENAI_LOGIN_HINT = "set OPENAI_API_KEY, or run /image-gen key"

export const OPENAI_QUALITIES: readonly Quality[] = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

const MAX_SIDE = 3840
const MIN_PIXELS = 655_360
const MAX_PIXELS = 8_294_400
const SIZE_PATTERN = /^(\d+)x(\d+)$/

/** 参考图合计上限：与上游对 `/images/edits` 的容忍度一致。 */
export const OPENAI_MAX_REFERENCE_BYTES = 40 * 1024 * 1024
export const OPENAI_MAX_REFERENCE_IMAGES = 16

/** 校验 `size`：`auto` 或 `宽x高`，且满足上游的倍数、比例与像素区间。 */
export function validateSize(size: string): string {
  if (size === "auto") return size
  const match = SIZE_PATTERN.exec(size)
  if (match === null) {
    throw new ImageGenError(`size must be "auto" or WxH (e.g. 1024x1024), got: ${size}`)
  }
  const width = Number(match[1])
  const height = Number(match[2])
  if (width <= 0 || height <= 0) throw new ImageGenError(`size must use positive integers: ${size}`)
  if (width > MAX_SIDE || height > MAX_SIDE) {
    throw new ImageGenError(`size sides must not exceed ${MAX_SIDE}: ${size}`)
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new ImageGenError(`size sides must be multiples of 16: ${size}`)
  }
  const ratio = width / height
  if (ratio < 1 / 3 || ratio > 3) {
    throw new ImageGenError(`size aspect ratio must be between 1:3 and 3:1: ${size}`)
  }
  const pixels = width * height
  if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) {
    throw new ImageGenError(`size must be between ${MIN_PIXELS} and ${MAX_PIXELS} pixels: ${size}`)
  }
  return size
}

export type OpenAiKeySource = "env" | "file" | "none"

/** 凭据来源说明，供 `/image-gen` 展示用。 */
export const OPENAI_KEY_SOURCE_LABELS: Record<OpenAiKeySource, string> = {
  env: "OPENAI_API_KEY environment variable",
  file: "plugin credential file",
  none: "not configured",
}

/**
 * 凭据解析顺序，前一个非空就不再往下找：
 * `OPENAI_API_KEY` → 插件凭据文件里的 openai key。
 *
 * **为什么不复用 pi 的「Sign in with ChatGPT」凭据**（provider `openai`）：实测不可用。
 * 那个 ChatPass token 被服务端硬边界挡住：
 * - `POST /v1/images/generations` → 401 `hardened_oauth_rule_missing`
 *   「This ChatPass credential is not authorized for the requested operation.」
 * - `POST chatgpt.com/backend-api/codex/images/generations` → 401 `no_matching_rule`
 * - `GET /v1/models` 虽然 200，但返回的是 ChatGPT 内部的 `{models:[{slug:…}]}` 结构，
 *   不是标准 OpenAI API 的 `{data:[…]}`。
 *
 * 接上它只会让 `/image-gen` 显示「已配置」而实际调用必顶 401，比不接更糟。
 * 要用 ChatGPT 订阅生图请走 codex 通道（provider `openai-codex`）。
 */
export async function resolveOpenAiApiKey(
  deps: ChannelDeps,
): Promise<{ key: string; source: OpenAiKeySource } | undefined> {
  const envKey = deps.env["OPENAI_API_KEY"]
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    return { key: envKey.trim(), source: "env" }
  }
  const credential = await deps.store.read(OPENAI_PROVIDER_ID)
  if (credential?.type === "api_key") return { key: credential.key, source: "file" }
  return undefined
}

/** 只判断来源，不发任何请求。 */
export async function detectOpenAiKeySource(deps: ChannelDeps): Promise<OpenAiKeySource> {
  const envKey = deps.env["OPENAI_API_KEY"]
  if (typeof envKey === "string" && envKey.trim().length > 0) return "env"
  const credential = await deps.store.read(OPENAI_PROVIDER_ID).catch(() => undefined)
  return credential?.type === "api_key" ? "file" : "none"
}

export function resolveOpenAiBaseUrl(deps: ChannelDeps): string {
  const raw = deps.env["OPENAI_BASE_URL"]
  if (typeof raw !== "string" || raw.trim().length === 0) return OPENAI_DEFAULT_BASE_URL
  const value = raw.trim().replace(/\/+$/, "")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ImageGenError(`OPENAI_BASE_URL is not a valid URL: ${value}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ImageGenError("OPENAI_BASE_URL must be http or https.")
  }
  return value
}

async function buildRequest(
  input: Parameters<Channel["generate"]>[0],
  apiKey: string,
  baseUrl: string,
): Promise<{ url: string; init: RequestInit }> {
  const withReferences = input.references.length > 0
  const url = `${baseUrl}/images/${withReferences ? "edits" : "generations"}`

  // JSON 路径要保持原生类型（`n` 是数字）；multipart 路径再逐字段转成字符串。
  const fields: Record<string, string | number> = {
    model: input.model,
    prompt: input.prompt,
    n: input.n,
  }
  if (input.size !== undefined) fields["size"] = validateSize(input.size)
  if (input.quality !== undefined) fields["quality"] = input.quality
  if (input.background !== undefined) fields["background"] = input.background
  // ai-canvas 的默认是 low（请求值 → 项目设置 → low），这里没有“项目设置”这一层。
  fields["moderation"] = input.moderation ?? "low"

  if (!withReferences) {
    return {
      url,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(fields),
      },
    }
  }

  // 上游要求 image 与 mask 同格式同尺寸；第一版不支持 mask，只发参考图。
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
  for (const reference of input.references) {
    form.append(
      "image[]",
      new Blob([reference.bytes], { type: reference.mimeType }),
      reference.path.split(/[\\/]/).pop() ?? "reference.png",
    )
  }

  return {
    url,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      body: form,
    },
  }
}

export const openaiChannel: Channel = {
  id: OPENAI_PROVIDER_ID,
  displayName: "OpenAI Images",
  defaultModel: OPENAI_DEFAULT_MODEL,
  loginHint: OPENAI_LOGIN_HINT,
  capabilities: {
    maxImages: 10,
    maxReferenceImages: OPENAI_MAX_REFERENCE_IMAGES,
    maxReferenceBytes: OPENAI_MAX_REFERENCE_BYTES,
    qualities: OPENAI_QUALITIES,
    supportsModeration: true,
    supportsSize: true,
    supportsBackground: true,
    supportsAspectRatio: false,
    supportsResolution: false,
    supportsWebpReferences: true,
  },

  async isConfigured(deps: ChannelDeps): Promise<boolean> {
    return (await detectOpenAiKeySource(deps)) !== "none"
  },

  async generate(input, deps, signal): Promise<GenerateOutput> {
    const resolved = await resolveOpenAiApiKey(deps)
    if (resolved === undefined) {
      throw new ImageGenError(`The OpenAI channel is not configured. ${OPENAI_LOGIN_HINT}`)
    }
    const baseUrl = resolveOpenAiBaseUrl(deps)
    const { url, init } = await buildRequest(input, resolved.key, baseUrl)

    const { body, upstreamMs } = await sendAndParse({
      deps,
      url,
      init,
      provider: OPENAI_PROVIDER_ID,
      // 上游可能按 n 返回多张，响应体上限随之放大。
      maxBytes: MAX_UPSTREAM_RESPONSE_BYTES * Math.max(1, input.n),
      ...(signal !== undefined ? { signal } : {}),
    })

    // 上游少给图片也算成功：已经出图、可能已计费的那几张不能丢。
    const images = parseImageResponse(body)
    const usage = parseUsage(body)
    return {
      images: images.map((image) => image.bytes),
      model: input.model,
      upstreamMs,
      ...(usage !== undefined ? { usage } : {}),
    }
  },
}

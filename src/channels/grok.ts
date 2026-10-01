/**
 * Grok 通道（`api: "grok-images"`）。
 *
 * 固定 `https://api.x.ai/v1`，凭据来自插件自己的 device code 登录（见 `auth/grok.ts`）。
 * 参考图走 JSON `image`（单张）/ `images`（多张），和图生图共用同一个端点族。
 *
 * 与 ai-canvas 的一处有意差异：WebP 参考图在这里**直接拒绝**而不是先转 PNG。转码需要引入
 * 图像解码器，而 coding agent 的参考图基本都是 PNG/JPEG；拒绝比静默失败好，报错里会写明原因。
 */
import { ImageGenError } from "../util/errors.ts"
import { toDataUrl } from "../util/image.ts"
import { MAX_UPSTREAM_RESPONSE_BYTES } from "../util/limits.ts"
import { sendAndParse } from "./request.ts"
import { parseImageResponse, parseUsage } from "./response.ts"
import type { Channel, ChannelDeps, GenerateOutput, Quality, Resolution } from "./types.ts"

export const GROK_PROVIDER_ID = "grok"
export const GROK_DEFAULT_MODEL = "grok-imagine-image-2.0"
export const GROK_BASE_URL = "https://api.x.ai/v1"

export const GROK_QUALITIES: readonly Quality[] = ["auto", "low", "medium"]
export const GROK_RESOLUTIONS: readonly Resolution[] = ["1k", "1.5k", "2k"]
export const GROK_ASPECT_RATIOS: readonly string[] = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
  "21:9",
  "5:2",
]

export const GROK_MAX_REFERENCE_IMAGES = 5
export const GROK_MAX_REFERENCE_BYTES = 40 * 1024 * 1024

/** 组装 Grok 的请求体：`aspect_ratio` 的省略规则跟 ai-canvas 一致。 */
export function buildGrokBody(
  input: Parameters<Channel["generate"]>[0],
): Record<string, unknown> {
  const references = input.references.map((reference) => ({
    type: "image_url" as const,
    url: toDataUrl(reference.mimeType, reference.bytes),
  }))

  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    n: input.n,
    response_format: "b64_json",
    quality: input.quality ?? "auto",
    resolution: input.resolution ?? "1k",
  }

  // 有参考图且没指定比例时交给上游自己判断；纯文生图则显式要 auto。
  if (input.aspectRatio !== undefined) body["aspect_ratio"] = input.aspectRatio
  else if (references.length === 0) body["aspect_ratio"] = "auto"

  if (references.length === 1) body["image"] = references[0]
  else if (references.length > 1) body["images"] = references

  return body
}

export const grokChannel: Channel = {
  id: GROK_PROVIDER_ID,
  displayName: "Grok (x.ai)",
  defaultModel: GROK_DEFAULT_MODEL,
  loginHint: "run /image-gen login grok",
  capabilities: {
    maxImages: 10,
    maxReferenceImages: GROK_MAX_REFERENCE_IMAGES,
    maxReferenceBytes: GROK_MAX_REFERENCE_BYTES,
    qualities: GROK_QUALITIES,
    // Grok 不发 moderation：quality 只控制生成质量，审核强度不可由用户调整。
    supportsModeration: false,
    supportsSize: false,
    supportsBackground: false,
    supportsAspectRatio: true,
    supportsResolution: true,
    // 需要图像解码器才能转 PNG，第一版不引这个依赖，改为明确拒绝。
    supportsWebpReferences: false,
  },

  async isConfigured(deps: ChannelDeps): Promise<boolean> {
    return (await deps.grokAuth.status()).configured
  },

  async generate(input, deps, signal): Promise<GenerateOutput> {
    const headers = await deps.grokAuth.headers(signal)
    const endpoint = `${GROK_BASE_URL}/images/${input.references.length > 0 ? "edits" : "generations"}`

    const { body, upstreamMs } = await sendAndParse({
      deps,
      url: endpoint,
      init: {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(buildGrokBody(input)),
      },
      provider: GROK_PROVIDER_ID,
      maxBytes: MAX_UPSTREAM_RESPONSE_BYTES * Math.max(1, input.n),
      ...(signal !== undefined ? { signal } : {}),
    })

    const images = parseImageResponse(body, { rejectModeration: true })
    const usage = parseUsage(body)
    return {
      images: images.map((image) => image.bytes),
      model: input.model,
      upstreamMs,
      ...(usage !== undefined ? { usage } : {}),
    }
  },
}

/** `/image-gen` 命令用：校验用户给的比例是否在支持列表里。 */
export function validateAspectRatio(value: string): string {
  if (!GROK_ASPECT_RATIOS.includes(value)) {
    throw new ImageGenError(`Grok does not support this aspect ratio: ${value}`)
  }
  return value
}

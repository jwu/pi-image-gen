/**
 * Codex 通道（`api: "codex-images"`，实验）。
 *
 * 凭据由插件自己维护（`auth/codex.ts` 的 `/image-gen login codex`），与 pi 的登录完全隔离。
 * 端点固定在 `chatgpt.com/backend-api/codex`，凭据只发往这个官方 backend。
 *
 * 与 OpenAI API Key 通道的差异（照 ai-canvas 的实测结论）：
 * - endpoint 是 `/codex/images/{generations,edits}`；
 * - 需要 `chatgpt-account-id` 与 `x-codex-image-turn-id` 两个额外 header；
 * - 有参考图时用 **JSON** `images: [{ image_url: "data:..." }]`，不是 multipart；
 * - **不发 `n`、不发 `moderation`**；
 * - 每次固定 1 张、参考图最多 5 张、`quality` 只到 `high`。
 */
import { randomUUID } from "node:crypto"
import { CODEX_LOGIN_HINT } from "../auth/codex.ts"
import { ImageGenError } from "../util/errors.ts"
import { toDataUrl } from "../util/image.ts"
import { MAX_UPSTREAM_RESPONSE_BYTES } from "../util/limits.ts"
import { parseImageResponse, parseUsage } from "./response.ts"
import { sendAndParse } from "./request.ts"
import type { Channel, ChannelDeps, GenerateOutput, Quality } from "./types.ts"

export const CODEX_PROVIDER_ID = "codex"
export const CODEX_DEFAULT_MODEL = "gpt-image-2"
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
/** ai-canvas 实测可用的 originator；pi 自己的 chat 请求用的是 `pi`，若被拒可切换。 */
export const CODEX_ORIGINATOR = "codex_cli_rs"

export const CODEX_QUALITIES: readonly Quality[] = ["auto", "low", "medium", "high"]
export const CODEX_MAX_REFERENCE_IMAGES = 5
export const CODEX_MAX_REFERENCE_BYTES = 40 * 1024 * 1024

/** 组装 Codex 的请求体：字段顺序与省略规则都跟 ai-canvas 一致。 */
export function buildCodexBody(
  input: Parameters<Channel["generate"]>[0],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    size: input.size ?? "auto",
    quality: input.quality ?? "auto",
    background: input.background ?? "auto",
  }
  if (input.references.length > 0) {
    body["images"] = input.references.map((reference) => ({
      image_url: toDataUrl(reference.mimeType, reference.bytes),
    }))
  }
  return body
}

export const codexChannel: Channel = {
  id: CODEX_PROVIDER_ID,
  displayName: "Codex (ChatGPT)",
  defaultModel: CODEX_DEFAULT_MODEL,
  loginHint: CODEX_LOGIN_HINT,
  capabilities: {
    // Codex 后端每次只出一张，多要直接拒，不做「取第一张」的降级。
    maxImages: 1,
    maxReferenceImages: CODEX_MAX_REFERENCE_IMAGES,
    maxReferenceBytes: CODEX_MAX_REFERENCE_BYTES,
    qualities: CODEX_QUALITIES,
    // Codex 后端不发 moderation，项目的审核强度对它不生效。
    supportsModeration: false,
    supportsSize: true,
    supportsBackground: true,
    supportsAspectRatio: false,
    supportsResolution: false,
    supportsWebpReferences: true,
  },

  async isConfigured(deps: ChannelDeps): Promise<boolean> {
    return (await deps.codexAuth.status()).configured
  },

  async generate(input, deps, signal): Promise<GenerateOutput> {
    const credentials = await deps.codexAuth.credentials(signal)
    if (credentials === undefined) {
      throw new ImageGenError(`Codex credentials are unavailable. ${CODEX_LOGIN_HINT}`)
    }

    const endpoint = `${CODEX_BASE_URL}/images/${input.references.length > 0 ? "edits" : "generations"}`
    const { body, upstreamMs } = await sendAndParse({
      deps,
      url: endpoint,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.access}`,
          "chatgpt-account-id": credentials.accountId,
          originator: CODEX_ORIGINATOR,
          "x-codex-image-turn-id": randomUUID(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(buildCodexBody(input)),
      },
      provider: CODEX_PROVIDER_ID,
      maxBytes: MAX_UPSTREAM_RESPONSE_BYTES,
      ...(signal !== undefined ? { signal } : {}),
    })

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

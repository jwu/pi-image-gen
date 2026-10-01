/**
 * 三个通道共用的响应解析。
 *
 * 共同约定（来自 ai-canvas 的实测结论）：
 * - **只接受 `data[].b64_json`**：上游只给 `url` 时直接拒绝，服务端不下载任意 URL（SSRF）。
 * - **空 `data` 才是失败**：`data` 少于请求的 `n` 算成功，已出图的那几张不能丢。
 */
import { ImageGenError } from "../util/errors.ts"
import { decodeBase64Image, detectImageMime, type ImageMimeType } from "../util/image.ts"
import { MAX_UPSTREAM_RESPONSE_BYTES } from "../util/limits.ts"
import type { GenerateUsage } from "./types.ts"

export interface DecodedImage {
  bytes: Uint8Array
  mimeType: ImageMimeType
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export function parseImageResponse(
  body: unknown,
  options: { rejectModeration?: boolean } = {},
): DecodedImage[] {
  const record = asRecord(body)
  if (record === undefined) throw new ImageGenError("The upstream response could not be parsed.")

  const data = record["data"]
  if (!Array.isArray(data) || data.length === 0) {
    throw new ImageGenError("The upstream returned no images.")
  }

  const images: DecodedImage[] = []
  for (const entry of data) {
    const item = asRecord(entry)
    if (item === undefined) throw new ImageGenError("An image entry from the upstream could not be parsed.")

    // Grok 会用 `respect_moderation: false` 表示这张被审核拦下；整批失败，不返回半批图。
    if (options.rejectModeration === true && item["respect_moderation"] === false) {
      throw new ImageGenError(
        "The request was blocked by the safety system. Adjust the prompt or reference images and retry.",
      )
    }

    const encoded = item["b64_json"]
    if (typeof encoded !== "string") {
      if (typeof item["url"] === "string") {
        throw new ImageGenError(
          "The upstream returned only an image URL; this tool accepts base64 images only.",
        )
      }
      throw new ImageGenError("The upstream returned no image data.")
    }

    const bytes = decodeBase64Image(encoded, MAX_UPSTREAM_RESPONSE_BYTES)
    const mimeType = detectImageMime(bytes)
    if (mimeType === undefined) throw new ImageGenError("The upstream returned an image in an unrecognized format.")
    images.push({ bytes, mimeType })
  }
  return images
}

/** 上游给 token 计数时提取 input / output / total，其余字段一概丢弃。 */
export function parseUsage(body: unknown): GenerateUsage | undefined {
  const record = asRecord(body)
  if (record === undefined) return undefined
  const usage = asRecord(record["usage"])
  if (usage === undefined) return undefined

  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = usage[key]
      if (typeof value === "number" && Number.isFinite(value)) return value
    }
    return undefined
  }

  const input = pick("input_tokens", "input")
  const output = pick("output_tokens", "output")
  const total = pick("total_tokens", "total")
  if (input === undefined && output === undefined && total === undefined) return undefined

  const result: GenerateUsage = {}
  if (input !== undefined) result.input = input
  if (output !== undefined) result.output = output
  if (total !== undefined) result.total = total
  return result
}

/** 把字节解成 JSON；解不开就是上游没按约定返回。 */
export function parseJsonBody(bytes: Uint8Array, upstreamMs: number): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new ImageGenError("The upstream response could not be parsed.", { upstreamMs })
  }
}

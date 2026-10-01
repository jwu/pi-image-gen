/**
 * 图片字节的探测、校验与编码。
 *
 * 上游只允许通过字节交付图片：**绝不下载上游返回的 `url`**（避免 SSRF），因此所有通道都只接受
 * base64 并在本地校验格式。
 */
import { readFile } from "node:fs/promises"
import { ImageGenError } from "./errors.ts"

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp"

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false
  }
  return true
}

/** 按字节签名判定图片类型；识别不了返回 `undefined`，调用方决定是拒绝还是放行。 */
export function detectImageMime(bytes: Uint8Array): ImageMimeType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png"
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg"
  if (
    bytes.byteLength >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return undefined
}

/** 要求字节是 PNG（Codex 通道只接受它自己的 PNG 输出）。 */
export function assertPng(bytes: Uint8Array): void {
  if (!startsWith(bytes, PNG_SIGNATURE)) {
    throw new ImageGenError("The upstream did not return a PNG image.")
  }
}

/**
 * 解码上游返回的 `b64_json`。字符集不合法、解码后为空或超过上限都拒绝。
 */
export function decodeBase64Image(encoded: string, maxBytes: number): Uint8Array {
  if (encoded.length === 0 || !BASE64_PATTERN.test(encoded)) {
    throw new ImageGenError("The upstream returned invalid base64 image data.")
  }
  // 4/3 是 base64 的膨胀比；先粗判，避免为一个超限响应分配大缓冲。
  if ((encoded.length / 4) * 3 > maxBytes + 3) {
    throw new ImageGenError("The upstream returned an image that is too large.")
  }
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"))
  if (bytes.byteLength === 0) throw new ImageGenError("The upstream returned invalid base64 image data.")
  if (bytes.byteLength > maxBytes) throw new ImageGenError("The upstream returned an image that is too large.")
  return bytes
}

export function toDataUrl(mimeType: ImageMimeType, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`
}

export interface ReferenceImage {
  /** 调用方给出的原始路径，仅用于错误提示，不会发给上游。 */
  path: string
  bytes: Uint8Array
  mimeType: ImageMimeType
}

/**
 * 读一张参考图并判定类型。WebP 是否可用由各通道决定（OpenAI 支持，Grok 需先转码）。
 */
export async function readReferenceImage(
  path: string,
  maxBytes: number,
): Promise<ReferenceImage> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(path))
  } catch {
    throw new ImageGenError(`Could not read the reference image: ${path}`)
  }
  if (bytes.byteLength === 0) throw new ImageGenError(`The reference image is empty: ${path}`)
  if (bytes.byteLength > maxBytes) {
    throw new ImageGenError(`The reference image is too large (limit ${formatBytes(maxBytes)}): ${path}`)
  }
  const mimeType = detectImageMime(bytes)
  if (mimeType === undefined) {
    throw new ImageGenError(`Unsupported reference image format (PNG / JPEG / WebP only): ${path}`)
  }
  return { path, bytes, mimeType }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

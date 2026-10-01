/**
 * 上游响应体的读取上限与超时。
 *
 * 任何通道都不允许无界读取上游响应：生图接口的响应体可能非常大，读超了既拖垮进程也浪费额度。
 */
import { ImageGenError } from "./errors.ts"

/** 生图响应的硬上限（单次响应体，不按张数放大）。 */
export const MAX_UPSTREAM_RESPONSE_BYTES = 30 * 1024 * 1024
/** OAuth token / device code 这类小响应的上限。 */
export const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024
/** 判定上游错误原因时最多读多少字节。 */
export const MAX_ERROR_BODY_BYTES = 64 * 1024
/** 默认的单次生成超时。 */
export const DEFAULT_TIMEOUT_MS = 180_000

/** 读到上限就中断并抛出可展示的失败，绝不返回被截断的字节。 */
export async function readLimitedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > maxBytes) {
      throw new ImageGenError("The upstream response was too large.")
    }
  }
  const body = response.body
  if (body === null) return new Uint8Array(0)

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new ImageGenError("The upstream response was too large.")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/** 读一小段错误体并解析成 JSON。任何失败都返回 `undefined`，错误体只是判定用的线索。 */
export async function readErrorBody(response: Response): Promise<unknown> {
  try {
    const bytes = await readLimitedBytes(response, MAX_ERROR_BODY_BYTES)
    if (bytes.byteLength === 0) return undefined
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return undefined
  }
}

/**
 * 把调用方的 `signal` 与超时合成一个信号。
 * 返回的 `dispose` 必须调用，否则超时定时器会拖住进程。
 */
export function withTimeout(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error("timeout"))
  }, timeoutMs)
  timer.unref?.()

  const onAbort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener("abort", onAbort, { once: true })
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    },
    timedOut: () => timedOut,
  }
}

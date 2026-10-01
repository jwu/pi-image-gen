/**
 * 三个通道共用的 HTTP 细节：超时、错误映射、响应体上限。
 *
 * 统一在这里保证：
 * - `redirect: "error"`：绝不跟随上游重定向。
 * - 上游错误只在本机判定，对外只留固定文案与 `code` / `requestId` / `upstreamMs`。
 * - `upstreamMs` 从 fetch 发出前开始、响应体读完为止；本地构造请求体不算在内。
 */
import { ImageGenError, mapUpstreamFailure, summarizeUpstreamBody } from "../util/errors.ts"
import { readErrorBody, readLimitedBytes, withTimeout } from "../util/limits.ts"
import type { ChannelDeps, ProviderId } from "./types.ts"
import { parseJsonBody } from "./response.ts"

export interface SendOptions {
  deps: ChannelDeps
  url: string
  init: RequestInit
  provider: ProviderId
  /** 响应体字节上限。 */
  maxBytes: number
  signal?: AbortSignal
}

export async function sendAndParse(
  options: SendOptions,
): Promise<{ body: unknown; upstreamMs: number }> {
  const { deps, url, init, provider, maxBytes, signal } = options
  const timeout = withTimeout(deps.timeoutMs, signal)

  const startedAt = deps.now()
  let response: Response
  try {
    response = await deps.fetch(url, { ...init, redirect: "error", signal: timeout.signal })
  } catch {
    timeout.dispose()
    if (timeout.timedOut()) throw new ImageGenError("The request timed out.")
    if (signal?.aborted === true) throw new ImageGenError("The request was cancelled.")
    throw new ImageGenError("Could not reach the upstream.")
  }

  try {
    if (!response.ok) {
      const failureBody = await readErrorBody(response)
      throw mapUpstreamFailure(
        {
          status: response.status,
          ...summarizeUpstreamBody(failureBody),
          upstreamMs: deps.now() - startedAt,
        },
        provider,
      )
    }

    const bytes = await readLimitedBytes(response, maxBytes)
    const upstreamMs = deps.now() - startedAt
    return { body: parseJsonBody(bytes, upstreamMs), upstreamMs }
  } finally {
    timeout.dispose()
  }
}

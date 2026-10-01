/**
 * 可安全展示的失败。
 *
 * `message` 会被直接写进 tool 的失败结果，也可能进入会话记录，因此**只能包含本地固定文案**：
 * 绝不带上游响应正文、提示词、参考图路径、密钥或 token。上游原文只在本进程内参与判定，
 * 判定完就丢掉，只保留可选的 `code` / `requestId`。
 */
export class ImageGenError extends Error {
  readonly code?: string
  readonly requestId?: string
  readonly upstreamMs?: number

  constructor(
    message: string,
    options: { code?: string; requestId?: string; upstreamMs?: number } = {},
  ) {
    super(message)
    this.name = "ImageGenError"
    if (options.code !== undefined) this.code = options.code
    if (options.requestId !== undefined) this.requestId = options.requestId
    if (options.upstreamMs !== undefined) this.upstreamMs = options.upstreamMs
  }
}

/** 上游已收到请求但失败时附带的诊断信息。这些字段本身不敏感，可以回显。 */
export interface UpstreamFailure {
  status: number
  /** 上游错误体里的 `code`（若有）。 */
  code?: string
  /** 上游错误体里的 `message`（若有）。**只用于本机判定**。 */
  message?: string
  requestId?: string
  upstreamMs?: number
}

/** 服务端硬边界：ChatGPT 订阅（ChatPass）凭据不具备调用 API 的权限。 */
const HARDENED_OAUTH_PATTERN = /hardened_oauth|rejected_by_hardened|chatpass/i

const MODERATION_PATTERN =
  /safety system|content policy|content_policy|moderation|safety_violation|prohibited|blocked by/i
const QUOTA_PATTERN = /quota|billing|insufficient_?funds|payment required|credit/i
const MODEL_PATTERN = /model_not_found|unknown model|does not exist/i
/** 上游明确点名某个参数不受支持时的参数名。 */
const PARAMETER_NAMES = [
  "size",
  "quality",
  "background",
  "moderation",
  "aspect_ratio",
  "resolution",
  "mask",
  "n",
] as const

export const CHANNEL_LOGIN_HINTS: Record<string, string> = {
  codex: "run /image-gen login codex",
  grok: "run /image-gen login grok",
  openai: "set OPENAI_API_KEY, or run /image-gen key",
}

function unsupportedParameter(failure: UpstreamFailure): string | undefined {
  const text = `${failure.code ?? ""} ${failure.message ?? ""}`.toLowerCase()
  if (!/not support|unsupported|invalid|unknown parameter|does not support/.test(text)) {
    return undefined
  }
  return PARAMETER_NAMES.find((name) => text.includes(name))
}

/**
 * 把上游失败映射成本地固定文案。判定顺序与 ai-canvas 的映射表一致：
 * 先识别明确原因，识别不了才落到通用文案，**不猜测**。
 */
export function mapUpstreamFailure(failure: UpstreamFailure, provider: string): ImageGenError {
  const options: { code?: string; requestId?: string; upstreamMs?: number } = {}
  if (failure.code !== undefined) options.code = failure.code
  if (failure.requestId !== undefined) options.requestId = failure.requestId
  if (failure.upstreamMs !== undefined) options.upstreamMs = failure.upstreamMs

  const code = failure.code ?? ""
  const message = failure.message ?? ""
  const text = `${code} ${message}`

  if (failure.status >= 500) {
    return new ImageGenError("Upstream is temporarily unavailable. Try again shortly.", options)
  }
  // ChatGPT 订阅的登录凭据不包含 Images API 权限，报错要指明出路，而不是笼统说“凭据不可用”。
  if (HARDENED_OAUTH_PATTERN.test(text)) {
    return new ImageGenError(
      "This credential is not authorized for image generation (a ChatGPT subscription login " +
        "does not cover the Images API). Use an OpenAI API key, or sign in to a subscription " +
        "channel with /image-gen login codex or /image-gen login grok.",
      options,
    )
  }
  if (failure.status === 401) {
    return new ImageGenError(
      provider === "codex"
        ? "Codex credentials are unavailable. Sign in again with /image-gen login codex."
        : `${provider} credentials are unavailable. ${CHANNEL_LOGIN_HINTS[provider] ?? "Check your credentials."}`,
      options,
    )
  }
  // 403 不一定是用错了凭据：Grok 用它表示模型权限或额度限制。
  if (failure.status === 403) {
    return new ImageGenError(
      `${provider} refused the request (model access or quota). Check your subscription permissions.`,
      options,
    )
  }
  // 402 是“额度用完/需要付费”，与限流不同，分开报。
  if (failure.status === 402) {
    return new ImageGenError("The account is out of quota or credits.", options)
  }
  if (failure.status === 404 || MODEL_PATTERN.test(text)) {
    return new ImageGenError("The model or endpoint does not exist. Check the model name.", options)
  }
  if (failure.status === 429 || QUOTA_PATTERN.test(text)) {
    return new ImageGenError("Rate limited or out of quota. Try again shortly.", options)
  }
  if (MODERATION_PATTERN.test(text)) {
    return new ImageGenError(
      "The request was blocked by the safety system. Adjust the prompt or reference images and retry.",
      options,
    )
  }
  const parameter = unsupportedParameter(failure)
  if (parameter !== undefined) {
    return new ImageGenError(`This model does not support the ${parameter} parameter.`, options)
  }
  return new ImageGenError("Image generation failed. Try again shortly.", options)
}

/** 判定用的错误体解析：只取 code / message / request id，其余字段一概丢弃。 */
export function summarizeUpstreamBody(body: unknown): {
  code?: string
  message?: string
  requestId?: string
} {
  const result: { code?: string; message?: string; requestId?: string } = {}
  if (typeof body !== "object" || body === null) return result
  const record = body as Record<string, unknown>
  const error = record.error
  if (typeof error === "object" && error !== null) {
    const nested = error as Record<string, unknown>
    if (typeof nested.code === "string") result.code = nested.code
    if (typeof nested.message === "string") result.message = nested.message
  } else if (typeof error === "string") {
    result.message = error
  }
  if (typeof record.code === "string" && result.code === undefined) result.code = record.code
  if (typeof record.message === "string" && result.message === undefined) {
    result.message = record.message
  }
  for (const key of ["request_id", "requestId"]) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) {
      result.requestId = value
      break
    }
  }
  return result
}

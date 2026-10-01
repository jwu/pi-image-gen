/**
 * Codex（ChatGPT 订阅）的 OAuth 登录与刷新 —— 凭据完全由本插件自己维护。
 *
 * 移植自 ai-canvas 的 `scripts/codex-image-probe.ts`。**刻意不复用 pi 的登录**：
 * pi 里有两个 OpenAI provider（`openai` 与 `openai-codex`），语义重叠、后者又标着 legacy，
 * 混用只会让「到底认到哪份凭据」变得难查。自持一份 `codex` 条目，行为与 ai-canvas 完全一致。
 *
 * 用的是 Codex CLI 的公开 client（`app_EMoamEEZ…`），走 PKCE + 本地回调
 * `127.0.0.1:1455/auth/callback`。只有这条路径拿到的 token 才带 `chatgpt_account_id`，
 * 而 Codex 生图端点必须带 `ChatGPT-Account-ID`。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type Server, type ServerResponse } from "node:http"
import { ImageGenError } from "../util/errors.ts"
import { MAX_TOKEN_RESPONSE_BYTES, readLimitedBytes, withTimeout } from "../util/limits.ts"
import type { ImageGenAuthStore } from "./store.ts"

export const CODEX_PROVIDER_ID = "codex"
export const CODEX_LOGIN_HINT = "run /image-gen login codex"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`
const AUTHORIZE_ENDPOINT = `${ISSUER}/oauth/authorize`
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke"
const ORIGINATOR = "codex_cli_rs"

export const CALLBACK_HOST = "127.0.0.1"
export const CALLBACK_PORT = 1455
export const CALLBACK_PATH = "/auth/callback"
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const TOKEN_REQUEST_TIMEOUT_MS = 60_000
/** access token 距到期不足这个余量就刷新。 */
const TOKEN_REFRESH_MARGIN_MS = 60_000

const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth"

// ---------------------------------------------------------------------------
// PKCE / JWT
// ---------------------------------------------------------------------------

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

function generateState(): string {
  return randomBytes(32).toString("base64url")
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

export function buildAuthorizeUrl(options: {
  redirectUri: string
  challenge: string
  state: string
}): string {
  const url = new URL(AUTHORIZE_ENDPOINT)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: options.redirectUri,
    scope: SCOPE,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: options.state,
    originator: ORIGINATOR,
  }).toString()
  return url.toString()
}

export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  const payload = parts[1]
  if (payload === undefined || payload.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 从 access token 里取账号 id 与到期时间。兼容 auth claim 与顶层两种位置。 */
export function accountIdFromAccessToken(token: string): {
  accountId?: string
  expiresAt?: number
} {
  const claims = decodeJwtClaims(token)
  if (claims === undefined) return {}
  const authClaim = claims[ACCOUNT_ID_CLAIM]
  const nestedId =
    typeof authClaim === "object" && authClaim !== null
      ? (authClaim as Record<string, unknown>)["chatgpt_account_id"]
      : undefined
  const topLevelId = claims["chatgpt_account_id"]
  const accountId =
    typeof nestedId === "string" && nestedId.length > 0
      ? nestedId
      : typeof topLevelId === "string" && topLevelId.length > 0
        ? topLevelId
        : undefined
  const exp = claims["exp"]
  const expiresAt = typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined
  return {
    ...(accountId !== undefined ? { accountId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

// ---------------------------------------------------------------------------
// 本地回调服务器
// ---------------------------------------------------------------------------

interface CallbackServer {
  port: number
  waitForCode: Promise<string>
  close: () => Promise<void>
}

interface ParsedCallback {
  ok: boolean
  status: number
  message: string
  code?: string
}

/** 校验回调请求：路径、state、error 参数、code。不通过就回一个可读的页面。 */
export function parseOAuthCallback(
  requestUrl: string,
  expectedState: string,
  method: string,
): ParsedCallback {
  if (method !== "GET") return { ok: false, status: 405, message: "Method not allowed" }
  let url: URL
  try {
    url = new URL(requestUrl, "http://localhost")
  } catch {
    return { ok: false, status: 400, message: "Malformed callback URL" }
  }
  if (url.pathname !== CALLBACK_PATH) return { ok: false, status: 404, message: "Not found" }
  if (!safeEqual(url.searchParams.get("state") ?? "", expectedState)) {
    return { ok: false, status: 400, message: "State mismatch; callback rejected" }
  }
  const error = url.searchParams.get("error")
  if (error !== null) {
    const description = url.searchParams.get("error_description")
    const detail = description === null ? "" : ` (${description.replace(/[\r\n\t]+/g, " ").slice(0, 200)})`
    return { ok: false, status: 400, message: `Authorization failed: ${error}${detail}` }
  }
  const code = url.searchParams.get("code")
  if (code === null || code.length === 0) {
    return { ok: false, status: 400, message: "Missing authorization code" }
  }
  return { ok: true, status: 200, message: "Authorization complete. You can close this window.", code }
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
  })
  response.end(`${message}\n`)
}

export async function startCallbackServer(options: {
  expectedState: string
  port?: number
  timeoutMs?: number
}): Promise<CallbackServer> {
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined
  const waitForCode = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })
  let completed = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const server: Server = createServer((request, response) => {
    const parsed = parseOAuthCallback(
      request.url ?? "/",
      options.expectedState,
      request.method ?? "GET",
    )
    if (!parsed.ok) {
      respond(response, parsed.status, parsed.message)
      return
    }
    if (completed) {
      respond(response, 409, "Authorization already completed")
      return
    }
    completed = true
    respond(response, parsed.status, parsed.message)
    if (timer !== undefined) clearTimeout(timer)
    settle?.resolve(parsed.code as string)
  })

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? CALLBACK_PORT, CALLBACK_HOST, () => resolve())
  }).catch((error: NodeJS.ErrnoException) => {
    // 端口被占用是最常见的失败：Codex CLI 也用 1455。
    const reason = error.code === "EADDRINUSE" ? "port already in use" : "could not bind the loopback address"
    throw new ImageGenError(
      `Could not start the local callback server on ${CALLBACK_HOST}:${options.port ?? CALLBACK_PORT} (${reason}). ` +
        "Close whatever is using that port (for example the Codex CLI) and try again.",
    )
  })

  timer = setTimeout(() => {
    if (!completed) settle?.reject(new ImageGenError("Codex sign-in timed out. Try again."))
    void close()
  }, options.timeoutMs ?? CALLBACK_TIMEOUT_MS)
  timer.unref?.()

  const address = server.address()
  const port = address !== null && typeof address === "object" ? address.port : CALLBACK_PORT
  return { port, waitForCode, close }
}

// ---------------------------------------------------------------------------
// CodexAuth
// ---------------------------------------------------------------------------

interface TokenSet {
  access: string
  refresh: string
  idToken?: string
}

export interface CodexStatus {
  configured: boolean
  expired: boolean
}

export interface CodexLoginPrompt {
  url: string
  redirectUri: string
}

export interface CodexAuthOptions {
  store: ImageGenAuthStore
  fetch: typeof fetch
  now: () => number
  timeoutMs?: number
  callbackPort?: number
  callbackTimeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseTokenSet(body: unknown, fallbackRefresh?: string): TokenSet {
  if (!isRecord(body)) throw new ImageGenError("Unexpected Codex authorization response.")
  const access = body["access_token"]
  if (typeof access !== "string" || access.length === 0) {
    throw new ImageGenError("Unexpected Codex authorization response.")
  }
  const refresh = body["refresh_token"]
  const resolvedRefresh =
    typeof refresh === "string" && refresh.length > 0 ? refresh : fallbackRefresh
  if (resolvedRefresh === undefined) {
    throw new ImageGenError("The Codex authorization did not return a refresh credential.")
  }
  const idToken = body["id_token"]
  return {
    access,
    refresh: resolvedRefresh,
    ...(typeof idToken === "string" && idToken.length > 0 ? { idToken } : {}),
  }
}

export class CodexAuth {
  private readonly store: ImageGenAuthStore
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly callbackPort: number
  private readonly callbackTimeoutMs: number
  /** 登出或重新登录时自增；迟到的 token 交换因此无法再写回凭据。 */
  private epoch = 0

  constructor(options: CodexAuthOptions) {
    this.store = options.store
    this.fetchImpl = options.fetch
    this.now = options.now
    this.timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS
    this.callbackPort = options.callbackPort ?? CALLBACK_PORT
    this.callbackTimeoutMs = options.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS
  }

  /** 本地读，不刷新、不发网络请求。 */
  async status(): Promise<CodexStatus> {
    const credential = await this.store.read(CODEX_PROVIDER_ID).catch(() => undefined)
    if (credential?.type !== "oauth") return { configured: false, expired: false }
    return { configured: true, expired: credential.expires <= this.now() }
  }

  /**
   * 走 PKCE + 本地回调完成登录。`onPrompt` 拿到授权网址后由调用方展示给用户。
   */
  async login(onPrompt: (prompt: CodexLoginPrompt) => void, signal?: AbortSignal): Promise<void> {
    const epoch = ++this.epoch
    const pkce = generatePkce()
    const state = generateState()

    const server = await startCallbackServer({
      expectedState: state,
      port: this.callbackPort,
      timeoutMs: this.callbackTimeoutMs,
    })
    const redirectUri = `http://localhost:${server.port}${CALLBACK_PATH}`

    try {
      if (epoch !== this.epoch) throw new ImageGenError("Codex sign-in was cancelled.")
      onPrompt({ url: buildAuthorizeUrl({ redirectUri, challenge: pkce.challenge, state }), redirectUri })

      const code = await Promise.race([server.waitForCode, rejectionOnAbort(signal)])
      if (epoch !== this.epoch) throw new ImageGenError("Codex sign-in was cancelled.")

      const tokens = await this.exchangeCode(code, pkce.verifier, redirectUri, signal)
      await this.store.modify(CODEX_PROVIDER_ID, async (current) => {
        if (current !== undefined && current.type !== "oauth") {
          throw new ImageGenError("Conflicting credential type for Codex. Remove the stored credential first.")
        }
        if (epoch !== this.epoch) throw new ImageGenError("Codex sign-in was cancelled.")
        return this.toCredential(tokens)
      })
    } finally {
      await server.close()
    }
  }

  async logout(): Promise<void> {
    this.epoch += 1
    await this.store.delete(CODEX_PROVIDER_ID)
  }

  /** 每次生图前取一份可用凭据，必要时在凭据库的锁内刷新。 */
  async credentials(signal?: AbortSignal): Promise<{ access: string; accountId: string }> {
    const epoch = this.epoch
    const result = await this.store.modify(CODEX_PROVIDER_ID, async (current) => {
      if (current?.type !== "oauth") {
        throw new ImageGenError(`Not signed in to Codex. ${CODEX_LOGIN_HINT}`)
      }
      if (current.expires > this.now() + TOKEN_REFRESH_MARGIN_MS) return current

      const tokens = await this.refresh(current.refresh, signal)
      const refreshed = this.toCredential(tokens, current.accountId)
      return refreshed
    })

    if (epoch !== this.epoch || signal?.aborted === true) {
      throw new ImageGenError("The Codex authorization state changed. Try again.")
    }
    if (result?.type !== "oauth") {
      throw new ImageGenError(`Not signed in to Codex. ${CODEX_LOGIN_HINT}`)
    }
    if (result.accountId === undefined || result.accountId.length === 0) {
      throw new ImageGenError("Codex credentials are missing the account id. Sign in again.")
    }
    return { access: result.access, accountId: result.accountId }
  }

  // -------------------------------------------------------------------------

  private toCredential(
    tokens: TokenSet,
    fallbackAccountId?: string,
  ): {
    type: "oauth"
    access: string
    refresh: string
    expires: number
    accountId?: string
  } {
    const { accountId, expiresAt } = accountIdFromAccessToken(tokens.access)
    const resolvedAccountId = accountId ?? fallbackAccountId
    return {
      type: "oauth",
      access: tokens.access,
      refresh: tokens.refresh,
      // 优先用 JWT 的 exp；解析不出来时退到一个保守的 1 小时，让下次调用触发刷新。
      expires: expiresAt ?? this.now() + 60 * 60 * 1000,
      ...(resolvedAccountId !== undefined ? { accountId: resolvedAccountId } : {}),
    }
  }

  private async exchangeCode(
    code: string,
    verifier: string,
    redirectUri: string,
    signal?: AbortSignal,
  ): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    })
    const response = await this.postForm(TOKEN_ENDPOINT, body, signal)
    if (!response.ok) {
      throw new ImageGenError(`Codex sign-in failed while exchanging the authorization code (HTTP ${response.status}).`)
    }
    return parseTokenSet(await this.readJson(response))
  }

  private async refresh(refreshToken: string, signal?: AbortSignal): Promise<TokenSet> {
    const response = await this.postJson(
      TOKEN_ENDPOINT,
      JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal,
    )
    if (!response.ok) {
      throw new ImageGenError("Failed to refresh Codex credentials. Sign in again.")
    }
    return parseTokenSet(await this.readJson(response), refreshToken)
  }

  private async readJson(response: Response): Promise<unknown> {
    const bytes = await readLimitedBytes(response, MAX_TOKEN_RESPONSE_BYTES)
    if (bytes.byteLength === 0) return undefined
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown
    } catch {
      throw new ImageGenError("Unexpected Codex authorization response.")
    }
  }

  private async postForm(url: string, body: URLSearchParams, signal?: AbortSignal): Promise<Response> {
    return this.send(url, String(body), "application/x-www-form-urlencoded", signal)
  }

  private async postJson(url: string, body: string, signal?: AbortSignal): Promise<Response> {
    return this.send(url, body, "application/json", signal)
  }

  private async send(
    url: string,
    body: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = withTimeout(this.timeoutMs, signal)
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          Accept: "application/json",
          originator: ORIGINATOR,
        },
        body,
        redirect: "error",
        signal: timeout.signal,
      })
    } catch (error) {
      if (error instanceof ImageGenError) throw error
      if (timeout.timedOut()) throw new ImageGenError("The Codex authorization request timed out.")
      throw new ImageGenError("The Codex authorization request failed.")
    } finally {
      timeout.dispose()
    }
  }
}

/** 把取消信号变成一个永挂的 rejection，用于和回调等待赛跑。 */
function rejectionOnAbort(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return
    const fail = () => reject(new ImageGenError("Codex sign-in was cancelled."))
    if (signal.aborted) fail()
    else signal.addEventListener("abort", fail, { once: true })
  })
}

/**
 * Grok（x.ai）的 OAuth2 device code 登录与刷新。
 *
 * 移植自 ai-canvas 的 `scripts/grok-image-probe.ts`，但去掉跨进程 attempt 文件那一层：
 * 登录只由本进程的 `/image-gen login grok` 触发，用一个内存 epoch 就足以处理取消与竞态。
 *
 * 两点安全约定照搬不变：
 * - `verification_uri` 必须在官方主机白名单内，防止上游把用户引到任意网址；
 * - 刷新在凭据库的锁内做，跨进程也不会重复轮换 refresh token。
 */
import { ImageGenError } from "../util/errors.ts"
import { MAX_TOKEN_RESPONSE_BYTES, readLimitedBytes, withTimeout } from "../util/limits.ts"
import type { ImageGenAuthStore } from "./store.ts"

export const GROK_PROVIDER_ID = "grok"
export const GROK_LOGIN_HINT = "run /image-gen login grok"

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write"
const DEVICE_URL = "https://auth.x.ai/oauth2/device/code"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const VERIFICATION_HOSTS = ["accounts.x.ai", "auth.x.ai"]
const TOKEN_REQUEST_TIMEOUT_MS = 30_000
/** access token 距到期不足这个余量就刷新。 */
const TOKEN_REFRESH_MARGIN_MS = 60_000

export interface GrokDeviceCode {
  userCode: string
  verificationUrl: string
  intervalSeconds: number
  expiresInSeconds: number
}

export interface GrokStatus {
  configured: boolean
  expired: boolean
}

export interface GrokAuthOptions {
  store: ImageGenAuthStore
  fetch: typeof fetch
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ImageGenError("Unexpected Grok authorization response.")
  }
  return value
}

function requirePositiveNumber(value: unknown, fallback?: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  if (fallback !== undefined) return fallback
  throw new ImageGenError("Unexpected Grok authorization response.")
}

/** 只允许官方主机、https、无端口与用户信息，避免被上游塞任意链接。 */
export function assertVerificationUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ImageGenError("Invalid Grok verification URL.")
  }
  if (
    url.protocol !== "https:" ||
    !VERIFICATION_HOSTS.includes(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ImageGenError("The Grok verification URL is not on the official allowlist.")
  }
  return url.href
}

interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
}

export function parseDeviceCodeResponse(body: unknown): DeviceCode {
  if (!isRecord(body)) throw new ImageGenError("Unexpected Grok authorization response.")
  const userCode = requireString(body["user_code"])
  if (!/^[A-Za-z0-9 -]{1,64}$/.test(userCode)) {
    throw new ImageGenError("Unexpected Grok authorization response.")
  }
  const deviceCode = requireString(body["device_code"])
  const verificationUri = requireString(body["verification_uri"])
  const result: DeviceCode = {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: requirePositiveNumber(body["expires_in"]),
    interval: requirePositiveNumber(body["interval"], 5),
  }
  const complete = body["verification_uri_complete"]
  if (typeof complete === "string" && complete.length > 0) {
    result.verificationUriComplete = complete
  }
  return result
}

interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresIn: number
}

export function parseTokenResponse(body: unknown): TokenResponse {
  if (!isRecord(body)) throw new ImageGenError("Unexpected Grok authorization response.")
  const result: TokenResponse = {
    accessToken: requireString(body["access_token"]),
    expiresIn: requirePositiveNumber(body["expires_in"]),
  }
  const refresh = body["refresh_token"]
  if (typeof refresh === "string" && refresh.length > 0) result.refreshToken = refresh
  return result
}

function errorCodeOf(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const error = body["error"]
  if (typeof error === "string") return error
  if (isRecord(error) && typeof error["code"] === "string") return error["code"]
  return undefined
}

export class GrokAuth {
  private readonly store: ImageGenAuthStore
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly timeoutMs: number
  /** 登出或重新登录时自增；迟到的 token 交换因此无法再写回凭据。 */
  private epoch = 0

  constructor(options: GrokAuthOptions) {
    this.store = options.store
    this.fetchImpl = options.fetch
    this.now = options.now
    this.sleep = options.sleep
    this.timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS
  }

  /** 本地读，不刷新、不发网络请求。 */
  async status(): Promise<GrokStatus> {
    const credential = await this.store.read(GROK_PROVIDER_ID).catch(() => undefined)
    if (credential?.type !== "oauth") return { configured: false, expired: false }
    return { configured: true, expired: credential.expires <= this.now() }
  }

  async login(onCode: (code: GrokDeviceCode) => void, signal?: AbortSignal): Promise<void> {
    const epoch = ++this.epoch
    const started = await this.post(DEVICE_URL, { client_id: CLIENT_ID, scope: SCOPE }, signal)
    if (started.status !== 200) throw new ImageGenError("Could not start the Grok authorization.")

    const device = parseDeviceCodeResponse(started.body)
    const verificationUrl = assertVerificationUrl(
      device.verificationUriComplete ?? device.verificationUri,
    )
    onCode({
      userCode: device.userCode,
      verificationUrl,
      intervalSeconds: device.interval,
      expiresInSeconds: device.expiresIn,
    })

    const deadline = this.now() + device.expiresIn * 1000
    let intervalMs = device.interval * 1000
    while (this.now() < deadline) {
      this.assertCurrent(epoch, signal)
      await this.sleep(Math.min(intervalMs, Math.max(0, deadline - this.now())), signal)
      if (this.now() >= deadline) break

      const response = await this.post(
        TOKEN_URL,
        {
          client_id: CLIENT_ID,
          grant_type: DEVICE_GRANT,
          device_code: device.deviceCode,
        },
        signal,
      )

      if (response.status === 200) {
        this.assertCurrent(epoch, signal)
        const token = parseTokenResponse(response.body)
        if (token.refreshToken === undefined) {
          throw new ImageGenError("The Grok authorization did not return a refresh credential.")
        }
        await this.store.modify(GROK_PROVIDER_ID, async (current) => {
          if (current !== undefined && current.type !== "oauth") {
            throw new ImageGenError("Conflicting credential type for Grok. Remove the stored API key first.")
          }
          if (epoch !== this.epoch) throw new ImageGenError("Sign-in was cancelled.")
          return {
            type: "oauth",
            access: token.accessToken,
            refresh: token.refreshToken as string,
            expires: this.now() + token.expiresIn * 1000,
          }
        })
        return
      }

      const error = errorCodeOf(response.body)
      if (error === "authorization_pending") continue
      if (error === "slow_down") {
        intervalMs += 5_000
        continue
      }
      throw new ImageGenError(
        error === "access_denied"
          ? "The Grok authorization was denied."
          : error === "expired_token"
            ? "The Grok authorization code expired."
            : "Grok authorization failed.",
      )
    }
    throw new ImageGenError("The Grok authorization code expired.")
  }

  async logout(): Promise<void> {
    this.epoch += 1
    await this.store.delete(GROK_PROVIDER_ID)
  }

  /** 每次生图前取一组可用的 header，必要时在凭据库的锁内刷新。 */
  async headers(signal?: AbortSignal): Promise<Record<string, string>> {
    const epoch = this.epoch
    const result = await this.store.modify(GROK_PROVIDER_ID, async (current) => {
      if (current?.type !== "oauth") {
        throw new ImageGenError(`Not signed in to Grok. ${GROK_LOGIN_HINT}`)
      }
      if (current.expires > this.now() + TOKEN_REFRESH_MARGIN_MS) return current

      const response = await this.post(
        TOKEN_URL,
        {
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: current.refresh,
        },
        signal,
      )
      if (response.status !== 200) {
        throw new ImageGenError("Failed to refresh Grok credentials. Sign in again.")
      }
      const token = parseTokenResponse(response.body)
      return {
        type: "oauth" as const,
        access: token.accessToken,
        refresh: token.refreshToken ?? current.refresh,
        expires: this.now() + token.expiresIn * 1000,
      }
    })

    if (epoch !== this.epoch || signal?.aborted === true) {
      throw new ImageGenError("The Grok authorization state changed. Try again.")
    }
    if (result?.type !== "oauth") {
      throw new ImageGenError(`Not signed in to Grok. ${GROK_LOGIN_HINT}`)
    }
    return { Authorization: `Bearer ${result.access}`, "x-xai-token-auth": "xai-grok-cli" }
  }

  private assertCurrent(epoch: number, signal?: AbortSignal): void {
    if (epoch !== this.epoch || signal?.aborted === true) {
      throw new ImageGenError("Grok sign-in was cancelled.")
    }
  }

  private async post(
    url: string,
    values: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    const timeout = withTimeout(this.timeoutMs, signal)
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(values),
        redirect: "error",
        signal: timeout.signal,
      })
      const bytes = await readLimitedBytes(response, MAX_TOKEN_RESPONSE_BYTES)
      let body: unknown
      try {
        body = bytes.byteLength === 0 ? undefined : (JSON.parse(new TextDecoder().decode(bytes)) as unknown)
      } catch {
        body = undefined
      }
      return { status: response.status, body }
    } catch (error) {
      if (error instanceof ImageGenError) throw error
      if (timeout.timedOut()) throw new ImageGenError("The Grok authorization request timed out.")
      throw new ImageGenError("The Grok authorization request failed.")
    } finally {
      timeout.dispose()
    }
  }
}

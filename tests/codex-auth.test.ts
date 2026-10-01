import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { request } from "node:http"
import {
  accountIdFromAccessToken,
  buildAuthorizeUrl,
  CodexAuth,
  decodeJwtClaims,
  generatePkce,
  parseOAuthCallback,
} from "../src/auth/codex.ts"
import { ImageGenAuthStore } from "../src/auth/store.ts"
import { ImageGenError } from "../src/util/errors.ts"
import { jsonResponse, temporaryAuthPath } from "./helpers.ts"

/** 用 node:http 而不是 fetch：测试环境有 HTTP_PROXY，而 fetch 可能被环境变量影响。 */
function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url.replace("//localhost:", "//127.0.0.1:"), (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        body += chunk
      })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on("error", reject)
    req.end()
  })
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    access_token: jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-1",
    ...overrides,
  })
}

function sequenceFetch(steps: Array<() => Response>) {
  const calls: Array<{ url: string; body: string; contentType: string | undefined }> = []
  let index = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      body: String(init?.body ?? ""),
      contentType: headers["Content-Type"],
    })
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    if (step === undefined) throw new Error("no more stubbed responses")
    return step()
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

function makeAuth(options: {
  fetch: typeof fetch
  now?: () => number
  callbackPort?: number
  callbackTimeoutMs?: number
}): { auth: CodexAuth; store: ImageGenAuthStore } {
  const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
  const auth = new CodexAuth({
    store,
    fetch: options.fetch,
    now: options.now ?? (() => Date.now()),
    // 端口 0 = 让系统分配，避免测试之间抢 1455。
    callbackPort: options.callbackPort ?? 0,
    callbackTimeoutMs: options.callbackTimeoutMs ?? 5_000,
  })
  return { auth, store }
}

describe("generatePkce", () => {
  test("challenge 是 verifier 的 SHA-256 base64url", () => {
    const { verifier, challenge } = generatePkce()
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"))
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test("每次生成都不同", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier)
  })
})

describe("buildAuthorizeUrl", () => {
  test("带上 PKCE、state 与 Codex CLI 的简化流程参数", () => {
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: "http://localhost:1455/auth/callback",
        challenge: "challenge-1",
        state: "state-1",
      }),
    )
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    const params = url.searchParams
    expect(params.get("response_type")).toBe("code")
    expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(params.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
    expect(params.get("code_challenge")).toBe("challenge-1")
    expect(params.get("code_challenge_method")).toBe("S256")
    expect(params.get("state")).toBe("state-1")
    expect(params.get("codex_cli_simplified_flow")).toBe("true")
    expect(params.get("originator")).toBe("codex_cli_rs")
    expect(params.get("scope")).toContain("offline_access")
  })
})

describe("accountIdFromAccessToken", () => {
  test("取 auth claim 下的 chatgpt_account_id 与 exp", () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" },
      exp: 1_700_000_000,
    })
    expect(accountIdFromAccessToken(token)).toEqual({
      accountId: "acct-9",
      expiresAt: 1_700_000_000_000,
    })
  })

  test("兼容顶层字段，缺失时返回空对象", () => {
    expect(accountIdFromAccessToken(jwt({ chatgpt_account_id: "top" })).accountId).toBe("top")
    expect(accountIdFromAccessToken(jwt({ sub: "u" }))).toEqual({})
    expect(accountIdFromAccessToken("garbage")).toEqual({})
  })

  test("decodeJwtClaims 拒非 JWT", () => {
    expect(decodeJwtClaims("a.b")).toBeUndefined()
  })
})

describe("parseOAuthCallback", () => {
  test("正常回调返回 code", () => {
    const parsed = parseOAuthCallback("/auth/callback?code=c1&state=s1", "s1", "GET")
    expect(parsed).toMatchObject({ ok: true, status: 200, code: "c1" })
  })

  test("state 不匹配时拒绝", () => {
    const parsed = parseOAuthCallback("/auth/callback?code=c1&state=wrong", "s1", "GET")
    expect(parsed.ok).toBe(false)
    expect(parsed.message).toContain("State mismatch")
  })

  test("上游带回 error 时拒绝并保留原因", () => {
    const parsed = parseOAuthCallback(
      "/auth/callback?error=access_denied&error_description=user%20said%20no&state=s1",
      "s1",
      "GET",
    )
    expect(parsed.ok).toBe(false)
    expect(parsed.message).toContain("access_denied")
  })

  test("缺 code、错误方法、错误路径都拒绝", () => {
    expect(parseOAuthCallback("/auth/callback?state=s1", "s1", "GET").ok).toBe(false)
    expect(parseOAuthCallback("/auth/callback?code=c&state=s1", "s1", "POST").status).toBe(405)
    expect(parseOAuthCallback("/other?code=c&state=s1", "s1", "GET").status).toBe(404)
  })
})

describe("CodexAuth.login", () => {
  test("完整流程：回调带 code 后交换 token 并写入凭据", async () => {
    const { fetch, calls } = sequenceFetch([() => tokenResponse()])
    const { auth, store } = makeAuth({ fetch })

    let callback: Promise<unknown> | undefined
    await auth.login((prompt) => {
      const state = new URL(prompt.url).searchParams.get("state") ?? ""
      callback = httpGet(`${prompt.redirectUri}?code=code-1&state=${state}`)
    })
    await callback

    // 交换请求
    expect(calls[0]?.url).toBe("https://auth.openai.com/oauth/token")
    expect(calls[0]?.contentType).toBe("application/x-www-form-urlencoded")
    const body = new URLSearchParams(calls[0]?.body ?? "")
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("code-1")
    expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(body.get("code_verifier")).toBeTruthy()

    const stored = await store.read("codex")
    expect(stored?.type).toBe("oauth")
    expect(stored).toMatchObject({ refresh: "refresh-1", accountId: "acct-1" })
  })

  test("state 不匹配的回调被拒，且不会写凭据", async () => {
    const { fetch } = sequenceFetch([() => tokenResponse()])
    const { auth, store } = makeAuth({ fetch, callbackTimeoutMs: 300 })

    let rejectedStatus = 0
    const login = auth.login((prompt) => {
      // 伪造的 state 应当被拒绝；服务器继续等待合法回调，直到超时。
      void httpGet(`${prompt.redirectUri}?code=code-1&state=forged`).then((result) => {
        rejectedStatus = result.status
      })
    })
    await expect(login).rejects.toThrow(/timed out/)
    expect(rejectedStatus).toBe(400)
    expect(await store.read("codex")).toBeUndefined()
  })

  test("回调端口被占用时给出可读错误", async () => {
    const blocker = createServer(() => {})
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()))
    const port = (blocker.address() as AddressInfo).port

    const { fetch } = sequenceFetch([() => tokenResponse()])
    const { auth } = makeAuth({ fetch, callbackPort: port })
    await expect(auth.login(() => {})).rejects.toThrow(/port already in use/)
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  })
})

describe("CodexAuth.credentials", () => {
  test("未登录时报错并给出登录命令", async () => {
    const { fetch } = sequenceFetch([])
    const { auth } = makeAuth({ fetch })
    await expect(auth.credentials()).rejects.toThrow(/login codex/)
  })

  test("凭据还新鲜时不发刷新请求", async () => {
    const { fetch, calls } = sequenceFetch([])
    const now = 1_000_000
    const { auth, store } = makeAuth({ fetch, now: () => now })
    await store.set("codex", {
      type: "oauth",
      access: "fresh",
      refresh: "r",
      expires: now + 3_600_000,
      accountId: "acct-1",
    })

    expect(await auth.credentials()).toEqual({ access: "fresh", accountId: "acct-1" })
    expect(calls).toHaveLength(0)
  })

  test("临近过期时刷新并写回", async () => {
    const now = 1_000_000
    const { fetch, calls } = sequenceFetch([() => tokenResponse({ refresh_token: "refresh-2" })])
    const { auth, store } = makeAuth({ fetch, now: () => now })
    await store.set("codex", {
      type: "oauth",
      access: "old",
      refresh: "refresh-1",
      expires: now + 1_000,
      accountId: "acct-1",
    })

    const credentials = await auth.credentials()
    expect(credentials.accountId).toBe("acct-1")
    expect(calls[0]?.contentType).toBe("application/json")
    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>
    expect(body["grant_type"]).toBe("refresh_token")
    expect(body["refresh_token"]).toBe("refresh-1")

    const stored = await store.read("codex")
    expect(stored).toMatchObject({ refresh: "refresh-2" })
  })

  test("刷新失败时提示重新登录", async () => {
    const now = 1_000_000
    const { fetch } = sequenceFetch([() => jsonResponse({ error: "invalid_grant" }, 400)])
    const { auth, store } = makeAuth({ fetch, now: () => now })
    await store.set("codex", {
      type: "oauth",
      access: "old",
      refresh: "r",
      expires: now,
      accountId: "acct-1",
    })
    await expect(auth.credentials()).rejects.toThrow(/refresh Codex credentials/)
  })
})

describe("CodexAuth.status / logout", () => {
  test("status 反映配置与过期状态", async () => {
    const { fetch } = sequenceFetch([])
    const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
    const auth = new CodexAuth({ store, fetch, now: () => 1_000 })

    expect(await auth.status()).toEqual({ configured: false, expired: false })

    await store.set("codex", { type: "oauth", access: "a", refresh: "r", expires: 500 })
    expect(await auth.status()).toEqual({ configured: true, expired: true })

    await store.set("codex", { type: "oauth", access: "a", refresh: "r", expires: 99_999 })
    expect(await auth.status()).toEqual({ configured: true, expired: false })
  })

  test("logout 删除凭据", async () => {
    const { fetch } = sequenceFetch([])
    const { auth, store } = makeAuth({ fetch })
    await store.set("codex", { type: "oauth", access: "a", refresh: "r", expires: 1 })
    await auth.logout()
    expect(await store.read("codex")).toBeUndefined()
  })
})

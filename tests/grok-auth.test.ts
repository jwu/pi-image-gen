import { describe, expect, test } from "bun:test"
import { GrokAuth, assertVerificationUrl, parseDeviceCodeResponse } from "../src/auth/grok.ts"
import { ImageGenAuthStore } from "../src/auth/store.ts"
import { ImageGenError } from "../src/util/errors.ts"
import { jsonResponse, temporaryAuthPath } from "./helpers.ts"

/** 按调用顺序返回响应的 fetch 桩。 */
function sequenceFetch(steps: Array<(url: string) => Response>) {
  const calls: Array<{ url: string; body: URLSearchParams }> = []
  let index = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) })
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    if (step === undefined) throw new Error("no more stubbed responses")
    return step(url)
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

function deviceCodeResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    device_code: "device-1",
    user_code: "ABCD-1234",
    verification_uri: "https://auth.x.ai/device",
    verification_uri_complete: "https://auth.x.ai/device?user_code=ABCD-1234",
    expires_in: 600,
    interval: 1,
    ...overrides,
  })
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 3600,
    token_type: "Bearer",
    ...overrides,
  })
}

function makeAuth(options: { fetch: typeof fetch; now: () => number; sleep?: () => Promise<void> }) {
  const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
  const auth = new GrokAuth({
    store,
    fetch: options.fetch,
    now: options.now,
    sleep: async () => {
      await options.sleep?.()
    },
  })
  return { auth, store }
}

describe("assertVerificationUrl", () => {
  test("接受官方主机", () => {
    expect(assertVerificationUrl("https://auth.x.ai/device")).toBe("https://auth.x.ai/device")
    expect(assertVerificationUrl("https://accounts.x.ai/x")).toBe("https://accounts.x.ai/x")
  })

  test("拒绝非白名单主机、非 https、带端口或用户信息", () => {
    for (const url of [
      "https://evil.example/device",
      "http://auth.x.ai/device",
      "https://auth.x.ai:8443/device",
      "https://user:pass@auth.x.ai/device",
      "not a url",
    ]) {
      expect(() => assertVerificationUrl(url)).toThrow(ImageGenError)
    }
  })
})

describe("parseDeviceCodeResponse", () => {
  test("解析正常响应并带默认 interval", () => {
    const parsed = parseDeviceCodeResponse({
      device_code: "d",
      user_code: "AB-12",
      verification_uri: "https://auth.x.ai/d",
      expires_in: 600,
    })
    expect(parsed.interval).toBe(5)
  })

  test("user_code 含非法字符时报错", () => {
    expect(() =>
      parseDeviceCodeResponse({
        device_code: "d",
        user_code: "../../etc",
        verification_uri: "https://auth.x.ai/d",
        expires_in: 600,
      }),
    ).toThrow(ImageGenError)
  })

  test("缺字段时报错", () => {
    expect(() => parseDeviceCodeResponse({ device_code: "d" })).toThrow(ImageGenError)
    expect(() => parseDeviceCodeResponse(null)).toThrow(ImageGenError)
  })
})

describe("GrokAuth.login", () => {
  test("轮询到 token 后写入凭据", async () => {
    const { fetch, calls } = sequenceFetch([
      () => deviceCodeResponse(),
      () => jsonResponse({ error: "authorization_pending" }, 400),
      () => tokenResponse(),
    ])
    const { auth, store } = makeAuth({ fetch, now: () => 1_000 })
    const codes: string[] = []

    await auth.login((code) => codes.push(`${code.userCode}|${code.verificationUrl}`))

    expect(codes).toEqual(["ABCD-1234|https://auth.x.ai/device?user_code=ABCD-1234"])
    expect(calls[0]?.url).toBe("https://auth.x.ai/oauth2/device/code")
    expect(calls[0]?.body.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828")
    expect(calls[2]?.body.get("device_code")).toBe("device-1")
    expect(calls[2]?.body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    )
    expect(await store.read("grok")).toEqual({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: 1_000 + 3_600_000,
    })
  })

  test("authorization_pending 会继续轮询，不报错", async () => {
    const { fetch } = sequenceFetch([
      () => deviceCodeResponse(),
      () => jsonResponse({ error: "authorization_pending" }, 400),
      () => jsonResponse({ error: "authorization_pending" }, 400),
      () => tokenResponse(),
    ])
    const { auth } = makeAuth({ fetch, now: () => 0 })
    await auth.login(() => {})
  })

  test("slow_down 拉长间隔后继续", async () => {
    const waits: number[] = []
    const { fetch } = sequenceFetch([
      () => deviceCodeResponse({ interval: 1 }),
      () => jsonResponse({ error: "slow_down" }, 400),
      () => tokenResponse(),
    ])
    const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
    const auth = new GrokAuth({
      store,
      fetch,
      now: () => 0,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    await auth.login(() => {})
    expect(waits).toEqual([1000, 6000])
  })

  test("access_denied 直接失败", async () => {
    const { fetch } = sequenceFetch([
      () => deviceCodeResponse(),
      () => jsonResponse({ error: "access_denied" }, 400),
    ])
    const { auth, store } = makeAuth({ fetch, now: () => 0 })
    await expect(auth.login(() => {})).rejects.toThrow(/denied/)
    expect(await store.read("grok")).toBeUndefined()
  })

  test("授权响应缺少 refresh_token 时报错", async () => {
    const { fetch } = sequenceFetch([
      () => deviceCodeResponse(),
      () => tokenResponse({ refresh_token: undefined }),
    ])
    const { auth } = makeAuth({ fetch, now: () => 0 })
    await expect(auth.login(() => {})).rejects.toThrow(/refresh credential/)
  })

  test("cancel 后不再写回凭据", async () => {
    const controller = new AbortController()
    const { fetch } = sequenceFetch([
      () => deviceCodeResponse(),
      () => tokenResponse(),
    ])
    const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
    const auth = new GrokAuth({
      store,
      fetch,
      now: () => 0,
      sleep: async () => {
        controller.abort()
      },
    })
    await expect(auth.login(() => {}, controller.signal)).rejects.toThrow(/cancelled/)
    expect(await store.read("grok")).toBeUndefined()
  })
})

describe("GrokAuth.headers", () => {
  test("未登录时报错并给出登录提示", async () => {
    const { fetch } = sequenceFetch([])
    const { auth } = makeAuth({ fetch, now: () => 0 })
    await expect(auth.headers()).rejects.toThrow(/Not signed in/)
  })

  test("凭据还新鲜时不发刷新请求", async () => {
    const { fetch, calls } = sequenceFetch([])
    const { auth, store } = makeAuth({ fetch, now: () => 1_000 })
    await store.set("grok", {
      type: "oauth",
      access: "fresh",
      refresh: "r",
      expires: 1_000 + 3_600_000,
    })

    expect(await auth.headers()).toEqual({
      Authorization: "Bearer fresh",
      "x-xai-token-auth": "xai-grok-cli",
    })
    expect(calls).toHaveLength(0)
  })

  test("临近过期时刷新并写回新 token", async () => {
    let now = 1_000
    const { fetch, calls } = sequenceFetch([() => tokenResponse({ access_token: "new", refresh_token: "r2" })])
    const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
    const auth = new GrokAuth({ store, fetch, now: () => now, sleep: async () => {} })
    await store.set("grok", { type: "oauth", access: "old", refresh: "r1", expires: now + 1_000 })

    const headers = await auth.headers()
    expect(headers["Authorization"]).toBe("Bearer new")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.get("grant_type")).toBe("refresh_token")
    expect(calls[0]?.body.get("refresh_token")).toBe("r1")

    const stored = await store.read("grok")
    expect(stored).toMatchObject({ access: "new", refresh: "r2" })
  })

  test("刷新失败时提示重新登录", async () => {
    let now = 1_000
    const { fetch } = sequenceFetch([() => jsonResponse({ error: "invalid_grant" }, 400)])
    const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
    const auth = new GrokAuth({ store, fetch, now: () => now, sleep: async () => {} })
    await store.set("grok", { type: "oauth", access: "old", refresh: "r1", expires: now })

    await expect(auth.headers()).rejects.toThrow(/refresh Grok credentials/)
  })
})

describe("GrokAuth.status / logout", () => {
  test("status 反映配置与过期状态", async () => {
    const { fetch } = sequenceFetch([])
    const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
    const auth = new GrokAuth({ store, fetch, now: () => 1_000, sleep: async () => {} })

    expect(await auth.status()).toEqual({ configured: false, expired: false })

    await store.set("grok", { type: "oauth", access: "a", refresh: "r", expires: 500 })
    expect(await auth.status()).toEqual({ configured: true, expired: true })

    await store.set("grok", { type: "oauth", access: "a", refresh: "r", expires: 99_999 })
    expect(await auth.status()).toEqual({ configured: true, expired: false })
  })

  test("logout 删除凭据", async () => {
    const { fetch } = sequenceFetch([])
    const { auth, store } = makeAuth({ fetch, now: () => 0 })
    await store.set("grok", { type: "oauth", access: "a", refresh: "r", expires: 1 })
    await auth.logout()
    expect(await store.read("grok")).toBeUndefined()
  })
})

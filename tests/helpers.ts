/**
 * 测试公共设施。
 *
 * 所有测试都用假 fetch 与临时凭据文件，**不发起真实请求、不接触真实凭据、不产生任何费用**。
 */
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexAuth } from "../src/auth/codex.ts"
import { GrokAuth } from "../src/auth/grok.ts"
import { ImageGenAuthStore } from "../src/auth/store.ts"
import type { ChannelDeps } from "../src/channels/types.ts"

/** 一段合法的 PNG 前缀，足够通过签名判定。 */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

export function pngBase64(bytes: Uint8Array = PNG_BYTES): string {
  return Buffer.from(bytes).toString("base64")
}

export function jpegBase64(bytes: Uint8Array = JPEG_BYTES): string {
  return Buffer.from(bytes).toString("base64")
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export function temporaryAuthPath(): string {
  return join(tmpdir(), `pi-image-gen-test-${randomUUID()}`, "auth.json")
}

export function makeDeps(overrides: Partial<ChannelDeps> = {}): ChannelDeps {
  const store =
    overrides.store ?? new ImageGenAuthStore({ filePath: temporaryAuthPath() })
  const merged: Omit<ChannelDeps, "grokAuth" | "codexAuth"> = {
    fetch: (async () => {
      throw new Error("fetch was not stubbed")
    }) as unknown as typeof fetch,
    store,
    env: {},
    timeoutMs: 5_000,
    now: () => Date.now(),
    sleep: async () => {},
    ...overrides,
  }
  return {
    ...merged,
    // 两套 auth 默认接在同一套假依赖上；单个测试要自定义时直接传 overrides。
    grokAuth:
      overrides.grokAuth ??
      new GrokAuth({
        store: merged.store,
        fetch: merged.fetch,
        now: merged.now,
        sleep: merged.sleep,
      }),
    codexAuth:
      overrides.codexAuth ??
      new CodexAuth({ store: merged.store, fetch: merged.fetch, now: merged.now }),
  }
}

/** 收集 fetch 调用的桩：返回预设响应，并把请求记录下来供断言。 */
export function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

export function bodyText(init: RequestInit | undefined): string {
  const body = init?.body
  if (typeof body === "string") return body
  return ""
}

export function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(bodyText(init) || "{}")
  if (typeof parsed !== "object" || parsed === null) throw new Error("body is not an object")
  return parsed as Record<string, unknown>
}

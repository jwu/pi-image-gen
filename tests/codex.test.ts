import { describe, expect, test } from "bun:test"
import type { CodexAuth } from "../src/auth/codex.ts"
import { ImageGenAuthStore } from "../src/auth/store.ts"
import {
  buildCodexBody,
  codexChannel,
  CODEX_BASE_URL,
  CODEX_ORIGINATOR,
} from "../src/channels/codex.ts"
import type { GenerateInput } from "../src/channels/types.ts"
import { ImageGenError } from "../src/util/errors.ts"
import type { ReferenceImage } from "../src/util/image.ts"
import { jsonBody, jsonResponse, makeDeps, PNG_BYTES, pngBase64, stubFetch, temporaryAuthPath } from "./helpers.ts"

const CREDENTIALS = { access: "access-token", accountId: "acct-1" }

function input(overrides: Partial<GenerateInput> = {}): GenerateInput {
  return { prompt: "a cat", model: "gpt-image-2", n: 1, references: [], ...overrides }
}

function reference(path = "ref.png"): ReferenceImage {
  return { path, bytes: PNG_BYTES, mimeType: "image/png" }
}

/** 已登录的 codex auth 桩。 */
function codexAuthStub(overrides: Record<string, unknown> = {}): CodexAuth {
  return {
    status: async () => ({ configured: true, expired: false }),
    login: async () => {},
    logout: async () => {},
    credentials: async () => CREDENTIALS,
    ...overrides,
  } as unknown as CodexAuth
}

function codexDeps(overrides = {}) {
  return makeDeps({ codexAuth: codexAuthStub(), ...overrides })
}

describe("buildCodexBody", () => {
  test("缺省时补 auto，且不含 n 与 moderation", () => {
    const body = buildCodexBody(input())
    expect(body).toEqual({
      model: "gpt-image-2",
      prompt: "a cat",
      size: "auto",
      quality: "auto",
      background: "auto",
    })
    expect("n" in body).toBe(false)
    expect("moderation" in body).toBe(false)
  })

  test("有参考图时用 JSON images[].image_url", () => {
    const body = buildCodexBody(input({ references: [reference()] }))
    const images = body["images"] as Array<{ image_url: string }>
    expect(images).toHaveLength(1)
    expect(images[0]?.image_url.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("无参考图时不带 images 字段", () => {
    expect("images" in buildCodexBody(input())).toBe(false)
  })
})

describe("codexChannel", () => {
  test("isConfigured 看插件自己的凭据", async () => {
    expect(await codexChannel.isConfigured(codexDeps())).toBe(true)
    expect(
      await codexChannel.isConfigured(
        makeDeps({ codexAuth: codexAuthStub({ status: async () => ({ configured: false, expired: false }) }) }),
      ),
    ).toBe(false)
  })

  test("未登录时提示用 /image-gen login codex", async () => {
    const deps = makeDeps({
      codexAuth: codexAuthStub({
        credentials: async () => {
          throw new ImageGenError("Codex 尚未登录。执行 /image-gen login codex")
        },
      }),
    })
    await expect(codexChannel.generate(input(), deps)).rejects.toThrow(/login codex/)
  })

  test("无参考图走 generations，headers 带 account id 与 turn id", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBase64() }] }))
    const deps = codexDeps({ fetch })
    const result = await codexChannel.generate(input({ quality: "high" }), deps)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${CODEX_BASE_URL}/images/generations`)
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer access-token")
    expect(headers["chatgpt-account-id"]).toBe("acct-1")
    expect(headers["originator"]).toBe(CODEX_ORIGINATOR)
    expect(headers["x-codex-image-turn-id"]).toMatch(/^[0-9a-f-]{36}$/)

    const body = jsonBody(calls[0]?.init)
    expect(body).toMatchObject({ model: "gpt-image-2", prompt: "a cat", quality: "high" })
    expect("n" in body).toBe(false)
    expect(result.images).toEqual([PNG_BYTES])
  })

  test("有参考图走 edits，body 是 JSON 而不是 multipart", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBase64() }] }))
    const deps = codexDeps({ fetch })
    await codexChannel.generate(input({ references: [reference()] }), deps)

    expect(calls[0]?.url).toBe(`${CODEX_BASE_URL}/images/edits`)
    expect(typeof calls[0]?.init?.body).toBe("string")
    const body = jsonBody(calls[0]?.init)
    expect(Array.isArray(body["images"])).toBe(true)
  })

  test("记录上游 usage", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ data: [{ b64_json: pngBase64() }], usage: { input: 5, output: 7 } }),
    )
    const result = await codexChannel.generate(input(), codexDeps({ fetch }))
    expect(result.usage).toEqual({ input: 5, output: 7 })
  })

  test("401 映射成重新登录提示", async () => {
    const { fetch } = stubFetch(() => jsonResponse({ error: { message: "expired" } }, 401))
    const error = (await codexChannel
      .generate(input(), codexDeps({ fetch }))
      .catch((e: unknown) => e)) as ImageGenError
    expect(error.message).toContain("credentials")
  })

  test("只返回 url 的上游被拒绝", async () => {
    const { fetch } = stubFetch(() => jsonResponse({ data: [{ url: "https://x/y.png" }] }))
    await expect(codexChannel.generate(input(), codexDeps({ fetch }))).rejects.toThrow(
      /base64 images only/,
    )
  })

  test("能力上限：每次 1 张、参考图 5 张、quality 只到 high", () => {
    expect(codexChannel.capabilities).toMatchObject({
      maxImages: 1,
      maxReferenceImages: 5,
      qualities: ["auto", "low", "medium", "high"],
      supportsAspectRatio: false,
      supportsResolution: false,
    })
  })
})

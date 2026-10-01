import { describe, expect, test } from "bun:test"
import { buildGrokBody, grokChannel, GROK_BASE_URL } from "../src/channels/grok.ts"
import type { GenerateInput } from "../src/channels/types.ts"
import { ImageGenAuthStore } from "../src/auth/store.ts"
import type { ReferenceImage } from "../src/util/image.ts"
import { jsonBody, jsonResponse, makeDeps, PNG_BYTES, pngBase64, stubFetch, temporaryAuthPath } from "./helpers.ts"

function input(overrides: Partial<GenerateInput> = {}): GenerateInput {
  return { prompt: "a cat", model: "grok-imagine-image-2.0", n: 1, references: [], ...overrides }
}

function reference(path = "ref.png"): ReferenceImage {
  return { path, bytes: PNG_BYTES, mimeType: "image/png" }
}

/** 造一个已登录 grok 的 deps。 */
async function grokDeps(fetchImpl: typeof fetch) {
  const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
  await store.set("grok", {
    type: "oauth",
    access: "access-1",
    refresh: "refresh-1",
    expires: Date.now() + 3_600_000,
  })
  return makeDeps({ fetch: fetchImpl, store })
}

describe("buildGrokBody", () => {
  test("纯文生图补 auto 比例与默认 resolution / quality", () => {
    expect(buildGrokBody(input())).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "a cat",
      n: 1,
      response_format: "b64_json",
      quality: "auto",
      resolution: "1k",
      aspect_ratio: "auto",
    })
  })

  test("显式比例覆盖 auto", () => {
    expect(buildGrokBody(input({ aspectRatio: "16:9" }))["aspect_ratio"]).toBe("16:9")
  })

  test("有参考图且未指定比例时不发 aspect_ratio", () => {
    const body = buildGrokBody(input({ references: [reference()] }))
    expect("aspect_ratio" in body).toBe(false)
  })

  test("单张参考图用 image，多张用 images", () => {
    const one = buildGrokBody(input({ references: [reference()] }))
    expect("image" in one).toBe(true)
    expect("images" in one).toBe(false)

    const two = buildGrokBody(input({ references: [reference("a.png"), reference("b.png")] }))
    expect("image" in two).toBe(false)
    expect((two["images"] as unknown[]).length).toBe(2)
  })

  test("参考图是 data URL", () => {
    const body = buildGrokBody(input({ references: [reference()] }))
    const image = body["image"] as { type: string; url: string }
    expect(image.type).toBe("image_url")
    expect(image.url.startsWith("data:image/png;base64,")).toBe(true)
  })
})

describe("grokChannel", () => {
  test("isConfigured 看插件自己的凭据", async () => {
    const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
    expect(await grokChannel.isConfigured(makeDeps({ store }))).toBe(false)

    await store.set("grok", { type: "oauth", access: "a", refresh: "r", expires: 1 })
    expect(await grokChannel.isConfigured(makeDeps({ store }))).toBe(true)
  })

  test("未登录时报错并提示登录命令", async () => {
    const { fetch } = stubFetch(() => jsonResponse({ data: [] }))
    const deps = makeDeps({ fetch, store: new ImageGenAuthStore({ filePath: temporaryAuthPath() }) })
    await expect(grokChannel.generate(input(), deps)).rejects.toThrow(/login grok/)
  })

  test("无参考图走 generations，带 x-xai-token-auth", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBase64() }] }))
    const deps = await grokDeps(fetch)
    const result = await grokChannel.generate(input({ n: 3, resolution: "2k" }), deps)

    expect(calls[0]?.url).toBe(`${GROK_BASE_URL}/images/generations`)
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer access-1")
    expect(headers["x-xai-token-auth"]).toBe("xai-grok-cli")
    expect(jsonBody(calls[0]?.init)).toMatchObject({ n: 3, resolution: "2k" })
    expect(result.images).toEqual([PNG_BYTES])
  })

  test("有参考图走 edits", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBase64() }] }))
    const deps = await grokDeps(fetch)
    await grokChannel.generate(input({ references: [reference()] }), deps)
    expect(calls[0]?.url).toBe(`${GROK_BASE_URL}/images/edits`)
  })

  test("respect_moderation 为 false 时按审核拦截报错", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ data: [{ b64_json: pngBase64(), respect_moderation: false }] }),
    )
    const deps = await grokDeps(fetch)
    await expect(grokChannel.generate(input(), deps)).rejects.toThrow(/safety system/)
  })

  test("能力：不支持 size/background，也不接受 WebP 参考图", () => {
    expect(grokChannel.capabilities).toMatchObject({
      maxImages: 10,
      maxReferenceImages: 5,
      qualities: ["auto", "low", "medium"],
      supportsSize: false,
      supportsBackground: false,
      supportsAspectRatio: true,
      supportsResolution: true,
      supportsWebpReferences: false,
    })
  })

  test("上游 401 映射成凭据提示", async () => {
    const { fetch } = stubFetch(() => jsonResponse({ error: { message: "nope" } }, 401))
    const deps = await grokDeps(fetch)
    await expect(grokChannel.generate(input(), deps)).rejects.toThrow(/credentials are unavailable/)
  })
})

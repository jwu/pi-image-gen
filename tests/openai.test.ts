import { describe, expect, test } from "bun:test"
import { ImageGenError } from "../src/util/errors.ts"
import {
  detectOpenAiKeySource,
  openaiChannel,
  resolveOpenAiApiKey,
  resolveOpenAiBaseUrl,
  validateSize,
} from "../src/channels/openai.ts"
import type { GenerateInput } from "../src/channels/types.ts"
import type { ReferenceImage } from "../src/util/image.ts"
import {
  jsonBody,
  jsonResponse,
  jpegBase64,
  makeDeps,
  PNG_BYTES,
  pngBase64,
  stubFetch,
} from "./helpers.ts"

function input(overrides: Partial<GenerateInput> = {}): GenerateInput {
  return { prompt: "a cat", model: "gpt-image-2", n: 1, references: [], ...overrides }
}

function reference(path = "ref.png", bytes = PNG_BYTES): ReferenceImage {
  return { path, bytes, mimeType: "image/png" }
}

describe("validateSize", () => {
  test("接受 auto 与合法尺寸", () => {
    expect(validateSize("auto")).toBe("auto")
    expect(validateSize("1024x1024")).toBe("1024x1024")
    expect(validateSize("1536x1024")).toBe("1536x1024")
  })

  test("拒绝非法格式", () => {
    expect(() => validateSize("1024*1024")).toThrow(ImageGenError)
    expect(() => validateSize("big")).toThrow(ImageGenError)
  })

  test("拒绝非 16 的倍数", () => {
    expect(() => validateSize("1000x1000")).toThrow(/multiples of 16/)
  })

  test("拒绝超大边长", () => {
    expect(() => validateSize("4096x4096")).toThrow(/sides must not exceed/)
  })

  test("拒绝超出区间的宽高比", () => {
    expect(() => validateSize("2048x512")).toThrow(/aspect ratio/)
  })
})

describe("resolveOpenAiApiKey", () => {
  test("环境变量优先于凭据文件", async () => {
    const deps = makeDeps({ env: { OPENAI_API_KEY: "env-key" } })
    await deps.store.set("openai", { type: "api_key", key: "file-key" })
    expect(await resolveOpenAiApiKey(deps)).toEqual({ key: "env-key", source: "env" })
  })

  test("没有环境变量时回退到凭据文件", async () => {
    const deps = makeDeps()
    await deps.store.set("openai", { type: "api_key", key: "file-key" })
    expect(await resolveOpenAiApiKey(deps)).toEqual({ key: "file-key", source: "file" })
  })

  test("都没有时返回 undefined", async () => {
    expect(await resolveOpenAiApiKey(makeDeps())).toBeUndefined()
  })
})

describe("detectOpenAiKeySource", () => {
  test("没有任何来源时返回 none", async () => {
    expect(await detectOpenAiKeySource(makeDeps())).toBe("none")
  })

  test("识别环境变量与凭据文件", async () => {
    expect(await detectOpenAiKeySource(makeDeps({ env: { OPENAI_API_KEY: "k" } }))).toBe("env")
    const deps = makeDeps()
    await deps.store.set("openai", { type: "api_key", key: "k" })
    expect(await detectOpenAiKeySource(deps)).toBe("file")
  })
})

describe("resolveOpenAiBaseUrl", () => {
  test("默认官方地址", () => {
    expect(resolveOpenAiBaseUrl(makeDeps())).toBe("https://api.openai.com/v1")
  })

  test("去掉结尾斜杠并可覆盖", () => {
    expect(resolveOpenAiBaseUrl(makeDeps({ env: { OPENAI_BASE_URL: "https://x.dev/v1/" } }))).toBe(
      "https://x.dev/v1",
    )
  })

  test("拒绝非 http(s)", () => {
    expect(() => resolveOpenAiBaseUrl(makeDeps({ env: { OPENAI_BASE_URL: "ftp://x" } }))).toThrow(
      ImageGenError,
    )
  })
})

describe("openaiChannel.generate", () => {
  test("未配置时给出配置提示", async () => {
    const deps = makeDeps()
    await expect(openaiChannel.generate(input(), deps)).rejects.toThrow(/OPENAI_API_KEY/)
  })

  test("无参考图走 generations，body 是 JSON", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse({ data: [{ b64_json: pngBase64() }] }),
    )
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    const result = await openaiChannel.generate(
      input({ size: "1024x1024", quality: "high", background: "transparent" }),
      deps,
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/images/generations")
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer k" })
    const body = jsonBody(calls[0]?.init)
    expect(body).toMatchObject({
      model: "gpt-image-2",
      prompt: "a cat",
      n: 1,
      size: "1024x1024",
      quality: "high",
      background: "transparent",
    })
    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toEqual(PNG_BYTES)
  })

  test("默认发送 moderation=low（与 ai-canvas 一致）", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBase64() }] }))
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    await openaiChannel.generate(input(), deps)
    expect(jsonBody(calls[0]?.init)["moderation"]).toBe("low")
  })

  test("moderation 可显式覆盖为 auto", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBase64() }] }))
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    await openaiChannel.generate(input({ moderation: "auto" }), deps)
    expect(jsonBody(calls[0]?.init)["moderation"]).toBe("auto")
  })

  test("multipart 路径也带 moderation", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBase64() }] }))
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    await openaiChannel.generate(input({ references: [reference()] }), deps)
    expect((calls[0]?.init?.body as FormData).get("moderation")).toBe("low")
  })

  test("有参考图走 edits，body 是 multipart", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse({ data: [{ b64_json: pngBase64() }] }),
    )
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    await openaiChannel.generate(
      input({ references: [reference("a.png"), reference("b.png")] }),
      deps,
    )

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/images/edits")
    const body = calls[0]?.init?.body
    expect(body).toBeInstanceOf(FormData)
    const form = body as FormData
    expect(form.get("model")).toBe("gpt-image-2")
    expect(form.getAll("image[]")).toHaveLength(2)
  })

  test("少给图片按实际张数返回，不报错", async () => {
    const { fetch } = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBase64() }] }))
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    const result = await openaiChannel.generate(input({ n: 3 }), deps)
    expect(result.images).toHaveLength(1)
  })

  test("空 data 报错", async () => {
    const { fetch } = stubFetch(() => jsonResponse({ data: [] }))
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    await expect(openaiChannel.generate(input(), deps)).rejects.toThrow(/returned no images/)
  })

  test("只返回 url 的上游被拒绝（不做 SSRF 下载）", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ data: [{ url: "https://evil.example/x.png" }] }),
    )
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    await expect(openaiChannel.generate(input(), deps)).rejects.toThrow(/base64 images only/)
  })

  test("识别不了格式的字节被拒绝", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }),
    )
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    await expect(openaiChannel.generate(input(), deps)).rejects.toThrow(/unrecognized format/)
  })

  test("接受 JPEG 输出", async () => {
    const { fetch } = stubFetch(() => jsonResponse({ data: [{ b64_json: jpegBase64() }] }))
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    const result = await openaiChannel.generate(input(), deps)
    expect(result.images).toHaveLength(1)
  })

  test("上游 401 映射成凭据提示并带上耗时", async () => {
    const { fetch } = stubFetch(() => jsonResponse({ error: { message: "bad key" } }, 401))
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" }, now: () => 1_000 })
    const error = (await openaiChannel.generate(input(), deps).catch((e: unknown) => e)) as ImageGenError
    expect(error).toBeInstanceOf(ImageGenError)
    expect(error.message).toContain("credentials are unavailable")
    expect(error.upstreamMs).toBe(0)
  })

  test("记录上游 usage", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({
        data: [{ b64_json: pngBase64() }],
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      }),
    )
    const deps = makeDeps({ fetch, env: { OPENAI_API_KEY: "k" } })
    const result = await openaiChannel.generate(input(), deps)
    expect(result.usage).toEqual({ input: 10, output: 20, total: 30 })
  })
})

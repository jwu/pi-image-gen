import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Value } from "typebox/value"
import type { Channel } from "../src/channels/types.ts"
import { ImageGenAuthStore } from "../src/auth/store.ts"
import { ImageGenParameters, registerImageGenTool } from "../src/tool.ts"
import { makeDeps, PNG_BYTES, temporaryAuthPath } from "./helpers.ts"

function workingChannel(delayMs = 0): Channel {
  return {
    id: "openai",
    displayName: "OpenAI",
    defaultModel: "gpt-image-2",
    loginHint: "set OPENAI_API_KEY",
    capabilities: {
      maxImages: 10,
      maxReferenceImages: 16,
      maxReferenceBytes: 40 * 1024 * 1024,
      qualities: ["auto", "low", "medium", "high", "xhigh", "max"],
      supportsModeration: true,
      supportsSize: true,
      supportsBackground: true,
      supportsAspectRatio: false,
      supportsResolution: false,
      supportsWebpReferences: true,
    },
    async isConfigured() {
      return true
    },
    async generate() {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return { images: [PNG_BYTES], model: "gpt-image-2", upstreamMs: 1234 }
    },
  }
}

function setup(channels: Channel[] = [workingChannel()]) {
  let registered: ToolDefinition | undefined
  const pi = {
    registerTool(tool: ToolDefinition) {
      registered = tool
    },
  } as unknown as ExtensionAPI
  const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
  registerImageGenTool(pi, {
    channels,
    store,
    createDeps: () =>
      makeDeps({
        store,
        env: { PI_IMAGE_GEN_CONFIG_FILE: "/nonexistent/config.json" },
        now: () => Date.UTC(2025, 0, 1),
      }),
  })
  if (registered === undefined) throw new Error("tool was not registered")
  return { tool: registered }
}

async function context(): Promise<ExtensionContext> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-image-gen-tool-"))
  return {
    cwd,
    mode: "tui",
    hasUI: false,
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: false }),
      getProviderAuth: async () => undefined,
    },
  } as unknown as ExtensionContext
}

async function run(
  tool: ToolDefinition,
  params: unknown,
  ctx: ExtensionContext,
): Promise<{ content: unknown[]; details: Record<string, unknown>; isError?: boolean }> {
  const result = await tool.execute(
    "call-1",
    params as never,
    undefined,
    undefined,
    ctx as ExtensionToolContext,
  )
  return result as { content: unknown[]; details: Record<string, unknown>; isError?: boolean }
}

describe("image_gen schema", () => {
  test("prompt 必填且非空", () => {
    expect(Value.Check(ImageGenParameters, { prompt: "hi" })).toBe(true)
    expect(Value.Check(ImageGenParameters, {})).toBe(false)
    expect(Value.Check(ImageGenParameters, { prompt: "" })).toBe(false)
  })

  test("provider 只接受三个通道", () => {
    for (const provider of ["codex", "grok", "openai"]) {
      expect(Value.Check(ImageGenParameters, { prompt: "hi", provider })).toBe(true)
    }
    expect(Value.Check(ImageGenParameters, { prompt: "hi", provider: "midjourney" })).toBe(false)
  })

  test("moderation 只接受 auto / low", () => {
    expect(Value.Check(ImageGenParameters, { prompt: "hi", moderation: "low" })).toBe(true)
    expect(Value.Check(ImageGenParameters, { prompt: "hi", moderation: "auto" })).toBe(true)
    expect(Value.Check(ImageGenParameters, { prompt: "hi", moderation: "high" })).toBe(false)
  })

  test("n 必须落在 1..10", () => {
    expect(Value.Check(ImageGenParameters, { prompt: "hi", n: 1 })).toBe(true)
    expect(Value.Check(ImageGenParameters, { prompt: "hi", n: 10 })).toBe(true)
    expect(Value.Check(ImageGenParameters, { prompt: "hi", n: 0 })).toBe(false)
    expect(Value.Check(ImageGenParameters, { prompt: "hi", n: 11 })).toBe(false)
  })

  test("拒绝未声明的参数", () => {
    expect(Value.Check(ImageGenParameters, { prompt: "hi", mask: true })).toBe(false)
  })
})

describe("image_gen execute", () => {
  test("成功时返回文本、路径和内联图片", async () => {
    const { tool } = setup()
    const ctx = await context()
    const result = await run(tool, { prompt: "a cat" }, ctx)

    expect(result.isError).toBeUndefined()
    const text = result.content[0] as { type: string; text: string }
    expect(text.type).toBe("text")
    expect(text.text).toContain("Generated 1 image(s)")
    expect(text.text).toContain("openai / gpt-image-2")

    const image = result.content[1] as { type: string; mimeType: string; data: string }
    expect(image.type).toBe("image")
    expect(image.mimeType).toBe("image/png")

    expect(result.details["provider"]).toBe("openai")
    expect(result.details["imageCount"]).toBe(1)
    expect((result.details["paths"] as string[])[0]).toContain("generated")
  })

  test("returnImage 为 false 时不内联图片", async () => {
    const { tool } = setup()
    const ctx = await context()
    const result = await run(tool, { prompt: "a cat", returnImage: false }, ctx)
    expect(result.content).toHaveLength(1)
  })

  test("只有空白的 prompt 被拒绝", async () => {
    const { tool } = setup()
    const ctx = await context()
    const result = await run(tool, { prompt: "   " }, ctx)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("prompt must not be empty")
  })

  test("通道失败时返回 isError 而不是抛出", async () => {
    const failing: Channel = {
      ...workingChannel(),
      async generate() {
        throw new Error("boom")
      },
    }
    const { tool } = setup([failing])
    const ctx = await context()
    const result = await run(tool, { prompt: "a cat" }, ctx)

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toBe("Image generation failed. Try again shortly.")
    expect(result.details["error"]).toBe("Image generation failed. Try again shortly.")
  })

  test("能力冲突的失败信息会指出哪个通道支持", async () => {
    const codexLike: Channel = {
      ...workingChannel(),
      id: "codex",
      capabilities: { ...workingChannel().capabilities, maxImages: 1, supportsSize: false },
    }
    const { tool } = setup([codexLike])
    const ctx = await context()
    const result = await run(tool, { prompt: "a cat", n: 4 }, ctx)

    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain("codex generates at most 1 image(s)")
    expect(text).toContain("No channel supports this request")
  })
})

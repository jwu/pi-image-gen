import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  Theme,
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

const renderTheme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme

function renderToolCall(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  expanded: boolean,
): string {
  const context = { expanded, isError: false }
  const component = tool.renderCall?.(args as never, renderTheme, context as never)
  return component?.render(200).join("\n") ?? ""
}

function renderToolResult(
  tool: ToolDefinition,
  result: unknown,
  expanded: boolean,
  isError = false,
): string {
  const options = { expanded, isPartial: false }
  const context = { isError }
  const component = tool.renderResult?.(
    result as never,
    options as never,
    renderTheme,
    context as never,
  )
  return component?.render(200).join("\n") ?? ""
}

function successResult(paths: string[], warnings: string[] = ["slow"]): unknown {
  return {
    content: [{ type: "text", text: "Generated image(s)" }],
    details: {
      paths,
      provider: "openai",
      model: "gpt-image-2",
      imageCount: paths.length,
      upstreamMs: 1234,
      warnings,
      usage: { total: 42 },
    },
    isError: false,
  }
}

describe("image_gen render", () => {
  const longPrompt =
    "A cinematic photo of a cat sitting on a windowsill at golden hour, shallow depth of field, 35mm film grain and warm backlight"

  test("折叠态显示截断后的提示词首行与展开提示", () => {
    const { tool } = setup()
    const text = renderToolCall(tool, { prompt: longPrompt, provider: "codex" }, false)

    expect(text).toContain("image_gen")
    expect(text).toContain("...")
    expect(text).toContain("to expand")
    expect(text).not.toContain("warm backlight")
    expect(text).not.toContain("\n")
  })

  test("展开态显示完整提示词与非默认参数，且保留换行", () => {
    const { tool } = setup()
    const text = renderToolCall(
      tool,
      {
        prompt: "first line\nsecond line",
        provider: "grok",
        model: "grok-2-image",
        n: 2,
        aspectRatio: "16:9",
        references: ["a.png", "b.png"],
        outputPath: "out/",
      },
      true,
    )

    expect(text).toContain("first line")
    expect(text).toContain("second line")
    expect(text).toContain("provider: grok")
    expect(text).toContain("model: grok-2-image")
    expect(text).toContain("n: 2")
    expect(text).toContain("aspectRatio: 16:9")
    expect(text).toContain("references: a.png, b.png")
    expect(text).toContain("outputPath: out/")
  })

  test("展开态不打印未提供的参数", () => {
    const { tool } = setup()
    const text = renderToolCall(tool, { prompt: "hi" }, true)
    expect(text).not.toContain("provider:")
    expect(text).not.toContain("size:")
  })

  test("折叠结果展示摘要与前三条路径", () => {
    const { tool } = setup()
    const text = renderToolResult(tool, successResult(["a.png", "b.png", "c.png", "d.png"]), false)

    expect(text).toContain("4 images with openai / gpt-image-2 in 1.2s")
    expect(text).toContain("a.png")
    expect(text).toContain("c.png")
    expect(text).not.toContain("d.png")
    expect(text).toContain("1 more path")
    expect(text).not.toContain("Warning: slow")
  })

  test("展开结果列出全部路径、warning 与 usage", () => {
    const { tool } = setup()
    const text = renderToolResult(tool, successResult(["a.png", "b.png", "c.png", "d.png"]), true)

    expect(text).toContain("d.png")
    expect(text).toContain("Warning: slow")
    expect(text).toContain("Upstream usage: 42 tokens")
  })

  test("错误结果展示错误信息与诊断字段", () => {
    const { tool } = setup()
    const result = {
      content: [{ type: "text", text: "boom" }],
      details: {
        paths: [],
        imageCount: 0,
        warnings: [],
        error: "upstream rejected",
        code: "E42",
        requestId: "req-1",
      },
      isError: true,
    }
    const text = renderToolResult(tool, result, false, true)

    expect(text).toContain("upstream rejected")
    expect(text).toContain("code=E42")
    expect(text).toContain("requestId=req-1")
  })
})

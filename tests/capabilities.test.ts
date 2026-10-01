import { describe, expect, test } from "bun:test"
import { assertCapabilities, resolveChannel } from "../src/channels/capabilities.ts"
import type {
  Channel,
  ChannelCapabilities,
  ChannelDeps,
  GenerateInput,
  ProviderId,
} from "../src/channels/types.ts"
import { makeDeps } from "./helpers.ts"

function caps(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    maxImages: 1,
    maxReferenceImages: 5,
    maxReferenceBytes: 40 * 1024 * 1024,
    qualities: ["auto", "low", "medium", "high"],
    supportsModeration: true,
    supportsSize: false,
    supportsBackground: false,
    supportsAspectRatio: false,
    supportsResolution: false,
    supportsWebpReferences: true,
    ...overrides,
  }
}

function fakeChannel(
  id: ProviderId,
  options: { configured: boolean; capabilities?: Partial<ChannelCapabilities> },
): Channel {
  return {
    id,
    displayName: id,
    defaultModel: `${id}-model`,
    loginHint: `login ${id}`,
    capabilities: caps(options.capabilities),
    async isConfigured() {
      return options.configured
    },
    async generate() {
      return { images: [], model: `${id}-model`, upstreamMs: 0 }
    },
  }
}

function input(overrides: Partial<GenerateInput> = {}): GenerateInput {
  return { prompt: "p", model: "m", n: 1, references: [], ...overrides }
}

/** 取 promise 的拒绝原因；没拒绝就报错，避免把成功结果当成 Error 用。 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the promise to reject")
}

describe("resolveChannel", () => {
  const deps: ChannelDeps = makeDeps()

  test("省略 provider 时按 codex → grok → openai 取第一个已配置的", async () => {
    const channels = [
      fakeChannel("codex", { configured: false }),
      fakeChannel("grok", { configured: true }),
      fakeChannel("openai", { configured: true }),
    ]
    const channel = await resolveChannel({ channels, deps })
    expect(channel.id).toBe("grok")
  })

  test("defaultProvider 优先于内置顺序", async () => {
    const channels = [
      fakeChannel("codex", { configured: true }),
      fakeChannel("grok", { configured: true }),
      fakeChannel("openai", { configured: true }),
    ]
    const channel = await resolveChannel({ channels, deps, preferred: "openai" })
    expect(channel.id).toBe("openai")
  })

  test("providerOrder 排在 defaultProvider 之后", async () => {
    const channels = [
      fakeChannel("codex", { configured: true }),
      fakeChannel("grok", { configured: false }),
      fakeChannel("openai", { configured: true }),
    ]
    const channel = await resolveChannel({ channels, deps, order: ["grok", "openai"] })
    expect(channel.id).toBe("openai")
  })

  test("显式指定未配置的通道时报错并列出可用通道", async () => {
    const channels = [
      fakeChannel("codex", { configured: false }),
      fakeChannel("grok", { configured: true }),
      fakeChannel("openai", { configured: false }),
    ]
    const error = await rejection(resolveChannel({ channels, deps, requested: "codex" }))
    expect(error.message).toContain("codex")
    expect(error.message).toContain("Available channels: grok")
  })

  test("一个通道都没配置时给出各自的配置方式", async () => {
    const channels = [
      fakeChannel("codex", { configured: false }),
      fakeChannel("grok", { configured: false }),
      fakeChannel("openai", { configured: false }),
    ]
    const error = await rejection(resolveChannel({ channels, deps }))
    expect(error.message).toContain("No image channel is configured")
    expect(error.message).toContain("login codex")
    expect(error.message).toContain("login grok")
  })

  test("isConfigured 抛错时按未配置处理，不阻断选择", async () => {
    const broken: Channel = {
      ...fakeChannel("codex", { configured: false }),
      async isConfigured() {
        throw new Error("store is corrupt")
      },
    }
    const channels = [broken, fakeChannel("grok", { configured: true })]
    const channel = await resolveChannel({ channels, deps })
    expect(channel.id).toBe("grok")
  })
})

describe("assertCapabilities", () => {
  const codex = fakeChannel("codex", { configured: true })
  const grok = fakeChannel("grok", {
    configured: true,
    capabilities: { maxImages: 10, qualities: ["auto", "low", "medium"], supportsAspectRatio: true },
  })
  const openai = fakeChannel("openai", {
    configured: true,
    capabilities: {
      maxImages: 10,
      maxReferenceImages: 16,
      supportsSize: true,
      supportsBackground: true,
    },
  })
  const all = [codex, grok, openai]

  test("n 超限时报错并指出谁支持", () => {
    const error = (() => {
      try {
        assertCapabilities(codex, input({ n: 4 }), all)
        throw new Error("should have thrown")
      } catch (e) {
        return e as Error
      }
    })()
    expect(error.message).toContain("codex generates at most 1 image(s)")
    expect(error.message).toContain("Supported by: grok, openai")
  })

  test("没有任何通道支持时明确说明", () => {
    const only = fakeChannel("codex", { configured: true })
    expect(() => assertCapabilities(only, input({ n: 4 }), [only])).toThrow(/No channel supports this request/)
  })

  test("quality 不在通道支持范围时报错", () => {
    expect(() => assertCapabilities(codex, input({ quality: "max" }), all)).toThrow(/quality=max/)
  })

  test("size 给不支持的通道时报错", () => {
    expect(() => assertCapabilities(codex, input({ size: "1024x1024" }), all)).toThrow(/size/)
  })

  test("moderation 只被支持它的通道接受", () => {
    const withMod = fakeChannel("openai", {
      configured: true,
      capabilities: { supportsModeration: true },
    })
    const withoutMod = fakeChannel("codex", {
      configured: true,
      capabilities: { supportsModeration: false },
    })
    const both = [withMod, withoutMod]
    expect(() => assertCapabilities(withMod, input({ moderation: "low" }), both)).not.toThrow()
    expect(() => assertCapabilities(withoutMod, input({ moderation: "low" }), both)).toThrow(
      /moderation/,
    )
  })

  test("aspectRatio 只有 grok 支持", () => {
    expect(() => assertCapabilities(openai, input({ aspectRatio: "16:9" }), all)).toThrow(
      /aspectRatio/,
    )
    expect(() => assertCapabilities(grok, input({ aspectRatio: "16:9" }), all)).not.toThrow()
  })

  test("参考图超过上限时报错", () => {
    const references = Array.from({ length: 6 }, (_, index) => ({
      path: `r${index}.png`,
      bytes: new Uint8Array([1]),
      mimeType: "image/png" as const,
    }))
    expect(() => assertCapabilities(codex, input({ references }), all)).toThrow(/reference image/)
  })

  test("参考图合计字节超过通道上限时报错", () => {
    const tiny: Channel = fakeChannel("codex", {
      configured: true,
      capabilities: { maxReferenceBytes: 10 },
    })
    const references = [
      { path: "a.png", bytes: new Uint8Array(8), mimeType: "image/png" as const },
      { path: "b.png", bytes: new Uint8Array(8), mimeType: "image/png" as const },
    ]
    expect(() => assertCapabilities(tiny, input({ references }), [tiny, openai])).toThrow(
      /reference images must total at most/,
    )
  })

  test("不接受 WebP 参考图的通道直接拒绝", () => {
    const webp = fakeChannel("openai", {
      configured: true,
      capabilities: { supportsWebpReferences: false },
    })
    const references = [{ path: "a.webp", bytes: new Uint8Array([1]), mimeType: "image/webp" as const }]
    expect(() => assertCapabilities(webp, input({ references }), [webp])).toThrow(/WebP/)
  })

  test("合法输入不报错", () => {
    expect(() =>
      assertCapabilities(openai, input({ n: 4, size: "1024x1024", quality: "high" }), all),
    ).not.toThrow()
  })
})

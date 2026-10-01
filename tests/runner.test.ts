import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Channel, ProviderId } from "../src/channels/types.ts"
import { defaultConfig } from "../src/config.ts"
import { resetConcurrencyForTests, resolveOutputPaths, runGeneration } from "../src/runner.ts"
import { ImageGenError } from "../src/util/errors.ts"
import { JPEG_BYTES, makeDeps, PNG_BYTES } from "./helpers.ts"

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-image-gen-run-"))
}

function outputChannel(
  id: ProviderId,
  images: Uint8Array[] = [PNG_BYTES],
  delayMs = 0,
): Channel {
  return {
    id,
    displayName: id,
    defaultModel: `${id}-model`,
    loginHint: `login ${id}`,
    capabilities: {
      maxImages: 10,
      maxReferenceImages: 16,
      maxReferenceBytes: 40 * 1024 * 1024,
      qualities: ["auto", "low", "medium", "high", "xhigh", "max"],
      supportsModeration: true,
      supportsSize: true,
      supportsBackground: true,
      supportsAspectRatio: true,
      supportsResolution: true,
      supportsWebpReferences: true,
    },
    async isConfigured() {
      return true
    },
    async generate() {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return { images, model: `${id}-model`, upstreamMs: 42 }
    },
  }
}

beforeEach(() => {
  resetConcurrencyForTests()
})

describe("resolveOutputPaths", () => {
  test("省略 outputPath 时落在 cwd/outputDir 下", () => {
    const [path] = resolveOutputPaths({ cwd: "/w", outputDir: "generated", count: 1, now: 0 })
    expect(path?.startsWith("/w/generated/")).toBe(true)
  })

  test("带图片扩展名时当作文件路径，多张追加序号", () => {
    const paths = resolveOutputPaths({
      cwd: "/w",
      outputDir: "generated",
      outputPath: "out/pic.png",
      count: 3,
      now: 0,
    })
    expect(paths).toEqual(["/w/out/pic", "/w/out/pic-2", "/w/out/pic-3"])
  })

  test("不带扩展名时当作目录", () => {
    const [path] = resolveOutputPaths({
      cwd: "/w",
      outputDir: "generated",
      outputPath: "shots",
      count: 1,
      now: 0,
    })
    expect(path?.startsWith("/w/shots/")).toBe(true)
  })
})

describe("runGeneration", () => {
  test("默认落盘到 <cwd>/generated，权限 0600", async () => {
    const cwd = await workspace()
    const result = await runGeneration({
      request: { prompt: "a cat" },
      cwd,
      config: defaultConfig(),
      channels: [outputChannel("openai")],
      deps: makeDeps(),
    })

    expect(result.images).toHaveLength(1)
    const path = result.images[0]!.path
    expect(path.startsWith(join(cwd, "generated"))).toBe(true)
    expect(path.endsWith(".png")).toBe(true)
    expect(path).not.toContain(":") // 时间戳里的冒号必须被替换掉
    expect(new Uint8Array(await readFile(path))).toEqual(PNG_BYTES)
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  test("按实际图片格式选扩展名", async () => {
    const cwd = await workspace()
    const result = await runGeneration({
      request: { prompt: "a cat" },
      cwd,
      config: defaultConfig(),
      channels: [outputChannel("openai", [JPEG_BYTES])],
      deps: makeDeps(),
    })
    expect(result.images[0]!.path.endsWith(".jpg")).toBe(true)
    expect(result.images[0]!.mimeType).toBe("image/jpeg")
  })

  test("outputPath 指定文件时写到指定位置", async () => {
    const cwd = await workspace()
    const result = await runGeneration({
      request: { prompt: "a cat", outputPath: "art/hero.png" },
      cwd,
      config: defaultConfig(),
      channels: [outputChannel("openai")],
      deps: makeDeps(),
    })
    expect(result.images[0]!.path).toBe(join(cwd, "art", "hero.png"))
    expect(new Uint8Array(await readFile(result.images[0]!.path))).toEqual(PNG_BYTES)
  })

  test("相对路径的参考图按 cwd 解析", async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, "ref.png"), PNG_BYTES)
    const result = await runGeneration({
      request: { prompt: "a cat", references: ["ref.png"] },
      cwd,
      config: defaultConfig(),
      channels: [outputChannel("openai")],
      deps: makeDeps(),
    })
    expect(result.provider).toBe("openai")
  })

  test("读不到的参考图给出可读错误", async () => {
    const cwd = await workspace()
    await expect(
      runGeneration({
        request: { prompt: "a cat", references: ["missing.png"] },
        cwd,
        config: defaultConfig(),
        channels: [outputChannel("openai")],
        deps: makeDeps(),
      }),
    ).rejects.toThrow(/Could not read the reference image/)
  })

  test("上游少给图片时记 warning，不是失败", async () => {
    const cwd = await workspace()
    const result = await runGeneration({
      request: { prompt: "a cat", n: 3 },
      cwd,
      config: defaultConfig(),
      channels: [outputChannel("openai")],
      deps: makeDeps(),
    })
    expect(result.images).toHaveLength(1)
    expect(result.warnings[0]).toContain("Requested 3 image(s)")
  })

  test("超出并发闸门时直接报错，不排队", async () => {
    const cwd = await workspace()
    const config = { ...defaultConfig(), maxConcurrent: 1 }
    const channels = [outputChannel("openai", [PNG_BYTES], 50)]
    const first = runGeneration({
      request: { prompt: "a cat" },
      cwd,
      config,
      channels,
      deps: makeDeps(),
    })
    const second = runGeneration({
      request: { prompt: "a dog" },
      cwd,
      config,
      channels,
      deps: makeDeps(),
    })
    const error = (await second.catch((e: unknown) => e)) as ImageGenError
    expect(error).toBeInstanceOf(ImageGenError)
    expect(error.message).toContain("generation task(s) in flight")
    await first
  })

  test("未配置任何通道时报错", async () => {
    const cwd = await workspace()
    const offline: Channel = { ...outputChannel("openai"), isConfigured: async () => false }
    await expect(
      runGeneration({
        request: { prompt: "a cat" },
        cwd,
        config: defaultConfig(),
        channels: [offline],
        deps: makeDeps(),
      }),
    ).rejects.toThrow(/No image channel is configured/)
  })
})

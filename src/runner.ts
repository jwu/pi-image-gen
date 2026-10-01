/**
 * 一次生图请求的编排：读参考图 → 选通道 → 校验能力 → 调用通道 → 落盘。
 *
 * 与 pi 的耦合只在 `tool.ts`，这里只依赖 `ChannelDeps`，因此可以整段用假依赖测试。
 */
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { assertCapabilities, resolveChannel } from "./channels/capabilities.ts"
import type {
  Background,
  Channel,
  ChannelDeps,
  GenerateInput,
  GenerateUsage,
  Moderation,
  ProviderId,
  Quality,
  Resolution,
} from "./channels/types.ts"
import type { ImageGenConfig } from "./config.ts"
import { ImageGenError } from "./util/errors.ts"
import { detectImageMime, type ImageMimeType, readReferenceImage } from "./util/image.ts"

/** 单张参考图的字节上限；通道级的合计上限由 `capabilities.maxReferenceBytes` 判定。 */
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024

const EXTENSIONS: Record<ImageMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
}

export interface GenerationRequest {
  prompt: string
  provider?: ProviderId
  model?: string
  n?: number
  size?: string
  quality?: Quality
  background?: Background
  moderation?: Moderation
  aspectRatio?: string
  resolution?: Resolution
  /** 参考图路径，相对路径按 `cwd` 解析。 */
  references?: string[]
  /** 覆盖输出文件或目录；默认写到 `<cwd>/<config.outputDir>/`。 */
  outputPath?: string
}

export interface GeneratedImage {
  path: string
  bytes: Uint8Array
  mimeType: ImageMimeType
}

export interface GenerationResult {
  images: GeneratedImage[]
  provider: ProviderId
  model: string
  upstreamMs: number
  warnings: string[]
  usage?: GenerateUsage
}

// ---------------------------------------------------------------------------
// 并发闸门
// ---------------------------------------------------------------------------

let activeGenerations = 0

/**
 * 同时最多 `limit` 个生成任务，超出**直接报错不排队**。
 * pi 侧已用 `executionMode: "sequential"` 保证同批工具调用串行，这里防的是 codemode 之类的并行入口。
 */
async function withSlot<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  if (activeGenerations >= limit) {
    throw new ImageGenError(`Already ${limit} generation task(s) in flight. Try again shortly.`)
  }
  activeGenerations += 1
  try {
    return await fn()
  } finally {
    activeGenerations -= 1
  }
}

/** 仅供测试：重置闸门计数。 */
export function resetConcurrencyForTests(): void {
  activeGenerations = 0
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

function timestampSlug(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-")
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 8).padEnd(6, "0")
}

function hasImageExtension(path: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(path)
}

/**
 * 解析输出路径（不含扩展名，扩展名由实际图片格式决定）：
 * - 省略 `outputPath` → `<cwd>/<outputDir>/<时间戳>-<随机>`
 * - `outputPath` 带图片扩展名 → 当作文件路径，多张图时追加 `-2`、`-3`
 * - 其它 → 当作目录
 */
export function resolveOutputPaths(options: {
  cwd: string
  outputDir: string
  outputPath?: string
  count: number
  now: number
}): string[] {
  const { cwd, outputDir, outputPath, count, now } = options
  const stamp = `${timestampSlug(now)}-${randomSuffix()}`

  let base: string
  if (outputPath === undefined || outputPath.trim().length === 0) {
    base = join(cwd, outputDir, stamp)
  } else {
    const raw = outputPath.trim()
    const resolved = isAbsolute(raw) ? raw : resolve(cwd, raw)
    base = hasImageExtension(resolved)
      ? resolved.replace(/\.(png|jpe?g|webp)$/i, "")
      : join(resolved, stamp)
  }

  const paths: string[] = []
  for (let index = 0; index < count; index += 1) {
    paths.push(index === 0 ? base : `${base}-${index + 1}`)
  }
  return paths
}

async function persist(
  images: Array<{ bytes: Uint8Array; mimeType: ImageMimeType }>,
  options: { cwd: string; outputDir: string; outputPath?: string; now: number },
): Promise<GeneratedImage[]> {
  const bases = resolveOutputPaths({ ...options, count: images.length })
  const result: GeneratedImage[] = []
  for (const [index, image] of images.entries()) {
    const path = `${bases[index] ?? bases[0]}${EXTENSIONS[image.mimeType]}`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, image.bytes, { mode: 0o600 })
      await chmod(path, 0o600).catch(() => {})
    } catch {
      throw new ImageGenError(`Could not write the image file: ${path}`)
    }
    result.push({ path, bytes: image.bytes, mimeType: image.mimeType })
  }
  return result
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

export interface RunGenerationOptions {
  request: GenerationRequest
  cwd: string
  config: ImageGenConfig
  channels: readonly Channel[]
  deps: ChannelDeps
  signal?: AbortSignal
}

export async function runGeneration(options: RunGenerationOptions): Promise<GenerationResult> {
  const { request, cwd, config, channels, deps, signal } = options

  return withSlot(config.maxConcurrent, async () => {
    const references = []
    for (const path of request.references ?? []) {
      const resolved = isAbsolute(path) ? path : resolve(cwd, path)
      references.push(await readReferenceImage(resolved, MAX_REFERENCE_IMAGE_BYTES))
    }

    const channel = await resolveChannel({
      requested: request.provider,
      channels,
      deps,
      ...(config.defaultProvider !== undefined ? { preferred: config.defaultProvider } : {}),
      ...(config.providerOrder !== undefined ? { order: config.providerOrder } : {}),
    })

    const model = request.model ?? config.models[channel.id] ?? channel.defaultModel
    const input: GenerateInput = {
      prompt: request.prompt,
      model,
      n: request.n ?? 1,
      references,
      ...(request.size !== undefined ? { size: request.size } : {}),
      ...(request.quality !== undefined ? { quality: request.quality } : {}),
      ...(request.background !== undefined ? { background: request.background } : {}),
      ...(request.moderation !== undefined ? { moderation: request.moderation } : {}),
      ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.resolution !== undefined ? { resolution: request.resolution } : {}),
    }

    assertCapabilities(channel, input, channels)

    const output = await channel.generate(input, deps, signal)
    const warnings: string[] = []
    if (output.images.length < input.n) {
      warnings.push(`Requested ${input.n} image(s), but the upstream returned only ${output.images.length}.`)
    }

    const persisted = await persist(
      output.images.map((bytes) => ({ bytes, mimeType: detectImageMime(bytes) ?? "image/png" })),
      {
        cwd,
        outputDir: config.outputDir,
        ...(request.outputPath !== undefined ? { outputPath: request.outputPath } : {}),
        now: deps.now(),
      },
    )

    return {
      images: persisted,
      provider: channel.id,
      model: output.model,
      upstreamMs: output.upstreamMs,
      warnings,
      ...(output.usage !== undefined ? { usage: output.usage } : {}),
    }
  })
}

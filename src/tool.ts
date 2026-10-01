/**
 * `image_gen` 工具：schema、执行与结果组装。
 *
 * 工具**静态注册一次**：description 写清三条通道、默认优先级与各自的能力差异，`provider` 的
 * enum 固定列出三个可选值。凭据状态变了也不重注册，改为在出错文案里列出当前可用通道。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { StringEnum } from "@earendil-works/pi-ai"
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import type { Channel, ChannelDeps, ProviderId } from "./channels/types.ts"
import { runGeneration, type GenerationResult } from "./runner.ts"
import { loadConfig, type ImageGenConfig } from "./config.ts"
import { ImageGenError } from "./util/errors.ts"
import type { ImageGenAuthStore } from "./auth/store.ts"

const QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max"] as const
const BACKGROUNDS = ["auto", "transparent", "opaque"] as const
const RESOLUTIONS = ["1k", "1.5k", "2k"] as const
const MODERATIONS = ["auto", "low"] as const

const DESCRIPTION = `Generate an image from a text prompt, optionally guided by reference images (image-to-image).

Channels — choose with \`provider\`; when omitted the first configured channel wins in this order: codex, grok, openai.
- codex: ChatGPT subscription through pi's existing OpenAI login. Exactly 1 image per call, up to 5 reference images, supports size/quality (up to high)/background. No aspectRatio/resolution.
- grok: x.ai subscription. 1-10 images, up to 5 reference images, supports aspectRatio and resolution. No size/background.
- openai: OpenAI Images API key. 1-10 images, up to 16 reference images, supports size/quality/background/moderation.

Generated images are saved to ./generated/ (configurable) and may be returned inline so you can look at them.

This tool never switches channels silently. If the selected channel cannot honor a parameter, the call fails and names the channels that can, so you can retry deliberately.`

const Parameters = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      maxLength: 12_000,
      description: "What to draw. Be specific about subject, style, composition, and lighting.",
    }),
    provider: Type.Optional(
      StringEnum(["codex", "grok", "openai"], {
        description:
          "Which channel to use. Omit to use the first configured channel (codex, grok, openai).",
      }),
    ),
    model: Type.Optional(
      Type.String({ description: "Override the channel's default image model." }),
    ),
    n: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10,
        description: "How many images to generate. codex supports only 1.",
      }),
    ),
    size: Type.Optional(
      Type.String({
        description:
          'openai and codex: "auto" or "WxH" (e.g. 1024x1024). Sides <= 3840, multiples of 16, ratio 1:3-3:1.',
      }),
    ),
    quality: Type.Optional(
      StringEnum(QUALITIES, {
        description:
          "openai: all values. codex: up to high. grok: up to medium. Defaults to the channel default.",
      }),
    ),
    background: Type.Optional(
      StringEnum(BACKGROUNDS, {
        description: "openai and codex: transparent background needs PNG output.",
      }),
    ),
    moderation: Type.Optional(
      StringEnum(MODERATIONS, {
        description:
          'openai only: content moderation strength. Defaults to "low", which is filtered less aggressively by the upstream.',
      }),
    ),
    aspectRatio: Type.Optional(
      Type.String({ description: 'grok only, e.g. "16:9", "1:1", "auto".' }),
    ),
    resolution: Type.Optional(StringEnum(RESOLUTIONS, { description: "grok only." })),
    references: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 16,
        description:
          "Reference image paths (absolute, or relative to the working directory) for image-to-image. Up to 5 for codex/grok, 16 for openai.",
      }),
    ),
    outputPath: Type.Optional(
      Type.String({
        description:
          "Where to write the image: a directory, or a file path ending in .png/.jpg/.webp. Defaults to <cwd>/generated/.",
      }),
    ),
    returnImage: Type.Optional(
      Type.Boolean({
        description: "Return the image inline so you can see it. Defaults to true.",
      }),
    ),
  },
  { additionalProperties: false },
)

const UsageSchema = Type.Object({
  input: Type.Optional(Type.Integer()),
  output: Type.Optional(Type.Integer()),
  total: Type.Optional(Type.Integer()),
})

const DetailsSchema = Type.Object({
  paths: Type.Array(Type.String()),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  imageCount: Type.Integer(),
  upstreamMs: Type.Optional(Type.Integer()),
  warnings: Type.Array(Type.String()),
  usage: Type.Optional(UsageSchema),
})

export interface ImageGenDetails {
  paths: string[]
  provider?: string
  model?: string
  imageCount: number
  upstreamMs?: number
  warnings: string[]
  usage?: { input?: number; output?: number; total?: number }
  error?: string
  code?: string
  requestId?: string
}

export interface ImageGenToolOptions {
  channels: readonly Channel[]
  store: ImageGenAuthStore
  createDeps: (ctx: ExtensionContext, config: ImageGenConfig) => ChannelDeps
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function successText(result: GenerationResult, inlineCount: number): string {
  const lines: string[] = []
  lines.push(
    `Generated ${result.images.length} image(s) with ${result.provider} / ${result.model} in ${formatSeconds(result.upstreamMs)}:`,
  )
  for (const image of result.images) lines.push(`- ${image.path}`)
  if (result.images.length > inlineCount) {
    lines.push(
      `(Only the first ${inlineCount} image(s) are inlined; the rest are at the paths listed above - use the read tool to view them.)`,
    )
  }
  if (result.usage?.total !== undefined) lines.push(`Upstream usage: ${result.usage.total} tokens.`)
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`)
  return lines.join("\n")
}

function errorText(error: ImageGenError): string {
  const diagnostics: string[] = []
  if (error.code !== undefined) diagnostics.push(`code=${error.code}`)
  if (error.requestId !== undefined) diagnostics.push(`requestId=${error.requestId}`)
  if (error.upstreamMs !== undefined) diagnostics.push(`upstreamMs=${error.upstreamMs}`)
  return diagnostics.length > 0 ? `${error.message} [${diagnostics.join(" ")}]` : error.message
}

/** `structuredContent` 是 JsonValue：不能带 `undefined`，所以逐字段挑有值的。 */
function structuredFrom(result: GenerationResult): JsonObject {
  const usage = result.usage
  let compactUsage: JsonObject | undefined
  if (usage !== undefined) {
    compactUsage = {}
    if (usage.input !== undefined) compactUsage.input = usage.input
    if (usage.output !== undefined) compactUsage.output = usage.output
    if (usage.total !== undefined) compactUsage.total = usage.total
    if (Object.keys(compactUsage).length === 0) compactUsage = undefined
  }

  const structured: Record<string, JsonValue> = {
    paths: result.images.map((image) => image.path),
    provider: result.provider,
    model: result.model,
    imageCount: result.images.length,
    upstreamMs: result.upstreamMs,
    warnings: result.warnings,
  }
  if (compactUsage !== undefined) structured.usage = compactUsage
  return structured
}

export function registerImageGenTool(pi: ExtensionAPI, options: ImageGenToolOptions): void {
  pi.registerTool({
    name: "image_gen",
    label: "Generate Image",
    description: DESCRIPTION,
    promptSnippet:
      "Generate an image from a text prompt (optionally guided by reference images).",
    parameters: Parameters,
    outputSchema: DetailsSchema,
    // 通道内有并发闸门，同批调用串行执行。
    executionMode: "sequential",
    annotations: { openWorldHint: true, readOnlyHint: false, idempotentHint: false },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const prompt = params.prompt.trim()
      if (prompt.length === 0) {
        return failure(new ImageGenError("prompt must not be empty."))
      }

      let config: ImageGenConfig
      try {
        config = await loadConfig()
      } catch (error) {
        return failure(toImageGenError(error))
      }

      try {
        const deps = options.createDeps(ctx, config)
        const result = await runGeneration({
          request: {
            prompt,
            ...(params.provider !== undefined
              ? { provider: params.provider as ProviderId }
              : {}),
            ...(params.model !== undefined ? { model: params.model } : {}),
            ...(params.n !== undefined ? { n: params.n } : {}),
            ...(params.size !== undefined ? { size: params.size } : {}),
            ...(params.quality !== undefined ? { quality: params.quality } : {}),
            ...(params.background !== undefined ? { background: params.background } : {}),
            ...(params.moderation !== undefined ? { moderation: params.moderation } : {}),
            ...(params.aspectRatio !== undefined ? { aspectRatio: params.aspectRatio } : {}),
            ...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
            ...(params.references !== undefined ? { references: params.references } : {}),
            ...(params.outputPath !== undefined ? { outputPath: params.outputPath } : {}),
          },
          cwd: ctx.cwd,
          config,
          channels: options.channels,
          deps,
          ...(signal !== undefined ? { signal } : {}),
        })

        const inlineCount = params.returnImage === false ? 0 : config.inlineImages
        const content: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [{ type: "text", text: successText(result, inlineCount) }]
        for (const image of result.images.slice(0, inlineCount)) {
          content.push({
            type: "image",
            data: Buffer.from(image.bytes).toString("base64"),
            mimeType: image.mimeType,
          })
        }

        const details: ImageGenDetails = {
          paths: result.images.map((image) => image.path),
          provider: result.provider,
          model: result.model,
          imageCount: result.images.length,
          upstreamMs: result.upstreamMs,
          warnings: result.warnings,
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
        }

        return {
          content,
          details,
          structuredContent: structuredFrom(result),
        }
      } catch (error) {
        return failure(toImageGenError(error))
      }
    },
  })
}

function toImageGenError(error: unknown): ImageGenError {
  if (error instanceof ImageGenError) return error
  return new ImageGenError("Image generation failed. Try again shortly.")
}

function failure(error: ImageGenError) {
  const details: ImageGenDetails = {
    paths: [],
    imageCount: 0,
    warnings: [],
    error: error.message,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    ...(error.upstreamMs !== undefined ? { upstreamMs: error.upstreamMs } : {}),
  }
  return {
    content: [{ type: "text" as const, text: errorText(error) }],
    details,
    isError: true,
  }
}

export { Parameters as ImageGenParameters, DetailsSchema as ImageGenDetailsSchema }

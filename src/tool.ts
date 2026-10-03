/**
 * `image_gen` 工具：schema、执行与结果组装。
 *
 * 工具**静态注册一次**：description 写清三条通道、默认优先级与各自的能力差异，`provider` 的
 * enum 固定列出三个可选值。凭据状态变了也不重注册，改为在出错文案里列出当前可用通道。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { keyText } from "@earendil-works/pi-coding-agent"
import { StringEnum } from "@earendil-works/pi-ai"
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai"
import { Text } from "@earendil-works/pi-tui"
import { Type, type Static } from "typebox"
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

type ImageGenParams = Static<typeof Parameters>

/** 折叠时提示词预览的最大字符数。 */
const COLLAPSED_PROMPT_CHARS = 80
/** 折叠时结果卡片里展示的最大路径条数。 */
const COLLAPSED_RESULT_PATHS = 3
/** 展开/收起工具输出的键位（默认 ctrl+o；鼠标点击走同一状态）。 */
const EXPAND_KEY = "app.tools.expand" as const

function expandHint(theme: Theme): string {
  return theme.fg("dim", ` (${keyText(EXPAND_KEY)} to expand)`)
}

function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`
}

function firstPromptLine(prompt: string): string {
  const breakIndex = prompt.search(/\r?\n/)
  const line = breakIndex === -1 ? prompt : prompt.slice(0, breakIndex)
  return line.trim()
}

/** 折叠态只保留 `image_gen "提示词首行" (ctrl+o to expand)` 一行。 */
function formatCallCollapsed(args: ImageGenParams, theme: Theme): string {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  const preview = truncateInline(firstPromptLine(prompt), COLLAPSED_PROMPT_CHARS)
  const renderedPrompt = preview.length > 0 ? ` ${theme.fg("accent", `"${preview}"`)}` : ""
  return `${theme.fg("toolTitle", theme.bold("image_gen"))}${renderedPrompt}${expandHint(theme)}`
}

/** 展开态显示完整提示词（保留换行）与非默认参数。 */
function formatCallExpanded(args: ImageGenParams, theme: Theme): string {
  const prompt = typeof args.prompt === "string" ? args.prompt.replace(/\r/g, "").trim() : ""
  const lines = [theme.fg("toolTitle", theme.bold("image_gen"))]
  if (prompt.length > 0) {
    for (const line of prompt.split("\n")) lines.push(theme.fg("toolOutput", line))
  }
  const params = expandedParamLines(args)
  if (params.length > 0) {
    lines.push("")
    for (const param of params) lines.push(theme.fg("muted", `  ${param}`))
  }
  return lines.join("\n")
}

function expandedParamLines(args: ImageGenParams): string[] {
  const lines: string[] = []
  const push = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === "") return
    if (Array.isArray(value)) {
      if (value.length === 0) return
      lines.push(`${label}: ${value.join(", ")}`)
      return
    }
    lines.push(`${label}: ${String(value)}`)
  }
  push("provider", args.provider)
  push("model", args.model)
  push("n", args.n)
  push("size", args.size)
  push("quality", args.quality)
  push("background", args.background)
  push("moderation", args.moderation)
  push("aspectRatio", args.aspectRatio)
  push("resolution", args.resolution)
  push("references", args.references)
  push("outputPath", args.outputPath)
  return lines
}

function formatResultSummary(details: ImageGenDetails, theme: Theme): string {
  const parts = [`${details.imageCount} image${details.imageCount === 1 ? "" : "s"}`]
  const providerModel = [details.provider, details.model]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" / ")
  if (providerModel.length > 0) parts.push(`with ${providerModel}`)
  if (details.upstreamMs !== undefined) parts.push(`in ${formatSeconds(details.upstreamMs)}`)
  return theme.fg("success", parts.join(" "))
}

function formatResultError(details: ImageGenDetails, fallback: string, theme: Theme): string {
  const message = details.error ?? fallback
  const diagnostics: string[] = []
  if (details.code !== undefined) diagnostics.push(`code=${details.code}`)
  if (details.requestId !== undefined) diagnostics.push(`requestId=${details.requestId}`)
  const suffix = diagnostics.length > 0 ? theme.fg("dim", ` [${diagnostics.join(" ")}]`) : ""
  return `${theme.fg("error", message.length > 0 ? message : "image generation failed")}${suffix}`
}

function formatImageGenResult(
  details: ImageGenDetails | undefined,
  output: string,
  expanded: boolean,
  isError: boolean,
  theme: Theme,
): string {
  if (details === undefined) {
    return theme.fg("error", output.length > 0 ? output : "image_gen: missing details")
  }
  if (isError || details.error !== undefined) {
    return formatResultError(details, output, theme)
  }

  const lines = [formatResultSummary(details, theme)]
  if (expanded) {
    for (const path of details.paths) lines.push(theme.fg("toolOutput", path))
    for (const warning of details.warnings) lines.push(theme.fg("warning", `Warning: ${warning}`))
    const total = details.usage?.total
    if (total !== undefined) lines.push(theme.fg("dim", `Upstream usage: ${total} tokens`))
    return lines.join("\n")
  }

  for (const path of details.paths.slice(0, COLLAPSED_RESULT_PATHS)) {
    lines.push(theme.fg("toolOutput", path))
  }
  const hiddenPaths = details.paths.length - COLLAPSED_RESULT_PATHS
  if (hiddenPaths > 0) {
    const noun = hiddenPaths === 1 ? "path" : "paths"
    lines.push(theme.fg("muted", `... (${hiddenPaths} more ${noun}, ${keyText(EXPAND_KEY)} to expand)`))
  }
  if (details.warnings.length > 0) {
    const count = details.warnings.length
    const noun = count === 1 ? "warning" : "warnings"
    lines.push(theme.fg("warning", `${count} ${noun} (${keyText(EXPAND_KEY)} to expand)`))
  }
  return lines.join("\n")
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

    // 折叠显示提示词首行，展开显示完整提示词与非默认参数；
    // ctrl+o（app.tools.expand）与鼠标点击共用同一个 expanded 状态。
    renderCall(args, theme, context) {
      const text = context.expanded
        ? formatCallExpanded(args, theme)
        : formatCallCollapsed(args, theme)
      return new Text(text, 0, 0)
    },

    renderResult(result, options, theme, context) {
      if (options.isPartial) {
        return new Text(theme.fg("warning", "Generating image(s)..."), 0, 0)
      }
      const textBlock = result.content.find((block) => block.type === "text")
      const output = textBlock?.type === "text" ? textBlock.text : ""
      const details = result.details as ImageGenDetails | undefined
      const text = formatImageGenResult(details, output, options.expanded, context.isError, theme)
      return new Text(text, 0, 0)
    },

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

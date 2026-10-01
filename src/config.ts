/**
 * 插件配置：`<agent-dir>/image-gen/config.json`，可选。文件不存在时全部走内置默认值。
 *
 * 优先级：tool 参数 > 配置文件 > 内置默认。
 */
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ImageGenError } from "./util/errors.ts"
import { resolveAgentDir } from "./auth/store.ts"
import { PROVIDER_IDS, type ProviderId } from "./channels/types.ts"

export interface ImageGenConfig {
  /** 省略 provider 时的首选通道。 */
  defaultProvider?: ProviderId
  /** 省略 provider 时的尝试顺序，排在 `defaultProvider` 之后。 */
  providerOrder?: ProviderId[]
  /** 相对 cwd 的输出目录。 */
  outputDir: string
  timeoutMs: number
  maxConcurrent: number
  /** 最多内联几张图片给模型看；多出来的只给路径。 */
  inlineImages: number
  /** 各通道的默认模型。 */
  models: Partial<Record<ProviderId, string>>
}

export const DEFAULT_OUTPUT_DIR = "generated"

export function defaultConfig(): ImageGenConfig {
  return {
    outputDir: DEFAULT_OUTPUT_DIR,
    timeoutMs: 180_000,
    maxConcurrent: 2,
    inlineImages: 4,
    models: {},
  }
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["PI_IMAGE_GEN_CONFIG_FILE"]
  if (override !== undefined && override.trim().length > 0) return override
  return join(resolveAgentDir(env), "image-gen", "config.json")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseProviderId(value: unknown, field: string): ProviderId {
  if (typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value)) {
    return value as ProviderId
  }
  throw new ImageGenError(`config.json: ${field} must be one of ${PROVIDER_IDS.join(" / ")}.`)
}

function parsePositiveInt(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
    throw new ImageGenError(`config.json: ${field} must be an integer between 1 and ${max}.`)
  }
  return value
}

export function parseConfig(value: unknown, path: string): ImageGenConfig {
  if (!isRecord(value)) throw new ImageGenError(`config.json is not an object: ${path}`)
  const config = defaultConfig()

  const known = new Set([
    "defaultProvider",
    "providerOrder",
    "outputDir",
    "timeoutMs",
    "maxConcurrent",
    "inlineImages",
    "models",
  ])
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new ImageGenError(`config.json has an unknown field: ${key}`)
  }

  if (value["defaultProvider"] !== undefined) {
    config.defaultProvider = parseProviderId(value["defaultProvider"], "defaultProvider")
  }
  if (value["providerOrder"] !== undefined) {
    const order = value["providerOrder"]
    if (!Array.isArray(order)) throw new ImageGenError("config.json: providerOrder must be an array.")
    config.providerOrder = order.map((entry, index) =>
      parseProviderId(entry, `providerOrder[${index}]`),
    )
  }
  if (value["outputDir"] !== undefined) {
    const outputDir = value["outputDir"]
    if (typeof outputDir !== "string" || outputDir.trim().length === 0) {
      throw new ImageGenError("config.json: outputDir must be a non-empty string.")
    }
    config.outputDir = outputDir
  }
  if (value["timeoutMs"] !== undefined) {
    const timeoutMs = value["timeoutMs"]
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
      throw new ImageGenError("config.json: timeoutMs must be a number >= 1000.")
    }
    config.timeoutMs = Math.floor(timeoutMs)
  }
  if (value["maxConcurrent"] !== undefined) {
    config.maxConcurrent = parsePositiveInt(value["maxConcurrent"], "maxConcurrent", 8)
  }
  if (value["inlineImages"] !== undefined) {
    config.inlineImages = parsePositiveInt(value["inlineImages"], "inlineImages", 10)
  }
  if (value["models"] !== undefined) {
    const models = value["models"]
    if (!isRecord(models)) throw new ImageGenError("config.json: models must be an object.")
    for (const [key, model] of Object.entries(models)) {
      if (!(PROVIDER_IDS as readonly string[]).includes(key)) {
        throw new ImageGenError(`config.json: models has an unknown channel: ${key}`)
      }
      if (typeof model !== "string" || model.trim().length === 0) {
        throw new ImageGenError(`config.json: models.${key} must be a non-empty string.`)
      }
      config.models[key as ProviderId] = model
    }
  }

  return config
}

/** 读配置。文件不存在时返回默认值；损坏时抛错，**不静默回退**。 */
export async function loadConfig(
  options: { env?: NodeJS.ProcessEnv; path?: string } = {},
): Promise<ImageGenConfig> {
  const env = options.env ?? process.env
  const path = options.path ?? resolveConfigPath(env)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig()
    throw new ImageGenError("Could not read config.json.")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ImageGenError(`config.json is not valid JSON: ${path}`)
  }
  return parseConfig(parsed, path)
}

/** 临时文件 + rename，避免写一半留下损坏的配置。 */
async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(tempPath, path)
  } catch {
    throw new ImageGenError("Could not write config.json.")
  }
}

/** 读-改-写配置；只用于 `/image-gen default` 这类局部修改。 */
export async function updateConfig(
  patch: Partial<ImageGenConfig>,
  options: { env?: NodeJS.ProcessEnv; path?: string } = {},
): Promise<ImageGenConfig> {
  const env = options.env ?? process.env
  const path = options.path ?? resolveConfigPath(env)
  const current = await loadConfig({ env, path })
  const next: ImageGenConfig = { ...current, ...patch }
  await writeJsonAtomically(path, next)
  return next
}

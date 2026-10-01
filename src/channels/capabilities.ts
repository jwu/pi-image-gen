/**
 * 通道选择与能力校验。
 *
 * 两条硬规则：
 * 1. **不自动换通道**。codex / grok 走订阅、openai 是付费 Key，静默切换等于替用户花钱。
 *    参数与能力冲突时报错并指出哪个通道支持，让模型自己决定。
 * 2. **不静默丢参数**。不支持的参数一律报错，不做「能生多少生多少」的降级。
 */
import { CHANNEL_LOGIN_HINTS, ImageGenError } from "../util/errors.ts"
import { formatBytes } from "../util/image.ts"
import type { Channel, ChannelDeps, GenerateInput, ProviderId } from "./types.ts"
import { PROVIDER_IDS } from "./types.ts"

export const BUILTIN_ORDER: readonly ProviderId[] = PROVIDER_IDS

function channelNames(channels: readonly Channel[]): string {
  return channels.map((channel) => channel.id).join(", ")
}

function pick(
  channels: readonly Channel[],
  predicate: (channel: Channel) => boolean,
): readonly Channel[] {
  return channels.filter(predicate)
}

/** 冲突时附上「谁支持」，让模型一轮就能改对；一个支持的都没有时直接说清楚。 */
function conflict(message: string, supporting: readonly Channel[]): ImageGenError {
  if (supporting.length === 0) return new ImageGenError(`${message} No channel supports this request.`)
  return new ImageGenError(`${message} Supported by: ${channelNames(supporting)}.`)
}

/** 在触达上游之前本地校验输入；冲突一律抛错。 */
export function assertCapabilities(
  channel: Channel,
  input: GenerateInput,
  all: readonly Channel[],
): void {
  const caps = channel.capabilities

  if (input.n > caps.maxImages) {
    throw conflict(
      `${channel.id} generates at most ${caps.maxImages} image(s) per request (asked for n=${input.n}).`,
      pick(all, (candidate) => candidate.capabilities.maxImages >= input.n),
    )
  }

  if (input.references.length > caps.maxReferenceImages) {
    throw conflict(
      `${channel.id} accepts at most ${caps.maxReferenceImages} reference image(s) (got ${input.references.length}).`,
      pick(all, (candidate) => candidate.capabilities.maxReferenceImages >= input.references.length),
    )
  }

  const referenceBytes = input.references.reduce(
    (total, reference) => total + reference.bytes.byteLength,
    0,
  )
  if (referenceBytes > caps.maxReferenceBytes) {
    throw conflict(
      `${channel.id} reference images must total at most ${formatBytes(caps.maxReferenceBytes)} (currently ${formatBytes(referenceBytes)}).`,
      pick(all, (candidate) => candidate.capabilities.maxReferenceBytes >= referenceBytes),
    )
  }

  if (input.quality !== undefined && !caps.qualities.includes(input.quality)) {
    throw conflict(
      `${channel.id} does not support quality=${input.quality}.`,
      pick(
        all,
        (candidate) =>
          input.quality !== undefined && candidate.capabilities.qualities.includes(input.quality),
      ),
    )
  }

  if (input.size !== undefined && !caps.supportsSize) {
    throw conflict(
      `${channel.id} does not support the size parameter.`,
      pick(all, (candidate) => candidate.capabilities.supportsSize),
    )
  }

  if (input.moderation !== undefined && !caps.supportsModeration) {
    throw conflict(
      `${channel.id} does not support the moderation parameter.`,
      pick(all, (candidate) => candidate.capabilities.supportsModeration),
    )
  }

  if (input.background !== undefined && !caps.supportsBackground) {
    throw conflict(
      `${channel.id} does not support the background parameter.`,
      pick(all, (candidate) => candidate.capabilities.supportsBackground),
    )
  }

  if (input.aspectRatio !== undefined && !caps.supportsAspectRatio) {
    throw conflict(
      `${channel.id} does not support the aspectRatio parameter.`,
      pick(all, (candidate) => candidate.capabilities.supportsAspectRatio),
    )
  }

  if (input.resolution !== undefined && !caps.supportsResolution) {
    throw conflict(
      `${channel.id} does not support the resolution parameter.`,
      pick(all, (candidate) => candidate.capabilities.supportsResolution),
    )
  }

  if (!caps.supportsWebpReferences) {
    const webp = input.references.find((reference) => reference.mimeType === "image/webp")
    if (webp !== undefined) {
      throw new ImageGenError(
        `${channel.id} does not accept WebP reference images. Convert them to PNG or JPEG first: ${webp.path}`,
      )
    }
  }
}

export interface ResolveChannelOptions {
  requested?: ProviderId
  channels: readonly Channel[]
  deps: ChannelDeps
  /** 配置文件里的默认通道。 */
  preferred?: ProviderId
  /** 配置文件里的顺序。 */
  order?: readonly ProviderId[]
}

function unavailableError(channel: Channel): ImageGenError {
  const hint = CHANNEL_LOGIN_HINTS[channel.id] ?? channel.loginHint
  return new ImageGenError(`${channel.id} is not configured. ${hint}`)
}

async function configuredMap(
  channels: readonly Channel[],
  deps: ChannelDeps,
): Promise<Map<ProviderId, boolean>> {
  const entries = await Promise.all(
    channels.map(async (channel) => {
      const configured = await channel.isConfigured(deps).catch(() => false)
      return [channel.id, configured] as const
    }),
  )
  return new Map(entries)
}

/**
 * 解析这次请求用哪条通道。
 *
 * - 显式指定：必须是已配置的通道，否则报错并列出可用通道。
 * - 省略：`preferred` → `order` → 内置顺序 `codex → grok → openai`，取第一个已配置的。
 */
export async function resolveChannel(options: ResolveChannelOptions): Promise<Channel> {
  const { channels, deps, requested, preferred, order } = options
  const byId = new Map(channels.map((channel) => [channel.id, channel]))

  if (requested !== undefined) {
    const channel = byId.get(requested)
    if (channel === undefined) throw new ImageGenError(`Unknown channel: ${requested}`)
    const configured = await channel.isConfigured(deps).catch(() => false)
    if (!configured) {
      const available = await configuredMap(channels, deps)
      const usable = channels.filter((candidate) => available.get(candidate.id) === true)
      const suffix =
        usable.length > 0
          ? `Available channels: ${channelNames(usable)}.`
          : "No channels are currently available."
      throw new ImageGenError(`${unavailableError(channel).message} ${suffix}`)
    }
    return channel
  }

  const configured = await configuredMap(channels, deps)
  const usable = channels.filter((channel) => configured.get(channel.id) === true)
  if (usable.length === 0) {
    const hints = channels.map((channel) => `${channel.id}: ${channel.loginHint}`).join("; ")
    throw new ImageGenError(`No image channel is configured. ${hints}`)
  }

  const sequence: ProviderId[] = []
  if (preferred !== undefined) sequence.push(preferred)
  if (order !== undefined) sequence.push(...order)
  sequence.push(...BUILTIN_ORDER)

  for (const id of sequence) {
    if (configured.get(id) === true) {
      const channel = byId.get(id)
      if (channel !== undefined) return channel
    }
  }
  return usable[0]!
}

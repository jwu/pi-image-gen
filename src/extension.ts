/**
 * pi-image-gen：让 coding agent 通过 `image_gen` 工具生成图片。
 *
 * 阶段 1 只接 OpenAI Images（API Key）；codex / grok 通道随后补上。
 * 工厂里只做注册，不启动任何进程、socket 或定时器 —— 长生命周期资源在真正需要时再创建。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { CodexAuth } from "./auth/codex.ts"
import { GrokAuth } from "./auth/grok.ts"
import { ImageGenAuthStore } from "./auth/store.ts"
import { codexChannel } from "./channels/codex.ts"
import { grokChannel } from "./channels/grok.ts"
import { openaiChannel } from "./channels/openai.ts"
import type { Channel, ChannelDeps } from "./channels/types.ts"
import { registerImageGenCommand } from "./commands.ts"
import type { ImageGenConfig } from "./config.ts"
import { registerImageGenTool } from "./tool.ts"

/** 设备码轮询之类的等待用；`signal` 触发时立即拒绝。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export default function imageGenExtension(pi: ExtensionAPI): void {
  const store = new ImageGenAuthStore()
  const grokAuth = new GrokAuth({
    store,
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep,
  })
  const codexAuth = new CodexAuth({
    store,
    fetch: globalThis.fetch,
    now: () => Date.now(),
  })
  // 顺序即内置优先级：codex → grok → openai。
  const channels: readonly Channel[] = [codexChannel, grokChannel, openaiChannel]

  const createDeps = (_ctx: ExtensionContext, config: ImageGenConfig): ChannelDeps => ({
    fetch: globalThis.fetch,
    store,
    grokAuth,
    codexAuth,
    env: process.env,
    timeoutMs: config.timeoutMs,
    now: () => Date.now(),
    sleep,
  })

  registerImageGenTool(pi, { channels, store, createDeps })
  registerImageGenCommand(pi, { channels, store, grokAuth, codexAuth, createDeps })
}

export { ImageGenAuthStore } from "./auth/store.ts"
export { CodexAuth } from "./auth/codex.ts"
export { GrokAuth } from "./auth/grok.ts"
export { codexChannel } from "./channels/codex.ts"
export { grokChannel } from "./channels/grok.ts"
export { openaiChannel } from "./channels/openai.ts"
export { registerImageGenCommand } from "./commands.ts"
export { registerImageGenTool } from "./tool.ts"
export { runGeneration } from "./runner.ts"

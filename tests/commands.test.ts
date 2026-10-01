import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent"
import type { GrokAuth } from "../src/auth/grok.ts"
import type { CodexAuth } from "../src/auth/codex.ts"
import { ImageGenAuthStore } from "../src/auth/store.ts"
import { codexChannel } from "../src/channels/codex.ts"
import { grokChannel } from "../src/channels/grok.ts"
import { openaiChannel } from "../src/channels/openai.ts"
import type { Channel } from "../src/channels/types.ts"
import { registerImageGenCommand, completeImageGenArguments } from "../src/commands.ts"
import { makeDeps, temporaryAuthPath } from "./helpers.ts"

interface Harness {
  command: RegisteredCommand
  ctx: ExtensionCommandContext
  notifications: Array<{ message: string; type?: string }>
  store: ImageGenAuthStore
  grokAuth: GrokAuth
  inputCalls: number
}

function grokAuthStub(overrides: Record<string, unknown> = {}): GrokAuth {
  return {
    status: async () => ({ configured: false, expired: false }),
    login: async () => {},
    logout: async () => {},
    headers: async () => ({}),
    ...overrides,
  } as unknown as GrokAuth
}

function codexAuthStub(overrides: Record<string, unknown> = {}): CodexAuth {
  return {
    status: async () => ({ configured: false, expired: false }),
    login: async () => {},
    logout: async () => {},
    credentials: async () => ({ access: "a", accountId: "acct" }),
    ...overrides,
  } as unknown as CodexAuth
}

async function setup(
  options: {
    channels?: Channel[]
    grokAuth?: GrokAuth
    codexAuth?: CodexAuth
    uiInput?: string | undefined
    uiSelect?: string | undefined
    hasUI?: boolean
    /** 默认不真开浏览器。 */
    browserOpened?: boolean
  } = {},
): Promise<Harness> {
  let command: RegisteredCommand | undefined
  const pi = {
    registerCommand(_name: string, registered: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      command = { ...registered, name: "image-gen", sourceInfo: {} as never }
    },
  } as unknown as ExtensionAPI

  const store = new ImageGenAuthStore({ filePath: temporaryAuthPath() })
  const grokAuth = options.grokAuth ?? grokAuthStub()
  const codexAuth = options.codexAuth ?? codexAuthStub()
  const notifications: Array<{ message: string; type?: string }> = []

  registerImageGenCommand(pi, {
    channels: options.channels ?? [codexChannel, grokChannel, openaiChannel],
    store,
    grokAuth,
    codexAuth,
    createDeps: (_ctx: ExtensionContext) => makeDeps({ store, env: process.env }),
    openBrowser: () => options.browserOpened ?? false,
  })

  if (command === undefined) throw new Error("command was not registered")

  const harness = {
    command,
    notifications,
    store,
    grokAuth,
    inputCalls: 0,
  } as Harness

  const cwd = await mkdtemp(join(tmpdir(), "pi-image-gen-cmd-"))
  harness.ctx = {
    cwd,
    mode: options.hasUI === false ? "print" : "tui",
    hasUI: options.hasUI !== false,
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      input: async () => {
        harness.inputCalls += 1
        return options.uiInput
      },
      select: async () => {
        harness.inputCalls += 1
        return options.uiSelect
      },
      confirm: async () => true,
    },
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: false }),
      getProviderAuth: async () => undefined,
    },
  } as never

  return harness
}

const originalConfigFile = process.env["PI_IMAGE_GEN_CONFIG_FILE"]
const originalOpenAiKey = process.env["OPENAI_API_KEY"]

beforeEach(async () => {
  process.env["PI_IMAGE_GEN_CONFIG_FILE"] = join(
    await mkdtemp(join(tmpdir(), "pi-image-gen-cfg-")),
    "config.json",
  )
  delete process.env["OPENAI_API_KEY"]
})

afterEach(() => {
  if (originalConfigFile === undefined) delete process.env["PI_IMAGE_GEN_CONFIG_FILE"]
  else process.env["PI_IMAGE_GEN_CONFIG_FILE"] = originalConfigFile
  if (originalOpenAiKey === undefined) delete process.env["OPENAI_API_KEY"]
  else process.env["OPENAI_API_KEY"] = originalOpenAiKey
})

async function run(harness: Harness, args: string): Promise<void> {
  await harness.command.handler(args, harness.ctx)
}

function lastMessage(harness: Harness): string {
  return harness.notifications.at(-1)?.message ?? ""
}

async function writtenConfig(): Promise<Record<string, unknown>> {
  const raw = await readFile(process.env["PI_IMAGE_GEN_CONFIG_FILE"] as string, "utf8")
  return JSON.parse(raw) as Record<string, unknown>
}

describe("/image-gen status", () => {
  test("列出三条通道并标注未配置原因", async () => {
    const harness = await setup()
    await run(harness, "")
    const text = lastMessage(harness)
    expect(text).toContain("codex")
    expect(text).toContain("grok")
    expect(text).toContain("openai")
    expect(text).toContain("/image-gen login codex")
    expect(text).toContain("/image-gen login grok")
    expect(text).toContain("Default channel")
  })

  test("识别环境变量提供的 OpenAI Key，但不回显内容", async () => {
    process.env["OPENAI_API_KEY"] = "sk-super-secret"
    const harness = await setup()
    await run(harness, "status")
    const text = lastMessage(harness)
    expect(text).toContain("OPENAI_API_KEY environment variable")
    expect(text).not.toContain("sk-super-secret")
  })

  test("grok 已登录时显示状态", async () => {
    const harness = await setup({
      grokAuth: grokAuthStub({ status: async () => ({ configured: true, expired: false }) }),
    })
    await run(harness, "")
    expect(lastMessage(harness)).toContain("grok: signed in")
  })
})

describe("/image-gen key", () => {
  test("直接给出的 Key 被保存且不进通知文本", async () => {
    const harness = await setup()
    await run(harness, "key sk-abc123")
    expect(await harness.store.read("openai")).toEqual({ type: "api_key", key: "sk-abc123" })
    expect(lastMessage(harness)).not.toContain("sk-abc123")
  })

  test("无参数且没有 UI 时提示直接给出", async () => {
    const harness = await setup({ hasUI: false })
    await run(harness, "key")
    expect(lastMessage(harness)).toContain("non-interactive mode")
    expect(harness.inputCalls).toBe(0)
  })

  test("从输入框取值并保存", async () => {
    const harness = await setup({ uiInput: "sk-from-input" })
    await run(harness, "key")
    expect(await harness.store.read("openai")).toEqual({
      type: "api_key",
      key: "sk-from-input",
    })
    expect(lastMessage(harness)).not.toContain("sk-from-input")
  })

  test("用户取消输入时不改动", async () => {
    const harness = await setup({ uiInput: undefined })
    await run(harness, "key")
    expect(await harness.store.read("openai")).toBeUndefined()
  })
})

describe("/image-gen logout", () => {
  test("删除插件保存的 OpenAI Key", async () => {
    const harness = await setup()
    await harness.store.set("openai", { type: "api_key", key: "k" })
    await run(harness, "logout openai")
    expect(await harness.store.read("openai")).toBeUndefined()
  })

  test("codex 删除插件自己的凭据", async () => {
    let loggedOut = false
    const harness = await setup({
      codexAuth: codexAuthStub({
        logout: async () => {
          loggedOut = true
        },
      }),
    })
    await run(harness, "logout codex")
    expect(loggedOut).toBe(true)
    expect(lastMessage(harness)).toContain("Removed the stored Codex credential")
  })

  test("未知目标给出用法", async () => {
    const harness = await setup()
    await run(harness, "logout nope")
    expect(lastMessage(harness)).toContain("Usage")
  })

  test("无参数时列出已存凭据供选择", async () => {
    const harness = await setup({ uiSelect: "OpenAI API key" })
    await harness.store.set("openai", { type: "api_key", key: "k" })
    await run(harness, "logout")
    expect(await harness.store.read("openai")).toBeUndefined()
    expect(lastMessage(harness)).toContain("Removed the stored OpenAI key")
  })

  test("没有已存凭据时直接说明", async () => {
    const harness = await setup()
    await run(harness, "logout")
    expect(lastMessage(harness)).toContain("No stored credentials")
  })
})

describe("/image-gen default", () => {
  test("写入配置文件", async () => {
    const harness = await setup()
    await run(harness, "default grok")
    expect((await writtenConfig())["defaultProvider"]).toBe("grok")
  })

  test("未知通道不改动配置", async () => {
    const harness = await setup()
    await run(harness, "default midjourney")
    expect(lastMessage(harness)).toContain("Unknown channel")
  })

  test("无参数时用选择框", async () => {
    const harness = await setup({ uiSelect: "openai" })
    await run(harness, "default")
    expect((await writtenConfig())["defaultProvider"]).toBe("openai")
  })
})

describe("/image-gen login", () => {
  test("grok 登录时把 user code 与网址告知用户", async () => {
    let called = false
    const harness = await setup({
      grokAuth: grokAuthStub({
        login: async (onCode: (code: unknown) => void) => {
          called = true
          onCode({
            userCode: "ABCD-1234",
            verificationUrl: "https://auth.x.ai/device",
            intervalSeconds: 1,
            expiresInSeconds: 600,
          })
        },
      }),
    })
    await run(harness, "login grok")
    expect(called).toBe(true)
    const messages = harness.notifications.map((entry) => entry.message).join("\n")
    expect(messages).toContain("ABCD-1234")
    expect(messages).toContain("https://auth.x.ai/device")
    expect(messages).toContain("Grok sign-in complete")
  })

  test("登录失败时给出错误通知", async () => {
    const harness = await setup({
      grokAuth: grokAuthStub({
        login: async () => {
          throw new Error("boom")
        },
      }),
    })
    await run(harness, "login grok")
    expect(harness.notifications.at(-1)?.type).toBe("error")
  })

  test("codex 登录会展示授权链接", async () => {
    let called = false
    const harness = await setup({
      browserOpened: true,
      codexAuth: codexAuthStub({
        login: async (onPrompt: (prompt: unknown) => void) => {
          called = true
          onPrompt({
            url: "https://auth.openai.com/oauth/authorize?client_id=x",
            redirectUri: "http://localhost:1455/auth/callback",
          })
        },
      }),
    })
    await run(harness, "login codex")
    expect(called).toBe(true)
    const messages = harness.notifications.map((entry) => entry.message).join("\n")
    expect(messages).toContain("Opened the authorization page")
    // 就算自动打开了，URL 也必须给出来当兼底。
    expect(messages).toContain("auth.openai.com")
    expect(messages).toContain("Codex sign-in complete")
  })

  test("自动打开失败时给手动指引", async () => {
    const harness = await setup({
      browserOpened: false,
      codexAuth: codexAuthStub({
        login: async (onPrompt: (prompt: unknown) => void) => {
          onPrompt({
            url: "https://auth.openai.com/oauth/authorize?client_id=x",
            redirectUri: "http://localhost:1455/auth/callback",
          })
        },
      }),
    })
    await run(harness, "login codex")
    const messages = harness.notifications.map((entry) => entry.message).join("\n")
    expect(messages).toContain("Open this URL in your browser")
    expect(messages).toContain("auth.openai.com")
  })

  test("未知登录目标提示用法", async () => {
    const harness = await setup()
    await run(harness, "login nope")
    expect(lastMessage(harness)).toContain("Usage")
  })

  test("无参数时弹出选择界面并走对应登录", async () => {
    let codexCalled = false
    const harness = await setup({
      uiSelect: "Codex  -  ChatGPT subscription (browser sign-in)",
      codexAuth: codexAuthStub({
        login: async (onPrompt: (prompt: unknown) => void) => {
          codexCalled = true
          onPrompt({
            url: "https://auth.openai.com/oauth/authorize?client_id=x",
            redirectUri: "http://localhost:1455/auth/callback",
          })
        },
      }),
    })
    await run(harness, "login")
    expect(codexCalled).toBe(true)
    expect(lastMessage(harness)).toContain("Codex sign-in complete")
  })

  test("选择界面取消时什么也不做", async () => {
    let called = false
    const harness = await setup({
      uiSelect: undefined,
      codexAuth: codexAuthStub({
        login: async () => {
          called = true
        },
      }),
    })
    await run(harness, "login")
    expect(called).toBe(false)
  })

  test("选择 OpenAI API key 时弹输入框并保存", async () => {
    const harness = await setup({
      uiSelect: "OpenAI API key  -  paste a key",
      uiInput: "sk-from-menu",
    })
    await run(harness, "login")
    expect(await harness.store.read("openai")).toEqual({
      type: "api_key",
      key: "sk-from-menu",
    })
    expect(lastMessage(harness)).not.toContain("sk-from-menu")
  })

  test("login openai sk-... 可直接给出 key", async () => {
    const harness = await setup()
    await run(harness, "login openai sk-inline")
    expect(await harness.store.read("openai")).toEqual({ type: "api_key", key: "sk-inline" })
    expect(lastMessage(harness)).not.toContain("sk-inline")
  })

  test("非交互模式提示用法", async () => {
    const harness = await setup({ hasUI: false })
    await run(harness, "login")
    expect(lastMessage(harness)).toContain("Usage")
  })
})

describe("/image-gen 未知子命令", () => {
  test("显示用法", async () => {
    const harness = await setup()
    await run(harness, "wat")
    expect(lastMessage(harness)).toContain("Usage")
  })
})

describe("completeImageGenArguments（Tab 补全）", () => {
  const values = (text: string): string[] =>
    (completeImageGenArguments(text) ?? []).map((item) => item.value)

  test("空输入列出全部子命令", () => {
    expect(values("")).toEqual(["status", "login", "key", "logout", "default"])
  })

  test("按前缀筛子命令，无匹配时返回 null", () => {
    expect(values("lo")).toEqual(["login", "logout"])
    expect(values("sta")).toEqual(["status"])
    expect(completeImageGenArguments("zzz")).toBeNull()
  })

  test("login 的候选以完整参数串作为 value", () => {
    // value 会替换整个参数串，所以必须带上 `login`，否则会把子命令吃掉。
    expect(values("login ")).toEqual(["login codex", "login grok", "login openai"])
    expect(values("login c")).toEqual(["login codex"])
    const items = completeImageGenArguments("login ") ?? []
    expect(items[0]?.label).toBe("codex")
    expect(items[0]?.description).toContain("ChatGPT")
  })

  test("logout 与 default 列出三个通道", () => {
    expect(values("logout ")).toEqual(["logout codex", "logout grok", "logout openai"])
    expect(values("default g")).toEqual(["default grok"])
  })

  test("key 后面是自由输入，不补全", () => {
    expect(completeImageGenArguments("key ")).toBeNull()
    expect(completeImageGenArguments("key sk-")).toBeNull()
  })

  test("无子参数的子命令不补全", () => {
    expect(completeImageGenArguments("status x")).toBeNull()
    expect(completeImageGenArguments("login codex ")).toBeNull()
  })
})

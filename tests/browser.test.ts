import { describe, expect, test } from "bun:test"
import { resolveOpenCommand, shouldAutoOpen } from "../src/util/browser.ts"

describe("resolveOpenCommand", () => {
  test("macOS 用 open", () => {
    expect(resolveOpenCommand("darwin", "https://x.dev")).toEqual(["open", ["https://x.dev"]])
  })

  test("Linux 用 xdg-open", () => {
    expect(resolveOpenCommand("linux", "https://x.dev")).toEqual(["xdg-open", ["https://x.dev"]])
  })

  test("Windows 用 rundll32，而不是 cmd /c start", () => {
    // cmd.exe 会先重新解析 URL 里的 & | ^，等于把链接变成可注入的。
    const [command, args] = resolveOpenCommand("win32", "https://x.dev/?a=1&b=2")
    expect(command).toBe("rundll32")
    expect(args[0]).toBe("url.dll,FileProtocolHandler")
    expect(args[1]).toBe("https://x.dev/?a=1&b=2")
  })
})

describe("shouldAutoOpen", () => {
  const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv

  test("普通桌面环境返回 true", () => {
    expect(shouldAutoOpen(env({ DISPLAY: ":0" }), "linux")).toBe(true)
    expect(shouldAutoOpen(env({}), "darwin")).toBe(true)
  })

  test("SSH 会话返回 false（打开的会是服务器的浏览器）", () => {
    expect(shouldAutoOpen(env({ SSH_CONNECTION: "1.2.3.4 22" }), "linux")).toBe(false)
    expect(shouldAutoOpen(env({ SSH_TTY: "/dev/pts/0" }), "darwin")).toBe(false)
    expect(shouldAutoOpen(env({ SSH_CLIENT: "1.2.3.4" }), "linux")).toBe(false)
  })

  test("Linux 无显示服务器返回 false", () => {
    expect(shouldAutoOpen(env({}), "linux")).toBe(false)
    expect(shouldAutoOpen(env({ WAYLAND_DISPLAY: "wayland-0" }), "linux")).toBe(true)
  })
})

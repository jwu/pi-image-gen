/**
 * 在系统浏览器里打开授权链接。
 *
 * 实现参考 pi 内部的 `utils/open-browser.ts`：**绝不经过 shell**。Windows 上尤其不能用
 * `cmd /c start` —— cmd.exe 会先重新解析 URL 里的 `&`、`|`、`^`，等于把链接变成可注入的。
 *
 * 打开浏览器是**尽力而为**：失败不抛错、不阻塞，调用方始终会把 URL 显示出来作为兜底。
 */
import { spawn } from "node:child_process"

/** 平台对应的“打开默认程序”命令。 */
export function resolveOpenCommand(
  platform: NodeJS.Platform,
  target: string,
): [string, string[]] {
  if (platform === "darwin") return ["open", [target]]
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", target]]
  return ["xdg-open", [target]]
}

/**
 * 是否值得尝试自动打开。
 *
 * SSH 会话里打开的是**服务器**的浏览器（通常是根本没有），无显示服务器的 Linux 同理 ——
 * 硬试只会制造 `xdg-open` 的报错噪音，不如直接把 URL 交给用户。
 */
export function shouldAutoOpen(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (
    env["SSH_CONNECTION"] !== undefined ||
    env["SSH_TTY"] !== undefined ||
    env["SSH_CLIENT"] !== undefined
  ) {
    return false
  }
  if (
    platform === "linux" &&
    env["DISPLAY"] === undefined &&
    env["WAYLAND_DISPLAY"] === undefined
  ) {
    return false
  }
  return true
}

/**
 * 打开 `url`，返回是否**尝试**了打开（不代表成功 —— 启动器的失败只会以 error 事件出现，
 * 我们有意忽略它）。调用方据此选择提示文案。
 */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!shouldAutoOpen(env)) return false
  const [command, args] = resolveOpenCommand(process.platform, url)
  try {
    spawn(command, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref()
    return true
  } catch {
    return false
  }
}

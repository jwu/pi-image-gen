/**
 * 冒烟验证：用 pi **真实的扩展加载器**加载本插件，确认模块能被 jiti 解析、`image_gen` 注册成功。
 *
 * 不调用模型、不发起网络请求、不接触凭据，因此可以随时跑。
 *
 * 说明：`loadExtensions` 没有从 pi 的包入口导出，这里按文件路径动态 import —— 属于开发期验证，
 * pi 升级时若内部布局变化，这个脚本可能需要跟着调。
 *
 * 用法：bun run scripts/smoke.ts
 */
import { fileURLToPath } from "node:url"
import { createEventBus, createExtensionRuntime } from "@earendil-works/pi-coding-agent"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const extensionPath = fileURLToPath(new URL("../src/extension.ts", import.meta.url))

const entry = import.meta.resolve("@earendil-works/pi-coding-agent")
const loaderPath = new URL("./core/extensions/loader.js", entry).href
const { loadExtensions } = (await import(loaderPath)) as {
  loadExtensions: (
    paths: string[],
    cwd: string,
    eventBus: unknown,
    runtime: unknown,
  ) => Promise<{
    extensions: Array<{
      path: string
      tools: Map<string, { definition: { name: string } }>
      commands: Map<string, unknown>
    }>
    errors: Array<{ path: string; error: string }>
    warnings: unknown[]
  }>
}

const result = await loadExtensions(
  [extensionPath],
  packageRoot,
  createEventBus(),
  createExtensionRuntime(),
)

if (result.errors.length > 0) {
  console.error("Extension failed to load:")
  for (const error of result.errors) console.error(`- ${error.path}: ${error.error}`)
  process.exit(1)
}

const toolNames = result.extensions.flatMap((extension) => [...extension.tools.keys()])
if (!toolNames.includes("image_gen")) {
  console.error(`image_gen was not registered; registered tools: ${toolNames.join(", ") || "(none)"}`)
  process.exit(1)
}

const commandNames = result.extensions.flatMap((extension) => [...extension.commands.keys()])
if (!commandNames.includes("image-gen")) {
  console.error(`/image-gen was not registered; registered commands: ${commandNames.join(", ") || "(none)"}`)
  process.exit(1)
}

// Tab 补全也是对外契约的一部分，值得写死在这里。
const imageGen = result.extensions
  .flatMap((extension) => [...extension.commands.entries()])
  .find(([name]) => name === "image-gen")?.[1] as
  | { getArgumentCompletions?: unknown }
  | undefined
if (typeof imageGen?.getArgumentCompletions !== "function") {
  console.error("/image-gen is missing getArgumentCompletions (Tab completion)")
  process.exit(1)
}

console.log(
  `✓ Loaded; tools: ${toolNames.join(", ")}; commands: /${commandNames.join(", /")}; Tab completion: ok`,
)

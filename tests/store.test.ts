import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ImageGenAuthStore, resolveAuthFilePath, resolveAgentDir } from "../src/auth/store.ts"
import { temporaryAuthPath } from "./helpers.ts"

function store(): ImageGenAuthStore {
  return new ImageGenAuthStore({ filePath: temporaryAuthPath() })
}

describe("resolveAuthFilePath", () => {
  test("默认落在 agent 目录下的 image-gen/auth.json", () => {
    expect(resolveAuthFilePath({} as NodeJS.ProcessEnv)).toMatch(/\.pi\/agent\/image-gen\/auth\.json$/)
  })

  test("PI_CODING_AGENT_DIR 改变 agent 目录", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/agent",
    )
  })

  test("PI_IMAGE_GEN_AUTH_FILE 直接覆盖文件路径", () => {
    expect(
      resolveAuthFilePath({ PI_IMAGE_GEN_AUTH_FILE: "/tmp/a.json" } as NodeJS.ProcessEnv),
    ).toBe("/tmp/a.json")
  })
})

describe("ImageGenAuthStore", () => {
  test("读写删除单个 provider", async () => {
    const auth = store()
    expect(await auth.read("openai")).toBeUndefined()

    await auth.set("openai", { type: "api_key", key: "sk-1" })
    expect(await auth.read("openai")).toEqual({ type: "api_key", key: "sk-1" })

    await auth.delete("openai")
    expect(await auth.read("openai")).toBeUndefined()
  })

  test("modify 保留其它 provider", async () => {
    const auth = store()
    await auth.set("openai", { type: "api_key", key: "sk-1" })
    await auth.set("grok", { type: "oauth", access: "a", refresh: "r", expires: 1 })

    await auth.modify("grok", async () => ({
      type: "oauth",
      access: "a2",
      refresh: "r2",
      expires: 2,
    }))

    expect(await auth.read("openai")).toEqual({ type: "api_key", key: "sk-1" })
    expect(await auth.read("grok")).toEqual({
      type: "oauth",
      access: "a2",
      refresh: "r2",
      expires: 2,
    })
  })

  test("modify 返回 undefined 表示删除", async () => {
    const auth = store()
    await auth.set("grok", { type: "oauth", access: "a", refresh: "r", expires: 1 })
    await auth.modify("grok", async () => undefined)
    expect(await auth.read("grok")).toBeUndefined()
  })

  test("文件权限是 0600，目录是 0700", async () => {
    if (process.platform === "win32") return
    const auth = store()
    await auth.set("openai", { type: "api_key", key: "sk-1" })

    const fileMode = (await stat(auth.path)).mode & 0o777
    const dirMode = (await stat(dirname(auth.path))).mode & 0o777
    expect(fileMode).toBe(0o600)
    expect(dirMode).toBe(0o700)
  })

  test("损坏的 JSON 报错且不被覆盖", async () => {
    const auth = store()
    await mkdir(dirname(auth.path), { recursive: true, mode: 0o700 })
    await writeFile(auth.path, "{ not json", "utf8")

    await expect(auth.read("openai")).rejects.toThrow(/not valid JSON/)
    await expect(auth.set("openai", { type: "api_key", key: "k" })).rejects.toThrow()
    expect(await readFile(auth.path, "utf8")).toBe("{ not json")
  })

  test("未知字段被拒绝", async () => {
    const auth = store()
    await mkdir(dirname(auth.path), { recursive: true, mode: 0o700 })
    await writeFile(
      auth.path,
      JSON.stringify({ version: 1, providers: { openai: { type: "api_key", key: "k", extra: 1 } } }),
      "utf8",
    )
    await expect(auth.read("openai")).rejects.toThrow(/unexpected shape/)
  })

  test("非法 provider id 被拒绝", async () => {
    const auth = store()
    await expect(auth.set("bad id", { type: "api_key", key: "k" })).rejects.toThrow(/Invalid/)
  })

  test("符号链接路径 fail closed", async () => {
    if (process.platform === "win32") return
    const target = join(dirname(temporaryAuthPath()), "target.json")
    const linkPath = join(dirname(target), "auth.json")
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, JSON.stringify({ version: 1, providers: {} }), "utf8")
    await chmod(target, 0o600)
    await symlink(target, linkPath)

    const auth = new ImageGenAuthStore({ filePath: linkPath })
    await expect(auth.read("openai")).rejects.toThrow(/not a regular file/)
  })

  test("list 只回报 provider 与类型，不含正文", async () => {
    const auth = store()
    await auth.set("openai", { type: "api_key", key: "sk-secret" })
    const entries = await auth.list()
    expect(entries).toEqual([{ provider: "openai", type: "api_key" }])
    expect(JSON.stringify(entries)).not.toContain("sk-secret")
  })
})

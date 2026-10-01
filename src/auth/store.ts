/**
 * 插件自己的凭据库：`<agent-dir>/image-gen/auth.json`。
 *
 * 与 pi 的登录完全隔离：只有 Grok 与 Codex 的 OAuth、以及可选的 OpenAI API Key。
 *
 * 语义与 ai-canvas 的 `server/authStorage.ts` 一致，因为那套语义已经在生产里验证过：
 * 目录 0700 / 文件 0600、跨进程锁文件、临时文件 rename 原子替换、损坏文件 fail closed、
 * 符号链接一律拒绝。明文 JSON + 文件权限保护，不是加密保险库。
 */
import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, rename, unlink, utimes } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Credential =
  | { type: "api_key"; key: string }
  | {
      type: "oauth"
      access: string
      refresh: string
      expires: number
      accountId?: string
    }

export interface AuthDocument {
  version: 1
  providers: Record<string, Credential>
}

const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 10 * 60_000
const LOCK_HEARTBEAT_MS = 30_000
const LOCK_POLL_MS = 100

const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/

/** 已可直接展示的错误；原始 IO 错误一律包装掉，避免泄漏路径。 */
class SafeStorageError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["PI_CODING_AGENT_DIR"]
  if (override !== undefined && override.trim().length > 0) return override
  return join(homedir(), ".pi", "agent")
}

export function resolveAuthFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["PI_IMAGE_GEN_AUTH_FILE"]
  if (override !== undefined && override.trim().length > 0) return override
  return join(resolveAgentDir(env), "image-gen", "auth.json")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** 只接受已知字段，未知字段一律拒绝：避免凭据库被塞进计划外的东西。 */
export function parseCredential(value: unknown): Credential {
  if (!isRecord(value)) throw new Error("Invalid credential.")
  const keys = Object.keys(value)
  if (value["type"] === "api_key") {
    if (!keys.every((key) => key === "type" || key === "key")) throw new Error("Invalid credential.")
    if (!isNonEmptyString(value["key"])) throw new Error("Invalid credential.")
    return { type: "api_key", key: value["key"] }
  }
  if (value["type"] === "oauth") {
    const allowed = new Set(["type", "access", "refresh", "expires", "accountId"])
    if (!keys.every((key) => allowed.has(key))) throw new Error("Invalid credential.")
    if (!isNonEmptyString(value["access"]) || !isNonEmptyString(value["refresh"])) {
      throw new Error("Invalid credential.")
    }
    if (typeof value["expires"] !== "number" || !Number.isFinite(value["expires"])) {
      throw new Error("Invalid credential.")
    }
    const credential: Credential = {
      type: "oauth",
      access: value["access"],
      refresh: value["refresh"],
      expires: value["expires"],
    }
    if (isNonEmptyString(value["accountId"])) credential.accountId = value["accountId"]
    return credential
  }
  throw new Error("Invalid credential.")
}

function parseDocument(value: unknown): AuthDocument {
  if (!isRecord(value)) throw new Error("Local credential store has an unexpected shape.")
  if (value["version"] !== 1) throw new Error("Local credential store has an unexpected shape.")
  const providers = value["providers"]
  if (!isRecord(providers)) throw new Error("Local credential store has an unexpected shape.")
  const parsed: Record<string, Credential> = Object.create(null) as Record<string, Credential>
  for (const [id, credential] of Object.entries(providers)) {
    if (!PROVIDER_ID_PATTERN.test(id)) {
      throw new Error("Local credential store has an unexpected shape.")
    }
    try {
      parsed[id] = parseCredential(credential)
    } catch {
      // 文件里的脏数据统一报“形状不对”，不把内部校验细节漏出去。
      throw new Error("Local credential store has an unexpected shape.")
    }
  }
  return { version: 1, providers: parsed }
}

function emptyDocument(): AuthDocument {
  return { version: 1, providers: Object.create(null) as Record<string, Credential> }
}

export class ImageGenAuthStore {
  private readonly filePath: string

  constructor(options: { filePath?: string } = {}) {
    this.filePath = options.filePath ?? resolveAuthFilePath()
  }

  get path(): string {
    return this.filePath
  }

  async read(provider: string): Promise<Credential | undefined> {
    assertProvider(provider)
    const document = await this.readDocument()
    return document.providers[provider]
  }

  /** 列出已存凭据的类型，不回显任何正文。 */
  async list(): Promise<Array<{ provider: string; type: Credential["type"] }>> {
    const document = await this.readDocument()
    return Object.entries(document.providers).map(([provider, credential]) => ({
      provider,
      type: credential.type,
    }))
  }

  async set(provider: string, credential: Credential): Promise<void> {
    await this.modify(provider, async () => credential)
  }

  /** 删除 `provider`；不存在时是 no-op。 */
  async delete(provider: string): Promise<void> {
    assertProvider(provider)
    await this.withLock(async () => {
      const document = await this.readDocument()
      if (!Object.hasOwn(document.providers, provider)) return
      const providers = { ...document.providers }
      delete providers[provider]
      await this.writeDocument({ version: 1, providers })
    })
  }

  /**
   * 加锁的读-改-写。`fn` 拿到磁盘上的最新值，返回 `undefined` 表示删除该 provider。
   * 锁覆盖整个回调，因此跨进程的 token 刷新不会交错。
   */
  async modify(
    provider: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    assertProvider(provider)
    return this.withLock(async () => {
      const document = await this.readDocument()
      const result = await fn(document.providers[provider])
      if (result === undefined) {
        if (!Object.hasOwn(document.providers, provider)) return undefined
        const providers = { ...document.providers }
        delete providers[provider]
        await this.writeDocument({ version: 1, providers })
        return undefined
      }
      const next = parseCredential(result)
      await this.writeDocument({
        version: 1,
        providers: { ...document.providers, [provider]: next },
      })
      return next
    })
  }

  // -------------------------------------------------------------------------
  // Document IO
  // -------------------------------------------------------------------------

  private async readDocument(): Promise<AuthDocument> {
    if (!(await this.regularFileExists(this.filePath))) return emptyDocument()
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch (error) {
      if (isErrno(error, "ENOENT")) return emptyDocument()
      throw new Error("Could not read the local credential store.")
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 损坏的库不会被当成空库覆盖掉。
      throw new Error("Local credential store is not valid JSON.")
    }
    return parseDocument(parsed)
  }

  private async writeDocument(document: AuthDocument): Promise<void> {
    await this.ensureDirectory()
    await this.regularFileExists(this.filePath)
    const tempPath = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(tempPath, "wx", 0o600)
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8")
      await handle.sync().catch(() => {})
      await handle.close()
      handle = undefined
    } catch {
      await handle?.close().catch(() => {})
      await unlink(tempPath).catch(() => {})
      throw new SafeStorageError("Could not write the local credential store.")
    }
    try {
      await this.enforceFileMode(tempPath)
      await rename(tempPath, this.filePath)
      await this.enforceFileMode(this.filePath)
    } catch (error) {
      await unlink(tempPath).catch(() => {})
      if (error instanceof SafeStorageError) throw error
      throw new SafeStorageError("Could not write the local credential store.")
    }
  }

  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (await this.pathIsSymlink(directory)) {
      throw new Error("Local credential store path is not a regular file.")
    }
    if (process.platform === "win32") return
    try {
      await chmod(directory, 0o700)
    } catch {
      throw new Error("Could not restrict the credential store directory permissions.")
    }
  }

  private async enforceFileMode(path: string): Promise<void> {
    if (process.platform === "win32") return
    try {
      await chmod(path, 0o600)
    } catch {
      throw new SafeStorageError("Could not restrict the credential store file permissions.")
    }
  }

  /** 只有普通文件算存在；符号链接或其它类型一律 fail closed。 */
  private async regularFileExists(path: string): Promise<boolean> {
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false
      throw new Error("Could not inspect the local credential store.")
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Local credential store path is not a regular file.")
    }
    return true
  }

  private async pathIsSymlink(path: string): Promise<boolean> {
    try {
      return (await lstat(path)).isSymbolicLink()
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false
      throw new Error("Could not inspect the local credential store.")
    }
  }

  // -------------------------------------------------------------------------
  // Cross-process lock
  // -------------------------------------------------------------------------

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureDirectory()
    const lockPath = `${this.filePath}.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(lockPath, "wx", 0o600)
      } catch (error) {
        // 只有抢锁的 EEXIST 可以吞；`fn` 内部抛的 EEXIST 必须冒出去。
        if (!isErrno(error, "EEXIST")) throw error
      }
      if (handle !== undefined) {
        const heartbeat = setInterval(() => {
          void utimes(lockPath, new Date(), new Date()).catch(() => {})
        }, LOCK_HEARTBEAT_MS)
        heartbeat.unref?.()
        try {
          return await fn()
        } finally {
          clearInterval(heartbeat)
          await handle.close().catch(() => {})
          await unlink(lockPath).catch(() => {})
        }
      }

      // 回收崩溃进程留下的锁；活着的持有者会靠心跳把 mtime 顶新，不会被误抢。
      if (await this.pathIsSymlink(lockPath)) {
        throw new Error("Local credential store path is not a regular file.")
      }
      try {
        const info = await lstat(lockPath)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue
        throw error
      }

      if (Date.now() > deadline) throw new Error("Another credential operation is in progress.")
      await sleep(LOCK_POLL_MS)
    }
  }
}

function assertProvider(provider: string): void {
  if (!PROVIDER_ID_PATTERN.test(provider)) throw new Error("Invalid credential provider.")
}

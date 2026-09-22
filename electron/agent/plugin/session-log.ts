/**
 * 会话日志服务(Model-visible ⟺ Logged 约束)
 *
 * 强约束(参考架构文档第 4 节):**任何能到达模型请求的内容,必须可以
 * 从会话日志重建**。主循环在每次调用 LLM 前把完整模型可见集(system
 * 全文 + 历史快照 + 可见工具名)记一条 `model-request`;助手消息落定记
 * 一条 `assistant-message`。插件注入的一切模型可见输入(pre-step 段落、
 * 会话记录等)由此全部可审计、可回放。
 *
 * 服务形态:`sessionLog.append(payload)`——ts 与 sessionKey 由服务在
 * append 时统一补全(经 sessionState 服务读取),loop 只交内容。
 *
 * sink 可替换(组合层语义):测试/开发注入内存 sink;生产缺省为
 * userDataDir/session-log.jsonl(JSONL 轮转、异步批量写入；日志失败不
 * 阻断对话主流程,与 emit 语义一致)。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { userDataDir } from '../tools/tools-env'
import type { AgentContext, Plugin } from './kernel'
import type { AgentMessage, AgentPart } from '../types'

/** model-request 载荷:一次 LLM 调用的完整模型可见集 */
export interface ModelRequestPayload {
  kind: 'model-request'
  step: number
  /** 组装完成的系统提示(pre-step 瀑布结果——插件注入的段落全在) */
  system: string
  /** 历史快照(已清洗:图片 dataUrl 换占位符) */
  history: AgentMessage[]
  /** 本步可见工具名列表 */
  tools: string[]
}

/** assistant-message 载荷:落定的助手消息(下一轮模型可见) */
export interface AssistantMessagePayload {
  kind: 'assistant-message'
  message: AgentMessage
}

/** loop 交给服务的载荷(ts/sessionKey 由服务补全) */
export type SessionLogPayload = ModelRequestPayload | AssistantMessagePayload

/** 落盘条目(补全后的完整记录) */
export type SessionLogEntry = SessionLogPayload & {
  ts: number
  sessionKey: string
  schemaVersion?: number
  appVersion?: string
}

/** 日志后端(可替换:内存/文件/远端) */
export interface SessionLogSink {
  write(entry: SessionLogEntry): void
  /** 立即落盘队列；仅应用退出或测试需要 await，主回合不等待。 */
  flush?(): Promise<void>
  close?(): Promise<void>
}

export const SESSION_LOG_MAX_BYTES = 8 * 1024 * 1024
export const SESSION_LOG_MAX_QUEUE = 1000
export const SESSION_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_LOG_RESULT_MAX = 20 * 1024
const SESSION_LOG_FLUSH_MS = 250
const SESSION_LOG_CLOSE_WAIT_MS = 1000
const MEMORY_RING_MAX = 200

let diskEnabled = true
let allFileSinksClosed = false
const fileSinks = new Set<SessionLogSink>()

export function setSessionLogDiskEnabled(on: boolean): void {
  diskEnabled = on
}

export function isSessionLogDiskEnabled(): boolean {
  return diskEnabled
}

function redactValue(value: unknown, inheritedSecret = false): unknown {
  if (typeof value === 'string') {
    if (inheritedSecret) return '[REDACTED]'
    return value
      .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
      .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, inheritedSecret))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const secret = inheritedSecret || /^(apiKey|authorization|cookie|token|secret|password)$/i.test(key) || /^(env|headers)$/i.test(key)
    out[key] = redactValue(item, secret)
  }
  return out
}

/** 内存 sink(测试与开发用;entries() 按写入顺序返回) */
export function createMemorySessionLog(): SessionLogSink & { entries(): SessionLogEntry[] } {
  const list: SessionLogEntry[] = []
  return {
    write(entry) {
      list.push(entry)
    },
    entries() {
      return list.slice()
    },
  }
}

/**
 * 有界异步 JSONL sink：8MB 单文件 + 2 个历史文件，总量最多 24MB。
 * write() 只进内存队列，绝不在 Agent 主循环中使用同步文件 I/O。
 */
function rotationPaths(p: string): string[] {
  return [p, p.replace(/\.jsonl$/, '.1.jsonl'), p.replace(/\.jsonl$/, '.2.jsonl')]
}

async function pruneAgedFiles(p: string) {
  const now = Date.now()
  for (const file of rotationPaths(p)) {
    try {
      const st = await fs.promises.stat(file)
      if (now - st.mtimeMs > SESSION_LOG_MAX_AGE_MS) await fs.promises.rm(file, { force: true })
    } catch {
      // 不存在或无法 stat：忽略
    }
  }
}

const memoryRing: string[] = []

export function createFileSessionLog(filePath: () => string): SessionLogSink {
  let queue: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushing: Promise<void> | null = null
  let dropped = 0
  let closed = false

  async function rotateIfNeeded(p: string, incomingBytes: number) {
    let size = 0
    try { size = (await fs.promises.stat(p)).size } catch { /* first write */ }
    if (size + incomingBytes <= SESSION_LOG_MAX_BYTES) return
    const one = p.replace(/\.jsonl$/, '.1.jsonl')
    const two = p.replace(/\.jsonl$/, '.2.jsonl')
    await fs.promises.rm(two, { force: true })
    try { await fs.promises.rename(one, two) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    try { await fs.promises.rename(p, one) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (flushing) return flushing
    flushing = (async () => {
      while (queue.length > 0) {
        if (allFileSinksClosed || closed || !diskEnabled) {
          queue = []
          return
        }
        const batch = queue.splice(0, queue.length)
        if (dropped > 0) {
          batch.unshift(JSON.stringify({ ts: Date.now(), kind: 'log-dropped', count: dropped }) + '\n')
          dropped = 0
        }
        const p = filePath()
        const payload = batch.join('')
        try {
          await fs.promises.mkdir(path.dirname(p), { recursive: true })
          await pruneAgedFiles(p)
          await rotateIfNeeded(p, Buffer.byteLength(payload))
          if (allFileSinksClosed || closed) return
          await fs.promises.appendFile(p, payload, 'utf8')
        } catch (err) {
          console.error('[session-log] 写入失败:', (err as Error).message)
          // 本批诊断日志丢弃；不能反压或阻断对话。
        }
      }
    })().finally(() => { flushing = null })
    return flushing
  }

  function scheduleFlush() {
    if (timer || flushing) return
    timer = setTimeout(() => { void flush() }, SESSION_LOG_FLUSH_MS)
  }

  const sink: SessionLogSink = {
    write(entry) {
      if (closed || allFileSinksClosed) return
      const line = JSON.stringify(redactValue(entry)) + '\n'
      if (!diskEnabled) {
        memoryRing.push(line)
        if (memoryRing.length > MEMORY_RING_MAX) memoryRing.shift()
        return
      }
      if (queue.length >= SESSION_LOG_MAX_QUEUE) {
        dropped++
      } else {
        queue.push(line)
      }
      scheduleFlush()
    },
    flush,
    async close() {
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await Promise.race([
        flush(),
        new Promise<void>((resolve) => setTimeout(resolve, SESSION_LOG_CLOSE_WAIT_MS)),
      ])
      fileSinks.delete(sink)
    },
  }
  fileSinks.add(sink)
  return sink
}

export async function closeActiveSessionLog(): Promise<void> {
  allFileSinksClosed = true
  const jobs = [...fileSinks].map((sink) => sink.flush?.() ?? Promise.resolve())
  await Promise.race([
    Promise.allSettled(jobs),
    new Promise<void>((resolve) => setTimeout(resolve, SESSION_LOG_CLOSE_WAIT_MS)),
  ])
}

export function reopenSessionLog(): void {
  allFileSinksClosed = false
}

export async function clearSessionLogFiles(): Promise<void> {
  const p = defaultSessionLogPath()
  for (const file of rotationPaths(p)) {
    try { await fs.promises.rm(file, { force: true }) } catch { /* ignore */ }
  }
}

export function sessionLogFileBytes(userDataPath: string): { bytes: number; files: string[] } {
  const names = ['session-log.jsonl', 'session-log.1.jsonl', 'session-log.2.jsonl']
  let bytes = 0
  const files: string[] = []
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(userDataPath, name))
      bytes += st.size
      files.push(name)
    } catch {
      // missing
    }
  }
  return { bytes, files }
}

/** 默认日志文件(userDataDir/session-log.jsonl) */
export function defaultSessionLogPath(): string {
  return path.join(userDataDir(), 'session-log.jsonl')
}

/**
 * 历史清洗:图片 dataUrl(base64,可达 MB 级)换占位符——日志要可重建
 * 模型输入的**语义**,不是原文搬运二进制;其余 part 原样保留。
 */
function truncateResult(text: string): string {
  if (text.length <= SESSION_LOG_RESULT_MAX) return text
  const keep = Math.floor(SESSION_LOG_RESULT_MAX / 2) - 24
  return `${text.slice(0, keep)}\n…[truncated ${text.length} chars]…\n${text.slice(-keep)}`
}

export function sanitizeMessagesForLog(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p): AgentPart => {
      if (p.type === 'image') {
        return { type: 'image', dataUrl: `[image:${p.dataUrl.length} chars]` }
      }
      if (p.type === 'tool-result' && p.result.length > SESSION_LOG_RESULT_MAX) {
        return { ...p, result: truncateResult(p.result) }
      }
      return p
    }),
  }))
}

declare module './kernel' {
  interface ContextServices {
    /** 会话日志(Model-visible⟺Logged:模型可见输入的唯一权威记录流) */
    sessionLog: { append(payload: SessionLogPayload): void }
  }
}

/** 会话日志插件:sink 可注入(缺省文件 JSONL);依赖 sessionState 补会话键 */
export function sessionLogPlugin(sink?: SessionLogSink): Plugin {
  return {
    name: 'session-log',
    inject: ['sessionState'],
    apply(ctx: AgentContext) {
      const target = sink ?? createFileSessionLog(defaultSessionLogPath)
      const unregister = ctx.register('sessionLog', {
        append(payload: SessionLogPayload) {
          target.write({
            ts: Date.now(),
            sessionKey: ctx.get('sessionState').getSessionKey(),
            schemaVersion: 2,
            appVersion: process.env.npm_package_version ?? 'unknown',
            ...payload,
          })
        },
      })
      return () => {
        unregister()
        if (target.close) void target.close()
        else void target.flush?.()
      }
    },
  }
}

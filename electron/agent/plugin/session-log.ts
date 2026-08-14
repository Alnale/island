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
 * userDataDir/session-log.jsonl(JSONL 追加,写入失败大声吞掉——日志
 * 不阻断对话主流程,与 emit 语义一致)。
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
export type SessionLogEntry = SessionLogPayload & { ts: number; sessionKey: string }

/** 日志后端(可替换:内存/文件/远端) */
export interface SessionLogSink {
  write(entry: SessionLogEntry): void
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

/** 文件 sink(JSONL 逐行追加;best-effort——写失败不阻断对话) */
export function createFileSessionLog(filePath: () => string): SessionLogSink {
  return {
    write(entry) {
      try {
        const p = filePath()
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8')
      } catch (err) {
        console.error('[session-log] 写入失败:', (err as Error).message)
      }
    },
  }
}

/** 默认日志文件(userDataDir/session-log.jsonl) */
export function defaultSessionLogPath(): string {
  return path.join(userDataDir(), 'session-log.jsonl')
}

/**
 * 历史清洗:图片 dataUrl(base64,可达 MB 级)换占位符——日志要可重建
 * 模型输入的**语义**,不是原文搬运二进制;其余 part 原样保留。
 */
export function sanitizeMessagesForLog(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p): AgentPart => {
      if (p.type === 'image') {
        return { type: 'image', dataUrl: `[image:${p.dataUrl.length} chars]` }
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
      return ctx.register('sessionLog', {
        append(payload: SessionLogPayload) {
          target.write({
            ts: Date.now(),
            sessionKey: ctx.get('sessionState').getSessionKey(),
            ...payload,
          })
        },
      })
    },
  }
}

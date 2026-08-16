/**
 * NapCat QQ 机器人桥(2026-08-14 全面优化版)——OneBot 11 WS 客户端实现
 * (八期自 napcat.ts 拆出;领域入口与工具工厂见 napcat.ts)
 *
 * OneBot 11 协议 WebSocket 客户端,零第三方依赖(全局 WebSocket,Node 22+):
 * - 正向 WS 连接 NapCat(默认 ws://127.0.0.1:3001),断线指数退避重连+熔断;
 * - 收到**私聊消息**事件 → 回调 onMessage(QQ 号 + 文本)——main.cjs 转发
 *   渲染端作为用户消息进入对话(同步上下文),LLM 回复后经 sendToQQ 发回
 *    QQ(用户要求"对话窗口和 QQ 自己回复我");
 * - 收到**群消息**事件 → 回调 onGroupMessage(群号 + QQ + 文本)——main.cjs
 *   自主判断是否接话(防刷屏),接话进对话,回复发回群;
 * - 长期记忆自动生效(QQ 对话走主引擎,系统提示含记忆块);
 * - 消息缓存(可配置,默认50条)供 napcat 工具查询;
 * - 去重持久化(重启不丢),文件写队列防并发,危险操作确认门。
 *
 * 协议要点(OneBot 11):
 * - 事件:{"post_type":"message","message_type":"private|group","user_id":...,
 *   "group_id":...,"message":"文本","raw_message":"文本","message_id":...,"time":...}
 *   (message 可能是 string 或段数组,统一转文本;@ 段标注);
 * - 动作:{"action":"send_private_msg|send_group_msg","params":{...},"echo":".."},
 *   响应 {"status":"ok","retcode":0,"data":{"message_id":..}};
 * - 心跳:服务端发 heartbeat 事件,客户端无需响应。
 */

import { existsSync, promises as fs } from 'node:fs'
import { randomInt } from 'node:crypto'
import path from 'node:path'
import type { AgentConfig } from '../types'
import { masterQQ } from '../privacy'
import { createWsSocket, type WsConn } from './wsclient'
import { stripFingerprintMarks } from './napcat-session'
import {
  extractImageRefs,
  gtkFromCookie,
  stripMasterNarration,
  stripThinkingPreamble,
  stripToolNarration,
} from './napcat-text'
import {
  cqAtMe,
  napcatMessageImages,
  napcatMessageText,
  type NapcatGroupMessage,
  type NapcatImage,
  type NapcatMessage,
  type NapcatSentMessage,
} from './napcat-message'
import {
  appendNapcatChat,
  DEFAULT_CHATS_SIZE,
  loadNapcatChats,
  loadNapcatContacts,
  loadNapcatPersonas,
  loadSeen,
  pruneSeen,
  saveNapcatContacts,
  saveNapcatPersona,
  seenAdd,
  seenHas,
  userDataDir,
  type NapcatChatRecord,
  type NapcatPersona,
} from './napcat-store'

// ---- 默认配置常量(可被 agent 配置覆盖) ----
const DEFAULT_WS_URL = 'ws://127.0.0.1:3001'
const DEFAULT_CACHE_SIZE = 50
const DEFAULT_SENT_SIZE = 50
const ACTION_TIMEOUT_MS = 15000
// 文件/视频上传超时(2026-08-14 修复):upload_private_file/upload_group_file
// 大视频上传到 QQ 动辄几十秒,原统一 15s 会先触发超时——QQ 实际收到了
// 视频但工具报"超时失败",LLM 误报没发成功;延长到 180s
const FILE_UPLOAD_TIMEOUT_MS = 180_000
const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB(原50MB过大)
const MAX_RECONNECT_FAILS = 10 // 连续失败N次后熔断
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10000 // 图片下载超时
const RECONNECT_CAP_MS = 30000
const SEEN_CLEANUP_INTERVAL_MS = 10 * 60 * 1000 // 10分钟清理一次过期ID
const QZONE_RATE_LIMIT_MS = 1000 // QQ空间接口最小间隔


/** 连接状态 */
export interface NapcatStatus {
  connected: boolean
  url: string
  lastError: string
  receivedCount: number
  repliedCount: number
  allowed?: string[]
  allowedGroups?: string[]
  circuitBroken?: boolean
}

/** 通知事件(撤回/好友请求/群邀请) */
export interface NapcatNotice {
  type: 'group_recall' | 'friend_recall' | 'friend_request' | 'group_request' | 'group_increase' | 'group_decrease'
  /** 相关QQ号(操作者/申请人) */
  userId?: string
  /** 群号 */
  groupId?: string
  /** 被操作者(被踢/加入) */
  targetId?: string
  /** 请求flag(需通过操作接受/拒绝) */
  flag?: string
  /** 附加信息(验证消息/理由) */
  comment?: string
}

/** 主进程注入的依赖 */
export interface NapcatDeps {
  getConfig(): AgentConfig
  onMessage(msg: NapcatMessage): void
  onGroupMessage(msg: NapcatGroupMessage): void
  notify?(title: string, body: string): void
  listSessions?(): Array<{ key: string; title: string; kind: 'private' | 'group'; muted: boolean }>
  muteSession?(key: string, muted: boolean): void
  bindSession?(key: string): void
  /** 监听增删(2026-08-14 manage_sessions 工具):写 napcatAllowed /
   * napcatAllowedGroups 配置 → applyAgentConfigPatch 自动广播会话种子,
   * 渲染端会话面板立即建条目 */
  watchSession?(kind: 'private' | 'group', id: string): void
  unwatchSession?(kind: 'private' | 'group', id: string): void
  onSent?(msg: { type: 'private' | 'group'; target: string; text: string; images?: string[] }): void
  /** 错误上报(不再静默catch——发送失败/API错误经此回调通知主进程) */
  onError?(message: string): void
  /** 通知事件(撤回/好友请求等) */
  onNotice?(notice: NapcatNotice): void
}

// ---- 联系人档案 ----
export interface NapcatContact {
  qq: string
  name?: string
  info?: string
  source?: 'private' | 'group'
  updatedAt: number
}


// ---- 会话键/回复标记/防重发/轮次指纹:纯函数簇已拆至 napcat-session.ts,此处 barrel 兼容 re-export ----
export * from './napcat-session'




// ---- g_tk/出站文本清洗:纯函数簇已拆至 napcat-text.ts,此处 barrel 兼容 re-export ----
export * from './napcat-text'

// ---- NapCat 客户端 ----
export interface NapcatClient {
  start(): void
  stop(): void
  status(): NapcatStatus
  downloadImages(images?: NapcatImage[]): Promise<string[]>
  appendChat(record: Omit<NapcatChatRecord, 'time'> & { time?: number }): void
  sendToQQ(qq: string, text: string, opts?: { image?: string; file?: string }): Promise<string>
  sendToGroup(groupId: string, text: string, filePath?: string, image?: string): Promise<string>
  recallMessage(messageId: string): Promise<void>
  getRecentMessages(): NapcatMessage[]
  getSentMessages(): NapcatSentMessage[]
  getContacts(): Promise<Record<string, NapcatContact>>
  updateContact(patch: { qq: string; name?: string; info?: string; source?: 'private' | 'group' }): Promise<NapcatContact>
  getChats(): Promise<NapcatChatRecord[]>
  getPersonas(): Promise<Record<string, NapcatPersona>>
  setPersona(scope: string, persona: string): Promise<NapcatPersona | null>
  mergeContactNames(entries: Array<{ qq: string; name?: string; source?: 'private' | 'group' }>): Promise<void>
  getGroupMembers(groupId: string): Promise<Array<{ user_id: string; nickname?: string; card?: string }>>
  getFriendList(): Promise<Array<{ user_id: string; nickname?: string; remark?: string }>>
  getStrangerInfo(qq: string): Promise<{ nickname?: string; age?: number; sex?: string }>
  getGroupInfo(groupId: string): Promise<{ groupName?: string; memberCount?: number }>
  setGroupBan(groupId: string, qq: string, durationSec: number): Promise<void>
  setGroupKick(groupId: string, qq: string): Promise<void>
  setGroupWholeBan(groupId: string, enable: boolean): Promise<void>
  getQzoneFeeds(qq: string, num: number): Promise<Array<{ tid: string; content: string; createTime: number; picnum: number; commentnum: number; likenum: number }>>
  markReplied(messageId: string): void
  getBotQQ(): string
  /** 会话面板管理(2026-08-14 manage_sessions 工具):主进程经 NapcatDeps
   * 注入后透传,未注入时工具侧拿到的都是空实现/空列表 */
  listSessions?(): Array<{ key: string; title: string; kind: 'private' | 'group'; muted: boolean }>
  muteSession?(key: string, muted: boolean): void
  bindSession?(key: string): void
  watchSession?(kind: 'private' | 'group', id: string): void
  unwatchSession?(kind: 'private' | 'group', id: string): void
}

export function createNapcatClient(deps: NapcatDeps): NapcatClient {
  let ws: WsConn | null = null
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let seenCleanupTimer: ReturnType<typeof setInterval> | null = null
  let reconnectDelay = 1000
  let reconnectFails = 0
  let circuitBroken = false
  let lastError = ''
  let receivedCount = 0
  let repliedCount = 0
  let lastQzoneCall = 0
  const messages: NapcatMessage[] = []
  const sentMessages: NapcatSentMessage[] = []
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let echoSeq = 0

  // ---- 发送频率限制(2026-08-14 防刷屏/QQ客户端卡死) ----
  const MIN_SEND_INTERVAL_MS = 800 // 同一目标最小发送间隔
  const MAX_SENDS_PER_MINUTE = 25 // 全局每分钟最大发送数
  const sendTimestamps: number[] = [] // 滑动窗口记录发送时间
  const lastSentAt = new Map<string, number>() // target -> 上次发送时间戳
  function checkRateLimit(target: string): { ok: boolean; reason?: string } {
    const now = Date.now()
    // 清理1分钟前的记录
    while (sendTimestamps.length > 0 && now - sendTimestamps[0] > 60000) sendTimestamps.shift()
    if (sendTimestamps.length >= MAX_SENDS_PER_MINUTE) {
      return { ok: false, reason: `发送过于频繁(${MAX_SENDS_PER_MINUTE}条/分钟),请稍后再试` }
    }
    const last = lastSentAt.get(target)
    if (last && now - last < MIN_SEND_INTERVAL_MS) {
      return { ok: false, reason: '发送间隔太短,请稍候' }
    }
    return { ok: true }
  }
  /** 等待可发送槽位(2026-08-14,修复"偶现没发出去"):同目标 800ms 间隔
   * 限流改为**等待重试**而非硬失败——对方连发两条消息(QQ 聊天常态)时,
   * 第二条自主回复等待到间隔满足再发,不再被限流抛错吞掉;仅 25 条/分钟
   * 全局硬上限(防 LLM 工具循环刷屏)与等待超时仍抛错 */
  const SEND_RETRY_WAIT_MS = 200
  const SEND_RETRY_MAX_WAIT_MS = 3000
  async function waitSendSlot(target: string): Promise<void> {
    const deadline = Date.now() + SEND_RETRY_MAX_WAIT_MS
    for (;;) {
      const rate = checkRateLimit(target)
      if (rate.ok) return
      if (Date.now() >= deadline) throw new Error(rate.reason || '发送限流')
      await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_WAIT_MS))
    }
  }
  function recordSend(target: string): void {
    const now = Date.now()
    sendTimestamps.push(now)
    lastSentAt.set(target, now)
  }

  // 加载去重数据
  void loadSeen()

  const cfg = () => deps.getConfig()
  const botQQ = () => String(cfg().napcatBotQQ ?? '')
  const cacheSize = () => DEFAULT_CACHE_SIZE
  const sentSize = () => DEFAULT_SENT_SIZE
  const chatsSize = () => DEFAULT_CHATS_SIZE

  function recordSent(msg: Omit<NapcatSentMessage, 'time'> & { time?: number }): void {
    if (!msg.messageId) return
    sentMessages.push({ ...msg, time: msg.time ?? Math.floor(Date.now() / 1000) })
    const limit = sentSize()
    while (sentMessages.length > limit) sentMessages.shift()
  }

  function reportError(message: string): void {
    lastError = message
    deps.onError?.(message)
    console.error('[napcat]', message)
  }

  function extractText(msg: unknown): string {
    return napcatMessageText(msg, botQQ())
  }

  function connect() {
    if (stopped || circuitBroken) return
    const url = cfg().napcatWsUrl?.trim() || DEFAULT_WS_URL
    try {
      lastError = ''
      const socket = createWsSocket(url, {
        onOpen: () => {
          reconnectDelay = 1000
          reconnectFails = 0
          circuitBroken = false
          deps.notify?.('NapCat 已连接', `QQ 消息桥就绪(${url})`)
          // 启动定期清理过期seen
          if (!seenCleanupTimer) {
            seenCleanupTimer = setInterval(pruneSeen, SEEN_CLEANUP_INTERVAL_MS)
          }
        },
        onMessage: (text) => {
          let data: unknown
          try {
            data = JSON.parse(String(text))
          } catch {
            return
          }
          const obj = data as Record<string, unknown>
          // 动作响应
          if (typeof obj.echo === 'string' && pending.has(obj.echo)) {
            const p = pending.get(obj.echo)!
            pending.delete(obj.echo)
            clearTimeout(p.timer)
            if (obj.status === 'failed' || obj.retcode !== 0) {
              const msg = String(obj.msg ?? obj.wording ?? '动作执行失败')
              p.reject(new Error(`NapCat ${msg}(retcode=${obj.retcode ?? '?'})`))
            } else {
              p.resolve(obj)
            }
            return
          }
          // 心跳(不处理)
          if (obj.post_type === 'meta_event' && obj.meta_event_type === 'heartbeat') return
          if (obj.post_type === 'meta_event' && obj.meta_event_type === 'lifecycle') return

          // 通知事件(撤回/好友请求等)
          if (obj.post_type === 'notice') {
            handleNotice(obj)
            return
          }
          if (obj.post_type === 'request') {
            handleRequest(obj)
            return
          }

          // 私聊消息
          if (obj.post_type === 'message' && obj.message_type === 'private') {
            const qq = String(obj.user_id ?? '')
            if (!qq) return
            if (qq === botQQ()) return // 跳过自己
            const messageId = String(obj.message_id ?? '')
            // 去重键区分私聊/群聊前缀(2026-08-14:不同会话message_id可能同值,分开去重)
            const dedupKey = messageId ? `private:${messageId}` : ''
            if (dedupKey && seenHas(dedupKey)) return
            if (dedupKey) seenAdd(dedupKey)
            const raw = obj.message ?? obj.raw_message
            const text = extractText(raw)
            const images = napcatMessageImages(raw)
            const msg: NapcatMessage = {
              qq,
              text,
              messageId,
              time: Number(obj.time ?? Math.floor(Date.now() / 1000)),
              images,
            }
            messages.push(msg)
            const limit = cacheSize()
            while (messages.length > limit) messages.shift()
            receivedCount++
            if (text) {
              deps.notify?.(`QQ 消息(${qq})`, text.length > 50 ? text.slice(0, 50) + '…' : text)
            }
            try { deps.onMessage(msg) } catch (e) { reportError(`onMessage处理失败:${(e as Error).message}`) }
          }
          // 群消息
          if (obj.post_type === 'message' && obj.message_type === 'group') {
            const groupId = String(obj.group_id ?? '')
            const qq = String(obj.user_id ?? '')
            if (!groupId || !qq) return
            if (qq === botQQ()) return // 跳过自己
            const groups = cfg().napcatAllowedGroups ?? []
            if (groups.length > 0 && !groups.includes(groupId)) return
            const messageId = String(obj.message_id ?? '')
            // 去重键区分私聊/群聊前缀(2026-08-14:不同会话message_id可能同值,分开去重)
            const dedupKey = messageId ? `group:${messageId}` : ''
            if (dedupKey && seenHas(dedupKey)) return
            if (dedupKey) seenAdd(dedupKey)
            const raw = obj.message ?? obj.raw_message
            const text = extractText(raw)
            const images = napcatMessageImages(raw)
            // @ 机器人检测:段数组 + CQ码字符串
            const bqq = botQQ()
            const atMe =
              (Array.isArray(raw)
                ? raw.some((seg: { type?: string; data?: Record<string, unknown> }) =>
                    seg?.type === 'at' && String(seg.data?.qq ?? '') === bqq)
                : false) || cqAtMe(raw, bqq)
            const msg: NapcatGroupMessage = {
              groupId,
              qq,
              text,
              atMe,
              messageId,
              time: Number(obj.time ?? Math.floor(Date.now() / 1000)),
              images,
            }
            receivedCount++
            if (text) {
              deps.notify?.(
                `${msg.atMe ? '@鲸鱼娘 ' : ''}群消息(QQ ${qq})`,
                text.length > 50 ? text.slice(0, 50) + '…' : text,
              )
            }
            try { deps.onGroupMessage(msg) } catch (e) { reportError(`onGroupMessage处理失败:${(e as Error).message}`) }
          }
        },
        onError: (message) => {
          lastError = message || '连接错误(请确认 NapCat 已启动且 WS 端口开放)'
        },
        onClose: () => {
          if (ws === socket) ws = null
          reconnectFails++
          if (reconnectFails >= MAX_RECONNECT_FAILS) {
            circuitBroken = true
            deps.notify?.('NapCat 连接失败', `连续${MAX_RECONNECT_FAILS}次连接失败，已停止重连。请确认NapCat已启动后重启应用或重新连接。`)
            reportError(`NapCat连续${MAX_RECONNECT_FAILS}次连接失败，已熔断`)
            return
          }
          scheduleReconnect()
        },
      })
      ws = socket
    } catch (e) {
      lastError = (e as Error).message
      reconnectFails++
      if (reconnectFails >= MAX_RECONNECT_FAILS) {
        circuitBroken = true
        deps.notify?.('NapCat 连接失败', `连续${MAX_RECONNECT_FAILS}次连接失败，已停止重连。`)
        return
      }
      scheduleReconnect()
    }
  }

  function handleNotice(obj: Record<string, unknown>) {
    const noticeType = String(obj.notice_type ?? '')
    // OneBot v11字段语义(2026-08-14 修复字段颠倒):
    // - user_id: 事件主体(被踢的人/加入的人/离开的人/消息发送者)
    // - operator_id: 操作者(踢人的管理员/邀请人/撤回操作者;主动退群时=user_id)
    // 接口定义:userId=操作者,targetId=被操作者
    const subjectId = obj.user_id !== undefined ? String(obj.user_id) : undefined
    const operatorId = obj.operator_id !== undefined ? String(obj.operator_id) : undefined
    const groupId = obj.group_id !== undefined ? String(obj.group_id) : undefined
    const msg: NapcatNotice = {
      type: noticeType as NapcatNotice['type'],
      userId: operatorId ?? subjectId, // 操作者优先;无operator时主体即操作者
      groupId,
      targetId: operatorId ? subjectId : undefined, // 有操作者时主体是被操作目标
    }
    if (noticeType === 'group_recall' || noticeType === 'friend_recall') {
      // 撤回事件:user_id=消息发送者,operator_id=撤回者(可能相同)
      msg.type = noticeType
      msg.userId = operatorId ?? subjectId
      msg.targetId = operatorId && operatorId !== subjectId ? subjectId : undefined
    } else if (noticeType === 'group_increase') {
      msg.type = 'group_increase'
      // 加入事件:user_id=加入者,operator_id=邀请者/同意者
      msg.targetId = subjectId
      msg.userId = operatorId ?? subjectId
    } else if (noticeType === 'group_decrease') {
      msg.type = 'group_decrease'
      // 离开事件:user_id=离开者,operator_id=踢人者(主动退群时operator=user)
      msg.targetId = subjectId
      msg.userId = operatorId ?? subjectId
    } else {
      return // 其他notice暂不处理
    }
    deps.onNotice?.(msg)
  }

  function handleRequest(obj: Record<string, unknown>) {
    const reqType = String(obj.request_type ?? '')
    const flag = String(obj.flag ?? '')
    const comment = obj.comment !== undefined ? String(obj.comment) : undefined
    const userId = obj.user_id !== undefined ? String(obj.user_id) : undefined
    const groupId = obj.group_id !== undefined ? String(obj.group_id) : undefined
    if (reqType === 'friend') {
      deps.onNotice?.({ type: 'friend_request', userId, flag, comment })
      deps.notify?.('QQ好友请求', `QQ ${userId} 请求加好友${comment ? `:${comment}` : ''}`)
    } else if (reqType === 'group' && (String(obj.sub_type ?? '') === 'add' || String(obj.sub_type ?? '') === 'invite')) {
      deps.onNotice?.({ type: 'group_request', userId, groupId, flag, comment })
      deps.notify?.('QQ群请求', `QQ ${userId} 请求加入/邀请加入群 ${groupId}${comment ? `:${comment}` : ''}`)
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer || circuitBroken) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_CAP_MS)
  }

  function callAction<T = unknown>(action: string, params: Record<string, unknown>, timeoutMs: number = ACTION_TIMEOUT_MS): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!ws || !ws.open) {
        reject(new Error('NapCat 未连接(请确认 NapCat 已启动)'))
        return
      }
      const echo = `napcat-${++echoSeq}-${randomInt(1 << 24).toString(36)}`
      const timer = setTimeout(() => {
        pending.delete(echo)
        reject(new Error(`NapCat 动作 ${action} 超时(${Math.round(timeoutMs / 1000)}s)`))
      }, timeoutMs)
      pending.set(echo, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      try {
        ws.send(JSON.stringify({ action, params, echo }))
      } catch (e) {
        clearTimeout(timer)
        pending.delete(echo)
        reject(new Error(`NapCat 发送失败:${(e as Error).message}`))
      }
    })
  }

  const mediaDir = () => path.join(userDataDir(), 'napcat-media')

  async function downloadImage(img: NapcatImage): Promise<string | null> {
    try {
      await fs.mkdir(mediaDir(), { recursive: true })
      let localPath = ''
      if (img.file) {
        try {
          const res = await callAction<{ data?: { file?: string } }>('get_image', { file: img.file }) as {
            status?: string
            retcode?: number
            data?: { file?: string }
          }
          const p = res?.data?.file
          if (p && existsSync(p)) localPath = p
        } catch {
          // get_image失败走url下载
        }
      }
      if (!localPath && img.file && existsSync(img.file)) localPath = img.file
      if (!localPath && img.url) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS)
          const resp = await fetch(img.url, { signal: controller.signal })
          clearTimeout(timer)
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer())
            if (buf.length > MAX_IMAGE_SIZE) {
              reportError(`图片过大(${Math.round(buf.length / 1024 / 1024)}MB>20MB)，跳过下载`)
              return null
            }
            const ct = String(resp.headers.get('content-type') ?? '')
            const ext = /image\/(png|jpe?g|gif|webp|bmp)/.exec(ct)?.[1]?.replace('jpeg', 'jpg') ?? 'jpg'
            localPath = path.join(mediaDir(), `${Date.now()}-${randomInt(1 << 24).toString(36)}.${ext}`)
            await fs.writeFile(localPath, buf)
            return localPath
          }
        } catch (e) {
          const msg = (e as Error).message
          if (msg?.includes('abort')) {
            reportError(`图片下载超时(>${IMAGE_DOWNLOAD_TIMEOUT_MS / 1000}s)`)
          } else {
            reportError(`图片下载失败:${msg}`)
          }
          return null
        }
      }
      if (!localPath) return null
      const ext = path.extname(localPath) || '.img'
      const dest = path.join(mediaDir(), `${Date.now()}-${randomInt(1 << 24).toString(36)}${ext}`)
      await fs.copyFile(localPath, dest)
      return dest
    } catch (e) {
      reportError(`图片处理失败:${(e as Error).message}`)
      return null
    }
  }

  function prepareOutgoingText(text: string, isMaster: boolean): string {
    let t = text
    if (!isMaster) {
      // 非主人发送边界统一清洗(2026-08-17:内部独白判定不在此用正则——
      // 交由 main.cjs 的审核 Sub Agent 判断,见 handleEngineMessageForNapcat)
      t = stripThinkingPreamble(stripMasterNarration(stripToolNarration(stripFingerprintMarks(t))))
    } else {
      t = stripFingerprintMarks(t)
    }
    return t
  }

  return {
    getBotQQ: botQQ,
    async downloadImages(images?: NapcatImage[]): Promise<string[]> {
      if (!images || images.length === 0) return []
      const out: string[] = []
      for (const img of images) {
        const p = await downloadImage(img)
        if (p) out.push(p)
      }
      return out
    },
    appendChat(record: Omit<NapcatChatRecord, 'time'> & { time?: number }) {
      appendNapcatChat({
        ...record,
        time: record.time ?? Math.floor(Date.now() / 1000),
      }, chatsSize())
    },
    start() {
      stopped = false
      circuitBroken = false
      reconnectFails = 0
      connect()
    },
    stop() {
      stopped = true
      circuitBroken = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (seenCleanupTimer) { clearInterval(seenCleanupTimer); seenCleanupTimer = null }
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.reject(new Error('NapCat已停止'))
      }
      pending.clear()
      try { ws?.close() } catch { /* 已关闭 */ }
      ws = null
    },
    async sendToQQ(qq: string, text: string, opts?: { image?: string; file?: string }): Promise<string> {
      const isMaster = qq === masterQQ()
      const cleaned = prepareOutgoingText(text, isMaster)
      const paramImage = typeof opts?.image === 'string' && opts.image.trim() ? opts.image.trim() : ''
      const file = typeof opts?.file === 'string' && opts.file.trim() ? opts.file.trim() : ''
      const { text: cleanText, images: refImages } = extractImageRefs(cleaned)
      if (!cleanText.trim() && refImages.length === 0 && !paramImage && !file) return ''
      if (file) {
        if (!existsSync(file)) throw new Error(`文件不存在:${file}(send 的 file 需要本地绝对路径)`)
        try {
          const up = await callAction<{ status?: string; retcode?: number }>('upload_private_file', {
            user_id: qq, file, name: path.basename(file),
          }, FILE_UPLOAD_TIMEOUT_MS) as { status?: string; retcode?: number }
          if (up?.status !== 'ok' && up?.retcode !== 0) throw new Error(`文件上传失败(${up?.retcode ?? '未知'})`)
        } catch (e) {
          reportError(`私聊文件上传失败:${(e as Error).message}`)
          throw e
        }
      }
      if (paramImage && !/^https?:|^data:image\//.test(paramImage) && !existsSync(paramImage)) {
        throw new Error(`图片不存在:${paramImage}(image 需要本地绝对路径或 http(s) 链接)`)
      }
      const seen = new Set<string>()
      const finalImages: string[] = []
      const backToText: string[] = []
      for (const p of [paramImage, ...refImages].filter(Boolean)) {
        if (seen.has(p)) continue
        seen.add(p)
        if (/^[A-Za-z]:[\\/]/.test(p) && !existsSync(p)) backToText.push(p)
        else finalImages.push(p)
      }
      const finalText = [cleanText, ...backToText].join(' ').trim()
      // 发送频率限制检查(2026-08-14 防刷屏;等待重试,见 waitSendSlot)
      await waitSendSlot(`private:${qq}`)
      let message: unknown = finalText
      if (finalImages.length > 0) {
        const segs: unknown[] = []
        if (finalText) segs.push({ type: 'text', data: { text: finalText } })
        for (const img of finalImages) segs.push({ type: 'image', data: { file: img } })
        message = segs
      }
      try {
        const res = await callAction<{ status?: string; data?: { message_id?: number } }>('send_private_msg', {
          user_id: qq, message,
        }) as { status?: string; retcode?: number; data?: { message_id?: number } }
        if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`QQ 发送失败(${res?.retcode ?? '未知'})`)
        recordSend(`private:${qq}`)
        const id = String(res?.data?.message_id ?? '')
        recordSent({ messageId: id, type: 'private', target: qq, text: finalText.slice(0, 100) || '(图片/文件)' })
        repliedCount++
        deps.onSent?.({ type: 'private', target: qq, text: finalText, images: finalImages })
        return id
      } catch (e) {
        reportError(`私聊消息发送失败(QQ ${qq}):${(e as Error).message}`)
        throw e
      }
    },
    async getContacts(): Promise<Record<string, NapcatContact>> {
      return loadNapcatContacts()
    },
    async getChats(): Promise<NapcatChatRecord[]> {
      return loadNapcatChats(chatsSize())
    },
    async getPersonas(): Promise<Record<string, NapcatPersona>> {
      return loadNapcatPersonas()
    },
    async setPersona(scope: string, persona: string): Promise<NapcatPersona | null> {
      return saveNapcatPersona(scope, persona)
    },
    async updateContact(patch: { qq: string; name?: string; info?: string; source?: 'private' | 'group' }): Promise<NapcatContact> {
      const contacts = await loadNapcatContacts()
      const prev = contacts[patch.qq] ?? { qq: patch.qq, updatedAt: 0 }
      const next: NapcatContact = {
        qq: patch.qq,
        name: patch.name !== undefined ? patch.name.slice(0, 50) : prev.name,
        info: patch.info !== undefined ? patch.info.slice(0, 500) : prev.info,
        source: patch.source ?? prev.source ?? 'private',
        updatedAt: Math.floor(Date.now() / 1000),
      }
      contacts[patch.qq] = next
      await saveNapcatContacts(contacts)
      return next
    },
    async sendToGroup(groupId: string, text: string, filePath?: string, image?: string): Promise<string> {
      const cleaned = prepareOutgoingText(text, false)
      const paramImage = typeof image === 'string' && image.trim() ? image.trim() : ''
      const file = typeof filePath === 'string' && filePath.trim() ? filePath.trim() : ''
      const { text: cleanText, images: refImages } = extractImageRefs(cleaned)
      if (!cleanText.trim() && refImages.length === 0 && !file && !paramImage) return ''
      if (file) {
        if (!existsSync(file)) throw new Error(`文件不存在:${file}(send_group 的 file 需要本地绝对路径)`)
        try {
          const up = await callAction<{ status?: string; retcode?: number }>('upload_group_file', {
            group_id: groupId, file, name: path.basename(file),
          }, FILE_UPLOAD_TIMEOUT_MS) as { status?: string; retcode?: number }
          if (up?.status !== 'ok' && up?.retcode !== 0) throw new Error(`群文件上传失败(${up?.retcode ?? '未知'})`)
        } catch (e) {
          reportError(`群文件上传失败(群 ${groupId}):${(e as Error).message}`)
          throw e
        }
      }
      if (paramImage && !/^https?:|^data:image\//.test(paramImage) && !existsSync(paramImage)) {
        throw new Error(`图片不存在:${paramImage}(send_group 的 image 需要本地绝对路径或 http(s) 链接)`)
      }
      const seen = new Set<string>()
      const finalImages: string[] = []
      const backToText: string[] = []
      for (const p of [paramImage, ...refImages].filter(Boolean)) {
        if (seen.has(p)) continue
        seen.add(p)
        if (/^[A-Za-z]:[\\/]/.test(p) && !existsSync(p)) backToText.push(p)
        else finalImages.push(p)
      }
      const finalText = [cleanText, ...backToText].join(' ').trim()
      // 发送频率限制检查(2026-08-14 防刷屏;等待重试,见 waitSendSlot)
      const rateKey = `group:${groupId}`
      await waitSendSlot(rateKey)
      let message: unknown = finalText
      if (finalImages.length > 0) {
        const segs: unknown[] = []
        if (finalText) segs.push({ type: 'text', data: { text: finalText } })
        for (const img of finalImages) segs.push({ type: 'image', data: { file: img } })
        message = segs
      }
      let messageId = ''
      if (finalText.trim() || finalImages.length > 0) {
        try {
          const res = await callAction<{ status?: string; data?: { message_id?: number } }>('send_group_msg', {
            group_id: groupId, message,
          }) as { status?: string; retcode?: number; data?: { message_id?: number } }
          if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`群发送失败(${res?.retcode ?? '未知'})`)
          recordSend(rateKey)
          messageId = String(res?.data?.message_id ?? '')
        } catch (e) {
          reportError(`群消息发送失败(群 ${groupId}):${(e as Error).message}`)
          throw e
        }
      }
      recordSent({ messageId, type: 'group', target: groupId, text: finalText.slice(0, 100) || '(图片/文件)' })
      deps.onSent?.({ type: 'group', target: groupId, text: finalText, images: finalImages })
      repliedCount++
      return messageId
    },
    async recallMessage(messageId: string): Promise<void> {
      try {
        const res = await callAction<{ status?: string; retcode?: number }>('delete_msg', { message_id: messageId }) as {
          status?: string; retcode?: number
        }
        if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`撤回失败(${res?.retcode ?? '未知'})`)
      } catch (e) {
        reportError(`消息撤回失败:${(e as Error).message}`)
        throw e
      }
    },
    async getGroupMembers(groupId: string): Promise<Array<{ user_id: string; nickname?: string; card?: string }>> {
      const res = await callAction<{ data?: Array<Record<string, unknown>> }>('get_group_member_list', { group_id: groupId }) as {
        status?: string; retcode?: number; data?: Array<Record<string, unknown>>
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`群成员列表获取失败(${res?.retcode ?? '未知'})`)
      return (res?.data ?? []).map((m) => ({
        user_id: String(m.user_id ?? ''),
        nickname: m.nickname !== undefined ? String(m.nickname) : undefined,
        card: m.card !== undefined ? String(m.card) : undefined,
      }))
    },
    async getFriendList(): Promise<Array<{ user_id: string; nickname?: string; remark?: string }>> {
      const res = await callAction<{ data?: Array<Record<string, unknown>> }>('get_friend_list', {}) as {
        status?: string; retcode?: number; data?: Array<Record<string, unknown>>
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`好友列表获取失败(${res?.retcode ?? '未知'})`)
      return (res?.data ?? []).map((m) => ({
        user_id: String(m.user_id ?? ''),
        nickname: m.nickname !== undefined ? String(m.nickname) : undefined,
        remark: m.remark !== undefined ? String(m.remark) : undefined,
      }))
    },
    async getStrangerInfo(qq: string): Promise<{ nickname?: string; age?: number; sex?: string }> {
      const res = await callAction<{ data?: Record<string, unknown> }>('get_stranger_info', { user_id: qq }) as {
        status?: string; retcode?: number; data?: Record<string, unknown>
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`资料查询失败(${res?.retcode ?? '未知'})`)
      const d = res?.data ?? {}
      return {
        nickname: d.nickname !== undefined ? String(d.nickname) : undefined,
        age: typeof d.age === 'number' ? d.age : undefined,
        sex: d.sex !== undefined ? String(d.sex) : undefined,
      }
    },
    async getGroupInfo(groupId: string): Promise<{ groupName?: string; memberCount?: number }> {
      const res = await callAction<{ data?: Record<string, unknown> }>('get_group_info', { group_id: groupId }) as {
        status?: string; retcode?: number; data?: Record<string, unknown>
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`群信息获取失败(${res?.retcode ?? '未知'})`)
      const d = res?.data ?? {}
      return {
        groupName: d.group_name !== undefined ? String(d.group_name) : undefined,
        memberCount: typeof d.member_count === 'number' ? d.member_count : undefined,
      }
    },
    async getQzoneFeeds(
      qq: string,
      num: number,
    ): Promise<Array<{ tid: string; content: string; createTime: number; picnum: number; commentnum: number; likenum: number }>> {
      // 简单频率限制
      const now = Date.now()
      if (now - lastQzoneCall < QZONE_RATE_LIMIT_MS) {
        await new Promise((r) => setTimeout(r, QZONE_RATE_LIMIT_MS - (now - lastQzoneCall)))
      }
      lastQzoneCall = Date.now()
      const res = await callAction<{ cookies?: string; bkn?: string }>('get_cookies', { domain: 'qzone.qq.com' }) as {
        status?: string; retcode?: number; cookies?: string; bkn?: string
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`QQ 空间 Cookie 获取失败(${res?.retcode ?? '未知'})`)
      const cookies = String(res?.cookies ?? '')
      if (!cookies) throw new Error('QQ 空间 Cookie 为空(NapCat版本可能过旧)')
      const gtk = String(res?.bkn ?? '') || gtkFromCookie(cookies)
      if (!gtk) throw new Error('无法计算 g_tk')
      const url =
        `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6` +
        `?uin=${encodeURIComponent(qq)}&ftype=0&sort=0&pos=0&num=${Math.min(Math.max(num, 1), 20)}&replynum=3&g_tk=${encodeURIComponent(gtk)}`
      let resp: Response
      try {
        resp = await fetch(url, {
          headers: {
            Cookie: cookies,
            Referer: `https://user.qzone.qq.com/${qq}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
        })
      } catch (e) {
        throw new Error(`QQ 空间接口请求失败:${(e as Error).message}`)
      }
      if (!resp.ok) throw new Error(`QQ 空间接口请求失败(HTTP ${resp.status})`)
      let data: Record<string, unknown>
      try {
        data = (await resp.json()) as Record<string, unknown>
      } catch {
        throw new Error('QQ 空间接口响应非 JSON(可能被风控拦截)')
      }
      if (data.code !== 0) {
        throw new Error(`QQ 空间接口返回错误(${data.code}${data.message ? ' ' + String(data.message) : ''})`)
      }
      const msglist = Array.isArray(data.msglist) ? (data.msglist as Array<Record<string, unknown>>) : []
      return msglist.map((m) => ({
        tid: String(m.tid ?? ''),
        content: typeof m.content === 'string' ? m.content : '',
        createTime: typeof m.createTime === 'number' ? m.createTime : 0,
        picnum: typeof m.picnum === 'number' ? m.picnum : (Array.isArray(m.pictures) ? m.pictures.length : 0),
        commentnum: typeof m.commentnum === 'number' ? m.commentnum : 0,
        likenum: typeof m.likenum === 'number' ? m.likenum : 0,
      }))
    },
    async setGroupBan(groupId: string, qq: string, durationSec: number): Promise<void> {
      const res = await callAction<{ status?: string; retcode?: number }>('set_group_ban', {
        group_id: groupId, user_id: qq, duration: durationSec,
      }) as { status?: string; retcode?: number }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`禁言失败(${res?.retcode ?? '未知'})`)
    },
    async setGroupKick(groupId: string, qq: string): Promise<void> {
      const res = await callAction<{ status?: string; retcode?: number }>('set_group_kick', {
        group_id: groupId, user_id: qq,
      }) as { status?: string; retcode?: number }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`踢人失败(${res?.retcode ?? '未知'})`)
    },
    async setGroupWholeBan(groupId: string, enable: boolean): Promise<void> {
      const res = await callAction<{ status?: string; retcode?: number }>('set_group_whole_ban', {
        group_id: groupId, enable,
      }) as { status?: string; retcode?: number }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`全员禁言设置失败(${res?.retcode ?? '未知'})`)
    },
    async mergeContactNames(entries: Array<{ qq: string; name?: string; source?: 'private' | 'group' }>): Promise<void> {
      try {
        const contacts = await loadNapcatContacts()
        const now = Math.floor(Date.now() / 1000)
        let changed = false
        for (const e of entries) {
          if (!e.name?.trim()) continue
          const prev = contacts[e.qq]
          if (prev?.name) continue
          contacts[e.qq] = {
            qq: e.qq,
            name: e.name.trim().slice(0, 50),
            info: prev?.info,
            source: e.source ?? prev?.source ?? 'group',
            updatedAt: now,
          }
          changed = true
        }
        if (changed) await saveNapcatContacts(contacts)
      } catch (e) {
        reportError(`联系人昵称补全失败:${(e as Error).message}`)
      }
    },
    markReplied(messageId: string) {
      const m = messages.find((x) => x.messageId === messageId)
      if (m) m.replied = true
    },
    // 会话面板管理透传(2026-08-14 manage_sessions 工具:主进程经
    // NapcatDeps 注入实现,这里只把 deps 回调暴露给工具层)
    listSessions: () => deps.listSessions?.() ?? [],
    muteSession: (key: string, muted: boolean) => deps.muteSession?.(key, muted),
    bindSession: (key: string) => deps.bindSession?.(key),
    watchSession: (kind: 'private' | 'group', id: string) => deps.watchSession?.(kind, id),
    unwatchSession: (kind: 'private' | 'group', id: string) => deps.unwatchSession?.(kind, id),
    status(): NapcatStatus {
      return {
        connected: !!ws && ws.open,
        url: cfg().napcatWsUrl?.trim() || DEFAULT_WS_URL,
        lastError,
        receivedCount,
        repliedCount,
        allowed: cfg().napcatAllowed ?? [],
        allowedGroups: cfg().napcatAllowedGroups ?? [],
        circuitBroken,
      }
    },
    getRecentMessages(): NapcatMessage[] {
      return [...messages].reverse()
    },
    getSentMessages(): NapcatSentMessage[] {
      return [...sentMessages].reverse()
    },
  }
}

export type { NapcatClient as NapcatClientType }

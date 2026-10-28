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
import { createWsSocket, parseWsUrl, type WsConn } from './wsclient'
import { BOT_MENTION_MARK, stripFingerprintMarks } from './napcat-session'
import { createNapcatExtras, type NapcatExtras } from './napcat-extras'
import { createReverseWsServer, type ReverseWsServer } from './napcat-wsserver'
import {
  buildOutgoingMessage,
  extractImageRefs,
  gtkFromCookie,
  stripMasterNarration,
  stripSelfMentions,
  stripThinkingPreamble,
  stripToolNarration,
  withoutSelfAt,
} from './napcat-text'
import {
  cqAtMe,
  napcatMessageAtQQs,
  napcatSenderName,
  napcatIncomingIsBlank,
  napcatMessageFiles,
  napcatMessageForwardIds,
  napcatMessageImages,
  napcatMessageReplyId,
  napcatMessageSubTypeNoise,
  napcatMessageText,
  napcatMessageVideos,
  napcatMessageVoices,
  shouldAdmitGroupMessage,
  type NapcatFile,
  type NapcatGroupMessage,
  type NapcatImage,
  type NapcatMessage,
  type NapcatSentMessage,
  type NapcatVideo,
  type NapcatVoice,
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
// 视频/文件下载上限(2026-10-25):QQ 视频动辄几十 MB,单独放宽到 200MB
const MAX_AV_SIZE = 200 * 1024 * 1024
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000
const MAX_RECONNECT_FAILS = 10 // 连续失败N次后熔断冷却
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10000 // 图片下载超时
const RECONNECT_CAP_MS = 30000
const INITIAL_RECONNECT_DELAY_MS = 1000
// 熔断后半开探测间隔(2026-09-03 修复"一直熔断":原熔断后永不重连,
// NapCat 晚启动/重启后只能重启应用;改为冷却后自动探测,连上即恢复)
// 2026-10-23:冷却从 60s→30s、上限 180s→60s——客服复现"启动连上、稍后
// 断开后长时间连不上",NapCat 恢复后最迟 60s 内必探测一次
const CIRCUIT_COOLDOWN_MS = 30_000
const CIRCUIT_COOLDOWN_CAP_MS = 60_000

/** 重连/熔断时序(仅测试注入;生产走上面的默认常量) */
export interface NapcatReconnectTuning {
  maxReconnectFails?: number
  reconnectDelayMs?: number
  reconnectCapMs?: number
  circuitCooldownMs?: number
  circuitCooldownCapMs?: number
}
const SEEN_CLEANUP_INTERVAL_MS = 10 * 60 * 1000 // 10分钟清理一次过期ID
const QZONE_RATE_LIMIT_MS = 1000 // QQ空间接口最小间隔


/** 连接状态 */
export interface NapcatStatus {
  connected: boolean
  url: string
  /** 连接模式(2026-10-25):forward 主动连 / reverse 本机监听 */
  mode?: 'forward' | 'reverse'
  /** 反向模式:服务端是否在监听 */
  listening?: boolean
  lastError: string
  receivedCount: number
  repliedCount: number
  allowed?: string[]
  allowedGroups?: string[]
  circuitBroken?: boolean
  /** 最近一次断开信息(2026-10-23:定位"启动连上、稍后自己熔断"用) */
  lastClose?: { code?: number; reason?: string; at: number; wasConnected: boolean }
}

/** 通知事件(撤回/好友请求/群邀请/群文件/管理员/戳一戳) */
export interface NapcatNotice {
  type:
    | 'group_recall'
    | 'friend_recall'
    | 'friend_request'
    | 'group_request'
    | 'group_increase'
    | 'group_decrease'
    | 'group_upload'
    | 'group_admin'
    | 'notify'
  /** 通知子类型(notify: poke/lucky_king/honor;group_admin: set/unset) */
  subType?: string
  /** 相关QQ号(操作者/申请人) */
  userId?: string
  /** 操作者(管理员/邀请人);主动操作时与 userId 相同 */
  operatorId?: string
  /** 群号 */
  groupId?: string
  /** 被操作者(被踢/加入) */
  targetId?: string
  /** 请求flag(需通过操作接受/拒绝) */
  flag?: string
  /** 附加信息(验证消息/理由) */
  comment?: string
  /** 群文件上传信息(group_upload) */
  file?: { id?: string; name?: string; size?: number; busid?: number }
}

/** 待处理的加好友/加群请求(2026-10-25:flag 存内存供 requests 工具操作) */
export interface NapcatPendingRequest {
  kind: 'friend' | 'group'
  flag: string
  subType?: string
  userId?: string
  groupId?: string
  comment?: string
  at: number
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
  onSent?(msg: { type: 'private' | 'group'; target: string; text: string; images?: string[]; voice?: string }): void
  /** 错误上报(不再静默catch——发送失败/API错误经此回调通知主进程) */
  onError?(message: string): void
  /** 通知事件(撤回/好友请求等) */
  onNotice?(notice: NapcatNotice): void
  /**
   * 出站风格清洗(2026-10-26):主进程按当前激活人格卡注入(去 AI 腔)。
   * 在既有剥离链之后执行;未注入则原样返回。
   */
  cleanStyle?(text: string): string | Promise<string>
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
export interface NapcatClient extends NapcatExtras {
  start(): void
  stop(): void
  status(): NapcatStatus
  downloadImages(images?: NapcatImage[]): Promise<string[]>
  /** 语音下载(2026-09-22 收语音链路):get_record 转 mp3(QQ 语音多为
   * silk/amr,浏览器 audio 播不了)→ 落 napcat-media/,作 audio media
   * part 气泡 VoiceBubble 播放;转码失败回退直下原文件 */
  downloadVoices(voices?: NapcatVoice[]): Promise<string[]>
  /** 视频下载(2026-10-25):get_file/file_id 或直链 → napcat-media/,作
   * video media part 播放 */
  downloadVideos(videos?: NapcatVideo[]): Promise<string[]>
  /** 文件下载(2026-10-25):落地后返回本地路径,仅标注给 LLM,不进 media */
  downloadFiles(files?: NapcatFile[]): Promise<string[]>
  appendChat(record: Omit<NapcatChatRecord, 'time'> & { time?: number }): void
  sendToQQ(qq: string, text: string, opts?: { image?: string; file?: string; voice?: string; replyTo?: string }): Promise<string>
  sendToGroup(
    groupId: string,
    text: string,
    opts?: { file?: string; image?: string; voice?: string; at?: string | string[]; replyTo?: string },
  ): Promise<string>
  /** 通用 OneBot 动作逃生口(2026-10-25):未命名封装的 NapCat 接口经此调用 */
  callRaw(action: string, params?: Record<string, unknown>): Promise<unknown>
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
  getGroupList(): Promise<Array<{ group_id: string; group_name?: string; member_count?: number }>>
  setGroupBan(groupId: string, qq: string, durationSec: number): Promise<void>
  setGroupKick(groupId: string, qq: string): Promise<void>
  setGroupWholeBan(groupId: string, enable: boolean): Promise<void>
  getQzoneFeeds(qq: string, num: number): Promise<Array<{ tid: string; content: string; createTime: number; picnum: number; commentnum: number; likenum: number }>>
  /** 待处理的加好友/加群请求(2026-10-25) */
  listPendingRequests(): NapcatPendingRequest[]
  /** 接受/拒绝请求并移出待处理列表(2026-10-25) */
  handleAddRequest(kind: 'friend' | 'group', flag: string, approve: boolean, subType?: string): Promise<void>
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

export function createNapcatClient(deps: NapcatDeps, tuning?: NapcatReconnectTuning): NapcatClient {
  const maxReconnectFails = tuning?.maxReconnectFails ?? MAX_RECONNECT_FAILS
  const reconnectCapMs = tuning?.reconnectCapMs ?? RECONNECT_CAP_MS
  const initialReconnectDelay = tuning?.reconnectDelayMs ?? INITIAL_RECONNECT_DELAY_MS
  const initialCircuitCooldown = tuning?.circuitCooldownMs ?? CIRCUIT_COOLDOWN_MS
  const circuitCooldownCapMs = tuning?.circuitCooldownCapMs ?? CIRCUIT_COOLDOWN_CAP_MS
  let ws: WsConn | null = null
  /** 反向 WS 服务端(2026-10-25;mode=reverse 时由本机监听) */
  let reverseServer: ReverseWsServer | null = null
  /** 反向服务端配置指纹(host:port/path|token),变化即重建 */
  let reverseKey = ''
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let circuitProbeTimer: ReturnType<typeof setTimeout> | null = null
  let seenCleanupTimer: ReturnType<typeof setInterval> | null = null
  let reconnectDelay = initialReconnectDelay
  let reconnectFails = 0
  let circuitBroken = false
  let circuitCooldownMs = initialCircuitCooldown
  let lastError = ''
  let lastClose: { code?: number; reason?: string; at: number; wasConnected: boolean } | null = null
  let receivedCount = 0
  let repliedCount = 0
  let lastQzoneCall = 0
  const messages: NapcatMessage[] = []
  const sentMessages: NapcatSentMessage[] = []
  /** 待处理的好友/群请求(2026-10-25:内存态,供 napcat requests 查询/处理) */
  const pendingRequests: NapcatPendingRequest[] = []
  /** 本进程已向这些群发过/已 watch 的临时放行(发完必须能收到回复) */
  const extraListenGroups = new Set<string>()
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
  // 连接上的账号才是「自己」。配置里的 napcatBotQQ 可能空着或写错,
  // 空着时触发消息里的 @ 会被当成别人,回复就把自己艾特出去。
  let learnedBotQQ = ''
  const learnedSelfNames = new Set<string>()
  function noteSelf(id: unknown): void {
    const s = String(id ?? '').trim()
    if (/^\d{5,12}$/.test(s)) learnedBotQQ = s
  }
  function noteSelfName(name: unknown): void {
    const n = String(name ?? '').trim()
    if (n.length >= 2 && n.length <= 20) learnedSelfNames.add(n)
  }
  const botQQ = () => learnedBotQQ || String(cfg().napcatBotQQ ?? '').trim()
  const selfNames = () => [...learnedSelfNames]
  const cacheSize = () => DEFAULT_CACHE_SIZE
  const sentSize = () => DEFAULT_SENT_SIZE
  const chatsSize = () => DEFAULT_CHATS_SIZE

  function pushRecent(msg: NapcatMessage): void {
    if (msg.messageId && messages.some((m) => m.messageId === msg.messageId && (m.groupId ?? '') === (msg.groupId ?? ''))) {
      return
    }
    messages.push(msg)
    const limit = cacheSize()
    while (messages.length > limit) messages.shift()
  }

  // 启动时用聊天备份填 recent(2026-09-03):messages 是进程内缓存,
  // 重启后 napcat recent 恒空 → LLM 误报"没收到任何 QQ 消息"
  void loadNapcatChats(chatsSize()).then((chats) => {
    if (messages.length > 0) return
    for (const c of chats.slice(-cacheSize())) {
      pushRecent({
        qq: c.qq,
        text: c.text,
        messageId: c.id,
        time: c.time,
        groupId: c.type === 'group' ? c.target : undefined,
      })
    }
    receivedCount = Math.max(receivedCount, messages.length)
  }).catch(() => {})

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

  /** 连接断开时立即失败所有在途动作(2026-10-25:原实现要等 15s 超时) */
  function rejectPending(reason: string): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    pending.clear()
  }

  function extractText(msg: unknown): string {
    return napcatMessageText(msg, botQQ())
  }

  /** 丢掉当前 socket。先把 ws 置空,迟到 onClose 看到 ws !== socket 即忽略,
   * 不再 ++fails / scheduleReconnect——叠连接会把刚连上的也再次熔断
   * (2026-10-23:熔断后 LLM start/半开探测叠旧 socket 的根因) */
  function discardSocket(): void {
    const old = ws
    ws = null
    if (!old) return
    try { old.close() } catch { /* 已关闭 */ }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  /** 熔断冷却 → 半开探测(2026-09-03):失败后不再永久停死,
   * 冷却到期尝试一次连接;成功 onOpen 全量复位,失败再排下一轮冷却 */
  function scheduleCircuitProbe(): void {
    if (stopped) return
    if (circuitProbeTimer) clearTimeout(circuitProbeTimer)
    circuitProbeTimer = setTimeout(() => {
      circuitProbeTimer = null
      if (stopped) return
      connect(true)
    }, circuitCooldownMs)
    circuitCooldownMs = Math.min(Math.round(circuitCooldownMs * 1.5), circuitCooldownCapMs)
  }

  function enterCircuitBreak(): void {
    const wasBroken = circuitBroken
    circuitBroken = true
    clearReconnectTimer()
    if (!wasBroken) {
      deps.notify?.(
        'NapCat 连接失败',
        `连续${maxReconnectFails}次连接失败，进入熔断冷却。约${Math.round(circuitCooldownMs / 1000)}秒后自动重试，也可让岛灵立即重连，NapCat 启动后无需重启应用。`,
      )
      reportError(`NapCat连续${maxReconnectFails}次连接失败，熔断冷却中(自动重试)`)
    }
    scheduleCircuitProbe()
  }

  function resetCircuit(): void {
    reconnectDelay = initialReconnectDelay
    reconnectFails = 0
    circuitBroken = false
    circuitCooldownMs = initialCircuitCooldown
    if (circuitProbeTimer) {
      clearTimeout(circuitProbeTimer)
      circuitProbeTimer = null
    }
    clearReconnectTimer()
  }

  /** 统一 WS 消息入口(2026-10-25):正向/反向连接共用同一套事件处理 */
  function handleWsMessage(text: string): void {
    let data: unknown
    try {
      data = JSON.parse(String(text))
    } catch {
      return
    }
    const obj = data as Record<string, unknown>
    // 每条事件都带 self_id。先记下,后面的跳过自己 / @ 检测才认得出自己。
    noteSelf(obj.self_id)
    // 动作响应
    if (typeof obj.echo === 'string' && pending.has(obj.echo)) {
      const p = pending.get(obj.echo)!
      pending.delete(obj.echo)
      clearTimeout(p.timer)
      if (obj.status === 'failed' || (obj.retcode !== undefined && obj.retcode !== 0)) {
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
      try { handleNotice(obj) } catch (e) { reportError(`通知事件处理失败:${(e as Error).message}`) }
      return
    }
    if (obj.post_type === 'request') {
      try { handleRequest(obj) } catch (e) { reportError(`请求事件处理失败:${(e as Error).message}`) }
      return
    }

    // 私聊消息
    if (obj.post_type === 'message' && obj.message_type === 'private') {
      void handlePrivateMessage(obj).catch((e) => reportError(`私聊消息处理失败:${(e as Error).message}`))
    }
    // 群消息
    if (obj.post_type === 'message' && obj.message_type === 'group') {
      void handleGroupMessage(obj).catch((e) => reportError(`群消息处理失败:${(e as Error).message}`))
    }
  }

  /** 连接模式(2026-10-25):forward = 主动连 NapCat;reverse = 本机监听等 NapCat 连入 */
  function mode(): 'forward' | 'reverse' {
    return cfg().napcatWsMode === 'reverse' ? 'reverse' : 'forward'
  }

  function stopReverseServer(reason = 'NapCat 反向连接已重建'): void {
    if (reverseServer) {
      try { reverseServer.stop() } catch { /* 已关闭 */ }
      reverseServer = null
      rejectPending(reason)
    }
    reverseKey = ''
    if (mode() === 'reverse') ws = null
  }

  /** 反向 WS 启动:监听 wsUrl 指定的地址,NapCat 连入后 ws 指向该连接 */
  function startReverse(): void {
    if (stopped) return
    const rawUrl = cfg().napcatWsUrl?.trim() || 'ws://127.0.0.1:3002'
    let parsed: { host: string; port: number; path: string }
    try {
      parsed = parseWsUrl(rawUrl)
    } catch (e) {
      reportError(`反向 WS 地址无效:${(e as Error).message}`)
      return
    }
    const path = parsed.path.split('?')[0] || '/'
    const q = rawUrl.indexOf('?')
    const token = q >= 0 ? decodeURIComponent(/access_token=([^&]+)/.exec(rawUrl.slice(q))?.[1] ?? '') : ''
    const key = `${parsed.host}:${parsed.port}|${path}|${token}`
    if (reverseServer && reverseKey === key && reverseServer.listening) return
    stopReverseServer()
    resetCircuit()
    lastError = ''
    reverseKey = key
    const shown = rawUrl.replace(/([?&]access_token=)[^&]*/i, '$1***')
    const server = createReverseWsServer({
      host: parsed.host,
      port: parsed.port,
      path,
      accessToken: token || undefined,
      handlers: {
        onOpen: () => {
          ws = reverseServer?.conn ?? null
          resetCircuit()
          lastError = ''
          console.log('[napcat] NapCat 已反向连接', shown)
          deps.notify?.('NapCat 已连接', `QQ 消息桥就绪(反向 WS ${shown})`)
          if (!seenCleanupTimer) {
            seenCleanupTimer = setInterval(pruneSeen, SEEN_CLEANUP_INTERVAL_MS)
          }
        },
        onMessage: handleWsMessage,
        onError: (message) => reportError(message),
        onClose: (info) => {
          ws = null
          rejectPending('NapCat 反向连接已断开')
          lastClose = { code: info?.code, reason: info?.reason, at: Date.now(), wasConnected: true }
          console.warn(
            `[napcat] 反向连接断开 code=${info?.code ?? '-'} reason=${info?.reason || '-'}`,
          )
          deps.notify?.('NapCat 连接断开', '反向 WS 等待 NapCat 重新接入(服务端仍在监听)')
        },
      },
    })
    reverseServer = server
    try {
      server.start()
      console.log('[napcat] 反向 WS 监听中', `${parsed.host}:${parsed.port}${path}`)
    } catch (e) {
      reportError(`反向 WS 监听失败:${(e as Error).message}`)
    }
  }

  function connect(isProbe = false) {
    if (stopped) return
    if (mode() === 'reverse') {
      startReverse()
      return
    }
    stopReverseServer()
    if (circuitBroken && !isProbe) return
    const url = cfg().napcatWsUrl?.trim() || DEFAULT_WS_URL
    const shownUrl = url.replace(/([?&]access_token=)[^&]*/i, '$1***')
    discardSocket()
    try {
      lastError = ''
      let opened = false
      const socket = createWsSocket(url, {
        onOpen: () => {
          if (ws !== socket) return
          opened = true
          resetCircuit()
          console.log('[napcat] 连接已建立', shownUrl)
          deps.notify?.('NapCat 已连接', `QQ 消息桥就绪(${shownUrl})`)
          // 启动定期清理过期seen
          if (!seenCleanupTimer) {
            seenCleanupTimer = setInterval(pruneSeen, SEEN_CLEANUP_INTERVAL_MS)
          }
        },
        onMessage: handleWsMessage,
        onError: (message) => {
          // 旧 socket 的迟到错误(如 start() 主动断开后的 write after end)
          // 不得覆盖当前连接状态/最近错误(2026-10-23:实测重连成功后
          // status 仍显示 "连接错误:write after end")
          if (ws !== socket) return
          lastError = message || '连接错误(请确认 NapCat 已启动且 WS 端口开放)'
          console.warn('[napcat] 连接错误:', lastError)
        },
        onClose: (info) => {
          // 只认当前 ws:被 discard/start 替换的旧 socket 迟到 close 不计失败
          if (ws !== socket) return
          ws = null
          // 主动 stop() 关闭不计失败、不熔断(2026-09-03:原 stop 触发的
          // onClose 会 ++fails,凑满 10 次时误弹"已熔断"通知)
          if (stopped) return
          rejectPending('NapCat 连接已断开')
          lastClose = { code: info?.code, reason: info?.reason, at: Date.now(), wasConnected: opened }
          console.warn(
            `[napcat] 连接断开 code=${info?.code ?? '-'} reason=${info?.reason || '-'} ` +
            `wasConnected=${opened} fails=${reconnectFails + 1}/${maxReconnectFails}`,
          )
          reconnectFails++
          if (reconnectFails >= maxReconnectFails) {
            enterCircuitBreak()
            return
          }
          scheduleReconnect()
        },
      })
      ws = socket
    } catch (e) {
      lastError = (e as Error).message
      console.warn('[napcat] 建立连接失败:', lastError)
      if (stopped) return
      reconnectFails++
      if (reconnectFails >= maxReconnectFails) {
        enterCircuitBreak()
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
      operatorId,
      groupId,
      targetId: operatorId ? subjectId : undefined, // 有操作者时主体是被操作目标
    }
    if (obj.sub_type !== undefined) msg.subType = String(obj.sub_type)
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
    } else if (noticeType === 'group_upload') {
      // 群文件上传(2026-10-25):file 对象含 id/name/size/busid
      msg.type = 'group_upload'
      const rawFile = (obj.file ?? {}) as Record<string, unknown>
      msg.userId = subjectId
      msg.file = {
        id: rawFile.id !== undefined ? String(rawFile.id) : undefined,
        name: rawFile.name !== undefined ? String(rawFile.name) : undefined,
        size: typeof rawFile.size === 'number' ? rawFile.size : undefined,
        busid: typeof rawFile.busid === 'number' ? rawFile.busid : undefined,
      }
    } else if (noticeType === 'group_admin') {
      // 管理员变动(2026-10-25):sub_type = set/unset,user_id = 被操作者
      msg.type = 'group_admin'
      msg.targetId = subjectId
      msg.userId = subjectId
    } else if (noticeType === 'notify') {
      // 戳一戳/运气王/荣誉(2026-10-25):OneBot 语义 user_id = 发起者,
      // target_id = 被戳者;运气王/荣誉无 target_id
      const sub = String(obj.sub_type ?? '')
      if (sub !== 'poke' && sub !== 'lucky_king' && sub !== 'honor') return
      msg.type = 'notify'
      msg.subType = sub
      msg.userId = subjectId
      msg.targetId = obj.target_id !== undefined ? String(obj.target_id) : undefined
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
    const subType = obj.sub_type !== undefined ? String(obj.sub_type) : undefined
    const remember = (kind: 'friend' | 'group') => {
      if (!flag) return
      if (pendingRequests.some((r) => r.flag === flag)) return
      pendingRequests.push({ kind, flag, subType, userId, groupId, comment, at: Date.now() })
      while (pendingRequests.length > 20) pendingRequests.shift()
    }
    if (reqType === 'friend') {
      remember('friend')
      deps.onNotice?.({ type: 'friend_request', userId, flag, comment })
      deps.notify?.('QQ好友请求', `QQ ${userId} 请求加好友${comment ? `:${comment}` : ''}(可让岛灵用 napcat requests 处理)`)
    } else if (reqType === 'group' && (subType === 'add' || subType === 'invite')) {
      remember('group')
      deps.onNotice?.({ type: 'group_request', userId, groupId, flag, comment, subType })
      deps.notify?.('QQ群请求', `QQ ${userId} 请求加入/邀请加入群 ${groupId}${comment ? `:${comment}` : ''}(可让岛灵用 napcat requests 处理)`)
    }
  }

  /** 合并转发/引用展开(2026-10-25;2026-10-27 增强):最多 3 条转发,失败不阻断正文。
   * 转发节点里的图片/语音/视频/文件**提取真实资源**(下载后进 media,气泡可见、
   * 视觉模型可见),不再只有 [图片] 占位;嵌套合并转发限深 2 层、总量 6 条继续展开 */
  async function expandForwards(raw: unknown): Promise<{
    text: string
    ids: string[]
    images: NapcatImage[]
    voices: NapcatVoice[]
    videos: NapcatVideo[]
    files: NapcatFile[]
  }> {
    const ids = napcatMessageForwardIds(raw)
    let text = extractText(raw)
    const images: NapcatImage[] = []
    const voices: NapcatVoice[] = []
    const videos: NapcatVideo[] = []
    const files: NapcatFile[] = []
    const replyId = napcatMessageReplyId(raw)
    if (replyId) {
      try {
        const quoted = await extras.getMessage(replyId, 3000)
        const quotedText = quoted ? napcatMessageText(quoted.message ?? quoted.raw_message ?? '') : ''
        if (quotedText) text = `【引用 ${replyId}】${quotedText}\n${text}`
      } catch {
        // 引用消息查不到不影响正文
      }
    }
    if (ids.length > 0) {
      const parts: string[] = []
      // 广度限深展开:顶层 3 条,嵌套转发最多再 3 条(共 6),深度 ≤ 2
      const queue = ids.slice(0, 3).map((id) => ({ id, depth: 1 }))
      const seen = new Set<string>()
      while (queue.length > 0 && seen.size < 6) {
        const item = queue.shift()
        if (!item || seen.has(item.id)) continue
        seen.add(item.id)
        try {
          const f = await extras.getForward(item.id, 5000)
          if (f.text) parts.push(`【合并转发】\n${f.text}`)
          images.push(...f.media.images)
          voices.push(...f.media.voices)
          videos.push(...f.media.videos)
          files.push(...f.media.files)
          if (item.depth < 2) {
            for (const nid of f.nestedIds) {
              if (!seen.has(nid)) queue.push({ id: nid, depth: item.depth + 1 })
            }
          }
        } catch (e) {
          reportError(`合并转发 ${item.id} 展开失败:${(e as Error).message}`)
        }
      }
      if (parts.length > 0) text = `${text}\n${parts.join('\n')}`
    }
    return { text, ids, images, voices, videos, files }
  }

  async function handlePrivateMessage(obj: Record<string, unknown>): Promise<void> {
    const qq = String(obj.user_id ?? '')
    if (!qq) return
    if (qq === botQQ()) return // 跳过自己
    if (napcatMessageSubTypeNoise(obj.sub_type)) return
    const messageId = String(obj.message_id ?? '')
    // 去重键区分私聊/群聊前缀(2026-08-14:不同会话message_id可能同值,分开去重)
    const dedupKey = messageId ? `private:${messageId}` : ''
    if (dedupKey && seenHas(dedupKey)) return
    const raw = obj.message ?? obj.raw_message
    const images = napcatMessageImages(raw)
    const voices = napcatMessageVoices(raw)
    const videos = napcatMessageVideos(raw)
    const files = napcatMessageFiles(raw)
    // 空包不进对话(2026-08-31:偶现空消息气泡,实际无人说话)
    if (napcatIncomingIsBlank(extractText(raw), images)) return
    if (dedupKey) seenAdd(dedupKey)
    const { text, ids, images: fwImages, voices: fwVoices, videos: fwVideos, files: fwFiles } = await expandForwards(raw)
    // 合并转发节点里的媒体(2026-10-27)并入资源数组 → 走既有下载/展示链路
    const allImages = [...images, ...fwImages]
    const allVoices = [...voices, ...fwVoices]
    const allVideos = [...videos, ...fwVideos]
    const allFiles = [...files, ...fwFiles]
    const msg: NapcatMessage = {
      qq,
      text,
      messageId,
      time: Number(obj.time ?? Math.floor(Date.now() / 1000)),
      images: allImages,
      voices: allVoices.length > 0 ? allVoices : undefined,
      videos: allVideos.length > 0 ? allVideos : undefined,
      files: allFiles.length > 0 ? allFiles : undefined,
      forwardIds: ids.length > 0 ? ids : undefined,
    }
    pushRecent(msg)
    receivedCount++
    if (text) {
      deps.notify?.(`QQ 消息(${qq})`, text.length > 50 ? text.slice(0, 50) + '…' : text)
    }
    try { deps.onMessage(msg) } catch (e) { reportError(`onMessage处理失败:${(e as Error).message}`) }
  }

  async function handleGroupMessage(obj: Record<string, unknown>): Promise<void> {
    const groupId = String(obj.group_id ?? '')
    const qq = String(obj.user_id ?? '')
    if (!groupId || !qq) return
    if (qq === botQQ()) {
      // 自己的群名片/昵称也是自称。模型写 @这个名字 时,出站要剥掉。
      noteSelfName(napcatSenderName(obj.sender))
      return
    }
    if (!shouldAdmitGroupMessage(cfg().napcatAllowedGroups, groupId, extraListenGroups)) return
    if (napcatMessageSubTypeNoise(obj.sub_type)) return
    const messageId = String(obj.message_id ?? '')
    // 去重键区分私聊/群聊前缀(2026-08-14:不同会话message_id可能同值,分开去重)
    const dedupKey = messageId ? `group:${messageId}` : ''
    if (dedupKey && seenHas(dedupKey)) return
    const raw = obj.message ?? obj.raw_message
    const images = napcatMessageImages(raw)
    const voices = napcatMessageVoices(raw)
    const videos = napcatMessageVideos(raw)
    const files = napcatMessageFiles(raw)
    if (napcatIncomingIsBlank(extractText(raw), images)) return
    if (dedupKey) seenAdd(dedupKey)
    // @ 机器人检测:段数组 + CQ码字符串
    const bqq = botQQ()
    const atMe =
      (Array.isArray(raw)
        ? raw.some((seg: { type?: string; data?: Record<string, unknown> }) =>
            seg?.type === 'at' && String(seg.data?.qq ?? '') === bqq)
        : false) || cqAtMe(raw, bqq)
    const atQQs = napcatMessageAtQQs(raw, bqq)
    const senderName = napcatSenderName(obj.sender)
    const { text, ids, images: fwImages, voices: fwVoices, videos: fwVideos, files: fwFiles } = await expandForwards(raw)
    // 合并转发节点里的媒体(2026-10-27)并入资源数组 → 走既有下载/展示链路
    const allImages = [...images, ...fwImages]
    const allVoices = [...voices, ...fwVoices]
    const allVideos = [...videos, ...fwVideos]
    const allFiles = [...files, ...fwFiles]
    const msg: NapcatGroupMessage = {
      groupId,
      qq,
      text,
      atMe,
      atQQs: atQQs.length > 0 ? atQQs : undefined,
      senderName: senderName || undefined,
      messageId,
      time: Number(obj.time ?? Math.floor(Date.now() / 1000)),
      images: allImages,
      voices: allVoices.length > 0 ? allVoices : undefined,
      videos: allVideos.length > 0 ? allVideos : undefined,
      files: allFiles.length > 0 ? allFiles : undefined,
      forwardIds: ids.length > 0 ? ids : undefined,
    }
    pushRecent({
      qq,
      text,
      messageId,
      time: msg.time,
      images: allImages,
      groupId,
    })
    receivedCount++
    if (text) {
      deps.notify?.(
        `${msg.atMe ? `${BOT_MENTION_MARK} ` : ''}群消息(QQ ${qq})`,
        text.length > 50 ? text.slice(0, 50) + '…' : text,
      )
    }
    try { deps.onGroupMessage(msg) } catch (e) { reportError(`onGroupMessage处理失败:${(e as Error).message}`) }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    if (circuitBroken) {
      scheduleCircuitProbe()
      return
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectCapMs)
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
  /** 扩展动作封装(2026-10-25):群文件/群管/账号/好友/转发/表情 */
  const extras = createNapcatExtras(callAction, botQQ)

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

  /** 语音下载(2026-09-22 收语音链路):get_record(out_format=mp3)转码
   * 落地——QQ 语音多为 silk/amr,浏览器 <audio> 播不了;转码失败回退
   * 直下 url/file(扩展名保留,能否播看浏览器)。产出 .mp3 → 渲染端
   * inferMediaKind 判 audio → MediaFrame VoiceBubble 播放 */
  async function downloadVoice(voice: NapcatVoice): Promise<string | null> {
    try {
      await fs.mkdir(mediaDir(), { recursive: true })
      let localPath = ''
      const ref = voice.file || voice.url || ''
      if (ref) {
        try {
          const res = await callAction<{ data?: { file?: string } }>('get_record', {
            file: ref,
            out_format: 'mp3',
          }, FILE_UPLOAD_TIMEOUT_MS) as { status?: string; retcode?: number; data?: { file?: string } }
          const p = res?.data?.file
          if (p && existsSync(p)) localPath = p
        } catch {
          // get_record 失败走直下兜底
        }
      }
      if (!localPath && voice.file && existsSync(voice.file)) localPath = voice.file
      if (!localPath && voice.url) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS)
          const resp = await fetch(voice.url, { signal: controller.signal })
          clearTimeout(timer)
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer())
            if (buf.length > MAX_IMAGE_SIZE) {
              reportError(`语音过大(${Math.round(buf.length / 1024 / 1024)}MB>20MB),跳过下载`)
              return null
            }
            const ct = String(resp.headers.get('content-type') ?? '')
            const ext = /audio\/(mp[eE]g|mp3|mpeg|wav|x-wav)/.exec(ct)?.[1]?.replace(/mp[eE]g|mpeg/i, 'mp3').replace(/wav|x-wav/i, 'wav') ?? 'mp3'
            localPath = path.join(mediaDir(), `${Date.now()}-${randomInt(1 << 24).toString(36)}.${ext}`)
            await fs.writeFile(localPath, buf)
            return localPath
          }
        } catch (e) {
          reportError(`语音下载失败:${(e as Error).message}`)
          return null
        }
      }
      if (!localPath) return null
      const ext = path.extname(localPath) || '.mp3'
      const dest = path.join(mediaDir(), `${Date.now()}-${randomInt(1 << 24).toString(36)}${ext}`)
      await fs.copyFile(localPath, dest)
      return dest
    } catch (e) {
      reportError(`语音处理失败:${(e as Error).message}`)
      return null
    }
  }

  /** 扩展名推断(2026-10-25 视频/文件落地):优先原名,其次 URL,最后兜底 */
  function extOf(nameOrUrl: string | undefined, fallback: string): string {
    const clean = String(nameOrUrl ?? '').split(/[?#]/)[0]
    const ext = path.extname(clean).toLowerCase()
    return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : fallback
  }

  /** 直链下载到 napcat-media(视频/文件共用;超 200MB 跳过) */
  async function fetchToMedia(url: string, fallbackExt: string, label: string): Promise<string | null> {
    try {
      await fs.mkdir(mediaDir(), { recursive: true })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS)
      const resp = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const declared = Number(resp.headers.get('content-length') ?? 0)
      if (declared > MAX_AV_SIZE) {
        reportError(`${label}过大(${Math.round(declared / 1024 / 1024)}MB>200MB),跳过下载`)
        return null
      }
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length > MAX_AV_SIZE) {
        reportError(`${label}过大(${Math.round(buf.length / 1024 / 1024)}MB>200MB),跳过下载`)
        return null
      }
      const ext = extOf(url, fallbackExt)
      const dest = path.join(mediaDir(), `${Date.now()}-${randomInt(1 << 24).toString(36)}${ext}`)
      await fs.writeFile(dest, buf)
      return dest
    } catch (e) {
      const msg = (e as Error).message
      reportError(`${label}下载失败:${msg?.includes('abort') ? `超时(>${MEDIA_DOWNLOAD_TIMEOUT_MS / 1000}s)` : msg}`)
      return null
    }
  }

  /** 本地文件复制到 napcat-media */
  async function copyToMedia(localPath: string, fallbackExt: string): Promise<string> {
    await fs.mkdir(mediaDir(), { recursive: true })
    const ext = path.extname(localPath) || fallbackExt
    const dest = path.join(mediaDir(), `${Date.now()}-${randomInt(1 << 24).toString(36)}${ext}`)
    await fs.copyFile(localPath, dest)
    return dest
  }

  /** get_file 解析(file_id 或 file → 本地路径/直链) */
  async function resolveFileRef(
    fileId?: string,
    file?: string,
  ): Promise<{ local?: string; url?: string }> {
    if (!fileId && !file) return {}
    try {
      const res = await callAction<{ data?: { file?: string; url?: string } }>(
        'get_file',
        fileId ? { file_id: fileId } : { file },
        FILE_UPLOAD_TIMEOUT_MS,
      ) as { data?: { file?: string; url?: string } }
      const d = res?.data ?? {}
      const p = String(d.file ?? '')
      const u = String(d.url ?? '')
      return {
        local: p && existsSync(p) ? p : undefined,
        url: /^https?:/i.test(u) ? u : /^https?:/i.test(p) ? p : undefined,
      }
    } catch {
      return {}
    }
  }

  /** 视频落地(2026-10-25):get_file/直链 → napcat-media,作 video media part */
  async function downloadVideo(video: NapcatVideo): Promise<string | null> {
    try {
      let local = ''
      let url = /^https?:/i.test(video.url ?? '') ? String(video.url) : ''
      if (!local && !url) {
        const r = await resolveFileRef(video.file_id, video.file)
        if (r.local) local = r.local
        else if (r.url) url = r.url
      }
      if (!local && !url && video.file && existsSync(video.file)) local = video.file
      if (!local && url) return await fetchToMedia(url, extOf(video.name ?? url, '.mp4'), '视频')
      if (!local) return null
      return await copyToMedia(local, extOf(video.name ?? local, '.mp4'))
    } catch (e) {
      reportError(`视频处理失败:${(e as Error).message}`)
      return null
    }
  }

  /** 文件落地(2026-10-25):返回本地路径给 LLM 读取,不进 media(避免当图片渲染) */
  async function downloadFile(file: NapcatFile): Promise<string | null> {
    try {
      let local = ''
      let url = /^https?:/i.test(file.url ?? '') ? String(file.url) : ''
      if (!local && !url) {
        const r = await resolveFileRef(file.file_id, file.file)
        if (r.local) local = r.local
        else if (r.url) url = r.url
      }
      if (!local && !url && file.file && existsSync(file.file)) local = file.file
      if (!local && url) return await fetchToMedia(url, extOf(file.name ?? url, '.bin'), '文件')
      if (!local) return null
      return await copyToMedia(local, extOf(file.name ?? local, '.bin'))
    } catch (e) {
      reportError(`文件处理失败:${(e as Error).message}`)
      return null
    }
  }

  async function prepareOutgoingText(text: string, isMaster: boolean): Promise<string> {
    let t = text
    if (!isMaster) {
      // 非主人发送边界统一清洗(2026-08-17:内部独白判定不在此用正则——
      // 交由 main.cjs 的审核 Sub Agent 判断,见 handleEngineMessageForNapcat)
      t = stripThinkingPreamble(stripMasterNarration(stripToolNarration(stripFingerprintMarks(t))))
    } else {
      t = stripFingerprintMarks(t)
    }
    // 人格卡出站风格清洗(2026-10-26):主进程按激活卡注入;失败不阻断发送
    if (deps.cleanStyle) {
      try {
        t = await deps.cleanStyle(t)
      } catch {
        // 保留既有清洗结果
      }
    }
    return t
  }

  return {
    ...extras,
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
    async downloadVoices(voices?: NapcatVoice[]): Promise<string[]> {
      if (!voices || voices.length === 0) return []
      const out: string[] = []
      for (const v of voices) {
        const p = await downloadVoice(v)
        if (p) out.push(p)
      }
      return out
    },
    async downloadVideos(videos?: NapcatVideo[]): Promise<string[]> {
      if (!videos || videos.length === 0) return []
      const out: string[] = []
      for (const v of videos) {
        const p = await downloadVideo(v)
        if (p) out.push(p)
      }
      return out
    },
    async downloadFiles(files?: NapcatFile[]): Promise<string[]> {
      if (!files || files.length === 0) return []
      const out: string[] = []
      for (const f of files) {
        const p = await downloadFile(f)
        if (p) out.push(p)
      }
      return out
    },
    listPendingRequests(): NapcatPendingRequest[] {
      return pendingRequests.slice().reverse()
    },
    async handleAddRequest(
      kind: 'friend' | 'group',
      flag: string,
      approve: boolean,
      subType?: string,
    ): Promise<void> {
      await extras.handleAddRequest(kind, flag, approve, subType)
      const idx = pendingRequests.findIndex((r) => r.flag === flag)
      if (idx >= 0) pendingRequests.splice(idx, 1)
    },
    appendChat(record: Omit<NapcatChatRecord, 'time'> & { time?: number }) {
      appendNapcatChat({
        ...record,
        time: record.time ?? Math.floor(Date.now() / 1000),
      }, chatsSize())
    },
    start() {
      stopped = false
      // 反向模式重连 = 重建监听(端口/路径可能已变),并等待 NapCat 重新接入;
      // 若刚从正向切过来,先关掉旧的正向连接,避免两条通道并存
      if (mode() === 'reverse') {
        stopReverseServer()
        discardSocket()
      }
      resetCircuit()
      connect()
    },
    stop() {
      stopped = true
      circuitBroken = true
      clearReconnectTimer()
      if (circuitProbeTimer) { clearTimeout(circuitProbeTimer); circuitProbeTimer = null }
      if (seenCleanupTimer) { clearInterval(seenCleanupTimer); seenCleanupTimer = null }
      stopReverseServer('NapCat已停止')
      rejectPending('NapCat已停止')
      discardSocket()
    },
    async sendToQQ(qq: string, text: string, opts?: { image?: string; file?: string; voice?: string; replyTo?: string }): Promise<string> {
      const isMaster = qq === masterQQ()
      const cleaned = await prepareOutgoingText(text, isMaster)
      const paramImage = typeof opts?.image === 'string' && opts.image.trim() ? opts.image.trim() : ''
      const file = typeof opts?.file === 'string' && opts.file.trim() ? opts.file.trim() : ''
      const voice = typeof opts?.voice === 'string' && opts.voice.trim() ? opts.voice.trim() : ''
      const { text: cleanText, images: refImages } = extractImageRefs(cleaned)
      if (!cleanText.trim() && refImages.length === 0 && !paramImage && !file && !voice) return ''
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
      // 语音条校验(2026-09-22):record 段走消息本体(非文件柜),本地路径须存在
      if (voice && !/^https?:|^base64:|^data:audio\//.test(voice) && !existsSync(voice)) {
        throw new Error(`语音文件不存在:${voice}(voice 需要本地绝对路径或 http(s)/base64/data:audio 链接)`)
      }
      // 发送频率限制检查(2026-08-14 防刷屏;等待重试,见 waitSendSlot)
      await waitSendSlot(`private:${qq}`)
      const message: unknown = buildOutgoingMessage(finalText, finalImages, voice, {
        replyTo: typeof opts?.replyTo === 'string' ? opts.replyTo.trim() : '',
      })
      try {
        const res = await callAction<{ status?: string; data?: { message_id?: number } }>('send_private_msg', {
          user_id: qq, message,
        }) as { status?: string; retcode?: number; data?: { message_id?: number } }
        if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`QQ 发送失败(${res?.retcode ?? '未知'})`)
        recordSend(`private:${qq}`)
        const id = String(res?.data?.message_id ?? '')
        recordSent({ messageId: id, type: 'private', target: qq, text: finalText.slice(0, 100) || '(图片/文件/语音)' })
        repliedCount++
        deps.onSent?.({ type: 'private', target: qq, text: finalText, images: finalImages, voice: voice || undefined })
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
    async sendToGroup(
      groupId: string,
      text: string,
      opts?: { file?: string; image?: string; voice?: string; at?: string | string[]; replyTo?: string },
    ): Promise<string> {
      const self = botQQ()
      const cleaned = stripSelfMentions(await prepareOutgoingText(text, false), self, selfNames())
      const paramImage = typeof opts?.image === 'string' && opts.image.trim() ? opts.image.trim() : ''
      const file = typeof opts?.file === 'string' && opts.file.trim() ? opts.file.trim() : ''
      const voice = typeof opts?.voice === 'string' && opts.voice.trim() ? opts.voice.trim() : ''
      const { text: cleanText, images: refImages } = extractImageRefs(cleaned)
      if (!cleanText.trim() && refImages.length === 0 && !file && !paramImage && !voice) return ''
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
      // 语音条校验(同 sendToQQ):record 段走消息本体
      if (voice && !/^https?:|^base64:|^data:audio\//.test(voice) && !existsSync(voice)) {
        throw new Error(`语音文件不存在:${voice}(voice 需要本地绝对路径或 http(s)/base64/data:audio 链接)`)
      }
      // 发送频率限制检查(2026-08-14 防刷屏;等待重试,见 waitSendSlot)
      const rateKey = `group:${groupId}`
      await waitSendSlot(rateKey)
      const message: unknown = buildOutgoingMessage(finalText, finalImages, voice, {
        at: withoutSelfAt(opts?.at, self),
        replyTo: typeof opts?.replyTo === 'string' ? opts.replyTo.trim() : '',
        selfQQ: self,
      })
      let messageId = ''
      if (finalText.trim() || finalImages.length > 0 || voice) {
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
      recordSent({ messageId, type: 'group', target: groupId, text: finalText.slice(0, 100) || '(图片/文件/语音)' })
      deps.onSent?.({ type: 'group', target: groupId, text: finalText, images: finalImages, voice: voice || undefined })
      // 发到某群 = 正在对话,必须能收到回复(2026-09-03:白名单过滤会把
      // 未 watch 的群消息整段丢掉,LLM send_group 后以为群里没人回)
      extraListenGroups.add(groupId)
      try {
        deps.watchSession?.('group', groupId)
      } catch (err) {
        reportError(`自动监听群 ${groupId} 失败:${(err as Error).message}`)
      }
      repliedCount++
      return messageId
    },
    async callRaw(action: string, params?: Record<string, unknown>): Promise<unknown> {
      return callAction(String(action), params ?? {})
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
    async getGroupList(): Promise<Array<{ group_id: string; group_name?: string; member_count?: number }>> {
      const res = await callAction<{ data?: Array<Record<string, unknown>> }>('get_group_list', {}) as {
        status?: string; retcode?: number; data?: Array<Record<string, unknown>>
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`群列表获取失败(${res?.retcode ?? '未知'})`)
      return (res?.data ?? []).map((g) => ({
        group_id: String(g.group_id ?? ''),
        group_name: g.group_name !== undefined ? String(g.group_name) : undefined,
        member_count: typeof g.member_count === 'number' ? g.member_count : undefined,
      }))
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
      // NapCat/OneBot get_cookies 把凭证放在 data 里(2026-10-25 修正:
      // 原实现读顶层 res.cookies 恒为空,QQ 空间动态一直取不到)
      const res = await callAction<{
        data?: { cookies?: string; bkn?: string; token?: number }
        cookies?: string
        bkn?: string
      }>('get_cookies', { domain: 'qzone.qq.com' }) as {
        status?: string
        retcode?: number
        data?: { cookies?: string; bkn?: string; token?: number }
        cookies?: string
        bkn?: string
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`QQ 空间 Cookie 获取失败(${res?.retcode ?? '未知'})`)
      const credential = res?.data ?? res
      const cookies = String(credential?.cookies ?? '')
      if (!cookies) throw new Error('QQ 空间 Cookie 为空(NapCat版本可能过旧)')
      const gtk = String(credential?.bkn ?? '') || gtkFromCookie(cookies)
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
      if (Number(data.code) !== 0) {
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
    watchSession: (kind: 'private' | 'group', id: string) => {
      if (kind === 'group') extraListenGroups.add(String(id))
      deps.watchSession?.(kind, id)
    },
    unwatchSession: (kind: 'private' | 'group', id: string) => {
      if (kind === 'group') extraListenGroups.delete(String(id))
      deps.unwatchSession?.(kind, id)
    },
    status(): NapcatStatus {
      const rawUrl = cfg().napcatWsUrl?.trim() || (mode() === 'reverse' ? 'ws://127.0.0.1:3002' : DEFAULT_WS_URL)
      return {
        connected: !!ws && ws.open,
        mode: mode(),
        listening: mode() === 'reverse' ? !!reverseServer?.listening : undefined,
        // access_token 只留在连接层,状态/工具回显一律脱敏(2026-10-25)
        url: rawUrl.replace(/([?&]access_token=)[^&]*/i, '$1***'),
        lastError,
        receivedCount,
        repliedCount,
        allowed: cfg().napcatAllowed ?? [],
        allowedGroups: cfg().napcatAllowedGroups ?? [],
        circuitBroken,
        lastClose: lastClose ?? undefined,
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

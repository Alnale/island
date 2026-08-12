/**
 * NapCat QQ 机器人桥(2026-08-12)
 *
 * OneBot 11 协议 WebSocket 客户端,零第三方依赖(全局 WebSocket,Node 22+):
 * - 正向 WS 连接 NapCat(默认 ws://127.0.0.1:3001),断线指数退避重连;
 * - 收到**私聊消息**事件 → 回调 onMessage(QQ 号 + 文本)——main.cjs 转发
 *   渲染端作为用户消息进入对话(同步上下文),LLM 回复后经 sendToQQ 发回
 *    QQ(用户要求"对话窗口和 QQ 自己回复我");
 * - 收到**群消息**事件 → 回调 onGroupMessage(群号 + QQ + 文本)——main.cjs
 *   自主判断是否接话(防刷屏),接话进对话,回复发回群;
 * - 长期记忆自动生效(QQ 对话走主引擎,系统提示含记忆块);
 * - 消息缓存(最近 50 条)供 napcat 工具查询;
 * - 配置 agent.napcatWsUrl / agent.napcatEnabled / agent.napcatAllowed
 *   (私聊 QQ 白名单,用户限定 1178821869)/ agent.napcatAllowedGroups
 *   (群白名单,用户限定 1045765371)。在已有 Python 桥 qq_bridge.py 的
 *   基础上整合(其连接/私聊回复/群聊自主接话能力全部并入本模块,桥退役)。
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
import path from 'node:path'
import { app } from 'electron'
import type { AgentConfig, AgentTool, ToolParams } from './types'
import { MASTER_QQ } from './constants'

/** OneBot 消息 → 文本(兼容 string 与段数组;测试用导出):text 段拼接,
 * face/emoji 标注,@ 段标注(机器人自身 = @鲸鱼娘),其它段(图片等)标注类型 */
export function napcatMessageText(msg: unknown, botQQ?: string): string {
  if (typeof msg === 'string') return msg
  if (Array.isArray(msg)) {
    return msg
      .map((seg) => {
        const s = seg as { type?: string; data?: Record<string, unknown> }
        if (s?.type === 'text') return String(s.data?.text ?? '')
        if (s?.type === 'face' || s?.type === 'emoji') return `[${s.type}]`
        if (s?.type === 'at') {
          const qq = String(s.data?.qq ?? '')
          return qq === String(botQQ ?? '') ? '@鲸鱼娘' : `@${qq}`
        }
        if (s?.type === 'image') return '[图片]'
        if (s?.type === 'reply') return '[回复]'
        return `[${s.type ?? 'segment'}]`
      })
      .join('')
  }
  return String(msg ?? '')
}

/** 收到的 QQ 消息(私聊) */
export interface NapcatMessage {
  /** 发送者 QQ 号 */
  qq: string
  /** 文本内容(段数组已拼接;纯图片等无文本时为空串) */
  text: string
  /** 消息 ID(去重用) */
  messageId: string
  /** 收到时间戳(秒) */
  time: number
  /** 是否已自动回复 */
  replied?: boolean
  /** 图片段(2026-08-12:收图链路,main.cjs 下载后注入对话) */
  images?: NapcatImage[]
}

/** 收到的群消息 */
export interface NapcatGroupMessage {
  /** 群号 */
  groupId: string
  /** 发送者 QQ 号 */
  qq: string
  /** 文本内容 */
  text: string
  /** 是否 @ 了机器人(必须接话) */
  atMe: boolean
  messageId: string
  time: number
  /** 图片段(2026-08-12:收图链路,main.cjs 下载后注入对话) */
  images?: NapcatImage[]
}

/** 消息中的图片段(image 段):file = NapCat 缓存文件名(如 xxx.image)或
 * 本地路径,url = 图床直链(可能为空——旧缓存消息仅 file) */
export interface NapcatImage {
  file?: string
  url?: string
}

/** 机器人发出的消息(2026-08-12 修复"私聊无法撤回"):发送成功
 * (sendToQQ/sendToGroup 返回 message_id)后自动记录——此前只记录
 * **收到**的消息,机器人自己发的消息 ID 无处可查,recall 拿不到
 * ID 撤不了;sent 记录带 message_id,LLM 经 napcat 工具 sent action
 * 查到后可直接 recall 撤回 */
export interface NapcatSentMessage {
  messageId: string
  /** private = 私聊 / group = 群聊 */
  type: 'private' | 'group'
  /** 私聊 = 对方 QQ 号 / 群聊 = 群号 */
  target: string
  text: string
  time: number
}

/** 提取消息中的图片段(2026-08-12 收图):段数组里的 image 段 → 图片
 * 列表(保留 file/url 原字段,供下载);string 消息无图片 */
export function napcatMessageImages(msg: unknown): NapcatImage[] {
  if (!Array.isArray(msg)) return []
  const out: NapcatImage[] = []
  for (const seg of msg) {
    const s = seg as { type?: string; data?: Record<string, unknown> }
    if (s?.type === 'image') {
      out.push({
        file: s.data?.file !== undefined ? String(s.data.file) : undefined,
        url: s.data?.url !== undefined ? String(s.data.url) : undefined,
      })
    }
  }
  return out
}

/** 连接状态 */
export interface NapcatStatus {
  connected: boolean
  url: string
  lastError: string
  /** 收到消息总数 */
  receivedCount: number
  /** 已回复数 */
  repliedCount: number
  /** 私聊白名单(2026-08-12 诊断:空 = 回复所有私聊) */
  allowed?: string[]
  /** 监听群白名单(2026-08-12 诊断:空 = 监听所有群;不在列表的群
   * 消息被过滤,LLM 查"为什么新群收不到"可见) */
  allowedGroups?: string[]
}

/** 主进程注入的依赖 */
export interface NapcatDeps {
  /** 引擎配置(读 agent.napcat* 字段) */
  getConfig(): AgentConfig
  /** 收到私聊消息(经 main.cjs 转发渲染端触发对话) */
  onMessage(msg: NapcatMessage): void
  /** 收到群消息(经 main.cjs 自主判断是否接话) */
  onGroupMessage(msg: NapcatGroupMessage): void
  /** Windows 系统通知(消息到达提示) */
  notify?(title: string, body: string): void
}

const DEFAULT_WS_URL = 'ws://127.0.0.1:3001'
/** 消息缓存上限(工具 recent 查询用) */
const MAX_CACHE = 50
/** 机器人发出消息记录上限(工具 sent 查询用) */
const MAX_SENT = 50
/** 动作调用超时(ms) */
const ACTION_TIMEOUT_MS = 15000
/** 机器人自身 QQ(群 @ 检测;与 Python 桥 BOT_QQ 一致) */
const BOT_QQ = '108724305'
/** 群消息去重(最近 200 条 message_id) */
const groupSeen = new Set<string>()

// ---- 联系人档案(2026-08-12,用户要求"读取并记忆群聊和私聊内群成员
// 的相关信息,计入工具的记忆目录") ----
// userData/napcat-contacts.json:QQ 号 → 档案{备注/信息/来源/更新时间}。
// LLM 经 napcat 工具 contacts action 读写(交流中认识新联系人时记录),
// 回复时可用档案里的称呼与信息(配合隐私边界,私密信息不对外说)
export interface NapcatContact {
  /** 联系人/成员 QQ 号 */
  qq: string
  /** 备注名(群里的昵称/称呼) */
  name?: string
  /** 已知信息(身份/喜好/关系等,一句话) */
  info?: string
  /** 认识来源:private = 私聊 / group = 群聊 */
  source?: 'private' | 'group'
  /** 更新时间戳(秒) */
  updatedAt: number
}

/** 用户数据目录(测试回退临时路径) */
function userDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    return path.join(process.env.APPDATA ?? '', 'dynamic-island')
  }
}

/** 联系人档案文件路径 */
export function napcatContactsPath(): string {
  return path.join(userDataDir(), 'napcat-contacts.json')
}

// ---- 聊天记录备份(2026-08-12,用户要求"不只是长期记忆,也要单独
// 存放一个备份在工具记忆中") ----
// userData/napcat-chats.json:私聊/群聊的**原始消息**备份(时间/来源/
// 文本)——与提炼后的长期记忆(memory.json)分开,是"工具记忆"的原始
// 层;LLM 经 napcat 工具 chats action 查询,防丢失(长期记忆提炼会遗漏
// 细节,原始记录兜底)
export interface NapcatChatRecord {
  /** 消息 ID(去重) */
  id: string
  /** private = 私聊 / group = 群聊 */
  type: 'private' | 'group'
  /** 私聊 = 对方 QQ 号 / 群聊 = 群号 */
  target: string
  /** 发送者 QQ 号 */
  qq: string
  text: string
  /** 是否 @ 了机器人(群聊) */
  atMe?: boolean
  time: number
}

/** 聊天记录备份文件路径 */
export function napcatChatsPath(): string {
  return path.join(userDataDir(), 'napcat-chats.json')
}

// ---- 会话人格(2026-08-12,用户要求"在不同会话(群聊/私聊)中扮演
// 不同人格,写入长期记忆和工具记忆,作为会话人格记忆——整合各个
// 会话中不同联系人的喜好和风格") ----
// userData/napcat-personas.json:{ [scope]: {persona, updatedAt} }
// scope = 'private:<QQ号>' | 'group:<群号>'——每个会话独立人格
// (群聊一个"群友版人设",私聊一个"亲近版人设"),注入时按会话带入;
// 联系人喜好/风格由 LLM 在会话中沉淀(contact_update/remember)或
// 直接 persona_set 设置
export interface NapcatPersona {
  /** 人格描述(回复风格/人设/该会话联系人的喜好与风格整合) */
  persona: string
  updatedAt: number
}

/** 会话人格文件路径 */
export function napcatPersonasPath(): string {
  return path.join(userDataDir(), 'napcat-personas.json')
}

/** 会话 scope:'private:<QQ号>' / 'group:<群号>' */
export function personaScope(type: 'private' | 'group', target: string): string {
  return `${type}:${target}`
}

/** 读取全部会话人格 */
export async function loadNapcatPersonas(): Promise<Record<string, NapcatPersona>> {
  try {
    const raw = await fs.readFile(napcatPersonasPath(), 'utf8')
    const obj = JSON.parse(raw) as Record<string, Partial<NapcatPersona>>
    const out: Record<string, NapcatPersona> = {}
    for (const [scope, p] of Object.entries(obj)) {
      if (p && typeof p === 'object' && typeof p.persona === 'string' && p.persona.trim()) {
        out[scope] = { persona: p.persona.trim().slice(0, 500), updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0 }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 写入会话人格(原子写;persona 为空 = 删除该会话人格) */
export async function saveNapcatPersona(scope: string, persona: string): Promise<NapcatPersona | null> {
  const personas = await loadNapcatPersonas()
  const p = napcatPersonasPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  if (!persona.trim()) {
    delete personas[scope]
    const tmp = p + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(personas, null, 2), 'utf8')
    await fs.rename(tmp, p)
    return null
  }
  const next: NapcatPersona = { persona: persona.trim().slice(0, 500), updatedAt: Math.floor(Date.now() / 1000) }
  personas[scope] = next
  const tmp = p + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(personas, null, 2), 'utf8')
  await fs.rename(tmp, p)
  return next
}

/** 聊天记录上限(超限淘汰最旧) */
const MAX_CHATS = 500

/** 读取聊天记录备份(文件缺失/损坏返回空数组) */
export async function loadNapcatChats(): Promise<NapcatChatRecord[]> {
  try {
    const raw = await fs.readFile(napcatChatsPath(), 'utf8')
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (c): c is NapcatChatRecord =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as NapcatChatRecord).id === 'string' &&
        typeof (c as NapcatChatRecord).text === 'string' &&
        ((c as NapcatChatRecord).type === 'private' || (c as NapcatChatRecord).type === 'group'),
    )
  } catch {
    return []
  }
}

/** 追加一条聊天记录(串行写队列防并发竞争;失败静默——备份是兜底,
 * 不阻断通信) */
let chatWriteChain: Promise<unknown> = Promise.resolve()
export function appendNapcatChat(record: NapcatChatRecord): void {
  chatWriteChain = chatWriteChain
    .then(async () => {
      const chats = await loadNapcatChats()
      // 同 id 去重(重连重复推送)
      if (chats.some((c) => c.id === record.id)) return
      chats.push(record)
      const trimmed = chats.slice(-MAX_CHATS)
      const p = napcatChatsPath()
      await fs.mkdir(path.dirname(p), { recursive: true })
      const tmp = p + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(trimmed, null, 1), 'utf8')
      await fs.rename(tmp, p)
    })
    .catch(() => {
      // 备份写入失败静默
    })
}

/** 读取联系人档案(文件缺失/损坏返回空表) */
export async function loadNapcatContacts(): Promise<Record<string, NapcatContact>> {
  try {
    const raw = await fs.readFile(napcatContactsPath(), 'utf8')
    const obj = JSON.parse(raw) as Record<string, Partial<NapcatContact>>
    const out: Record<string, NapcatContact> = {}
    for (const [qq, c] of Object.entries(obj)) {
      if (c && typeof c === 'object' && typeof qq === 'string') {
        out[qq] = {
          qq,
          name: typeof c.name === 'string' ? c.name.slice(0, 50) : undefined,
          info: typeof c.info === 'string' ? c.info.slice(0, 500) : undefined,
          source: c.source === 'group' ? 'group' : 'private',
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 从 QQ Cookie 计算 g_tk(CSRF token,2026-08-12 QQ 空间动态接口用):
 * 标准 hash33 算法,p_skey 优先、skey 兜底;找不到返回空串 */
export function gtkFromCookie(cookie: string): string {
  const m = /p_skey=([^;]+)/.exec(cookie) ?? /skey=([^;]+)/.exec(cookie)
  if (!m) return ''
  let hash = 5381
  for (let i = 0; i < m[1].length; i++) hash += (hash << 5) + m[1].charCodeAt(i)
  return String(hash & 0x7fffffff)
}

/** 写入联系人档案(原子写) */
export async function saveNapcatContacts(contacts: Record<string, NapcatContact>): Promise<void> {
  try {
    const p = napcatContactsPath()
    await fs.mkdir(path.dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(contacts, null, 2), 'utf8')
    await fs.rename(tmp, p)
  } catch {
    // 写入失败忽略(档案是增强功能,不阻断通信)
  }
}

export function createNapcatClient(deps: NapcatDeps) {
  let ws: WebSocket | null = null
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 1000
  let lastError = ''
  let receivedCount = 0
  let repliedCount = 0
  const messages: NapcatMessage[] = []
  /** 机器人发出的消息记录(2026-08-12:send 成功后记录,recall 可查 ID) */
  const sentMessages: NapcatSentMessage[] = []
  /** 动作调用:echo → resolve(等待响应;泛型经闭包转换) */
  const pending = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
  let echoSeq = 0

  /** 记录一条发出的消息(有 message_id 才记——没有 ID 撤不了,记了也没用) */
  function recordSent(msg: Omit<NapcatSentMessage, 'time'> & { time?: number }): void {
    if (!msg.messageId) return
    sentMessages.push({ ...msg, time: msg.time ?? Math.floor(Date.now() / 1000) })
    if (sentMessages.length > MAX_SENT) sentMessages.shift()
  }

  const cfg = () => deps.getConfig()

  /** 消息文本提取(兼容 string 与段数组) */
  function extractText(msg: unknown): string {
    return napcatMessageText(msg)
  }

  function connect() {
    if (stopped) return
    const url = cfg().napcatWsUrl?.trim() || DEFAULT_WS_URL
    try {
      lastError = ''
      const socket = new WebSocket(url)
      ws = socket
      socket.onopen = () => {
        reconnectDelay = 1000
        deps.notify?.('NapCat 已连接', `QQ 消息桥就绪(${url})`)
      }
      socket.onmessage = (ev) => {
        let data: unknown
        try {
          data = JSON.parse(String(ev.data))
        } catch {
          return // 非 JSON(心跳二进制等)忽略
        }
        const obj = data as Record<string, unknown>
        // 动作响应(echo 匹配)
        if (typeof obj.echo === 'string' && pending.has(obj.echo)) {
          const p = pending.get(obj.echo)!
          pending.delete(obj.echo)
          clearTimeout(p.timer)
          p.resolve(obj)
          return
        }
        // 事件
        if (obj.post_type === 'message' && obj.message_type === 'private') {
          const qq = String(obj.user_id ?? '')
          if (!qq) return
          // **跳过机器人自己发的消息(2026-08-12 修复"白名单私聊没有
          // 自主回复"根因)**:NapCat 会推送自己发出的消息事件(回复主人
          // 后 user_id = 机器人自身)——不跳过会被当"陌生人"消息覆盖
          // 待回复队列、注入"先问主人"前缀进对话,回复链路被污染
          if (qq === String(cfg().napcatBotQQ ?? BOT_QQ)) return
          // **不做白名单过滤(2026-08-12 二轮,用户要求"非白名单消息也
          // 进对话,LLM 问主人怎么回复")**:白名单判定移到 main.cjs
          // 分级——白名单 = 自主回复,非白名单 = 询问用户后再回
          // 去重(同一 message_id 只处理一次)
          const messageId = String(obj.message_id ?? '')
          if (messageId && messages.some((m) => m.messageId === messageId)) return
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
          if (messages.length > MAX_CACHE) messages.shift()
          receivedCount++
          if (text) {
            deps.notify?.(`QQ 消息(${qq})`, text.length > 50 ? text.slice(0, 50) + '…' : text)
          }
          deps.onMessage(msg)
        }
        // 群消息(2026-08-12,整合 Python 桥的群聊能力):群白名单过滤,
        // 提取文本 + @ 标记 → onGroupMessage(main.cjs 自主判断接话)
        if (obj.post_type === 'message' && obj.message_type === 'group') {
          const groupId = String(obj.group_id ?? '')
          const qq = String(obj.user_id ?? '')
          if (!groupId || !qq) return
          // 跳过机器人自己发的消息(防止自己接自己的话)
          if (qq === String(cfg().napcatBotQQ ?? BOT_QQ)) return
          const groups = cfg().napcatAllowedGroups ?? []
          if (groups.length > 0 && !groups.includes(groupId)) return
          const messageId = String(obj.message_id ?? '')
          if (messageId && groupSeen.has(messageId)) return
          groupSeen.add(messageId)
          if (groupSeen.size > 200) groupSeen.clear()
          const raw = obj.message ?? obj.raw_message
          const text = extractText(raw)
          const images = napcatMessageImages(raw)
          // @ 机器人检测(段数组里 at 段 qq = 机器人自身)
          const atMe = (Array.isArray(raw) ? raw : []).some(
            (seg: { type?: string; data?: Record<string, unknown> }) =>
              seg?.type === 'at' && String(seg.data?.qq ?? '') === String(BOT_QQ),
          )
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
          // 系统通知(2026-08-12 用户要求"群里有人回复必须做成系统通知,
          // 发了消息就直接告诉 LLM"):群消息到达即弹通知(内容预览)
          if (text) {
            deps.notify?.(
              `${msg.atMe ? '@鲸鱼娘 ' : ''}群消息(QQ ${qq})`,
              text.length > 50 ? text.slice(0, 50) + '…' : text,
            )
          }
          deps.onGroupMessage(msg)
        }
      }
      socket.onerror = () => {
        lastError = '连接错误(请确认 NapCat 已启动且 WS 端口开放)'
      }
      socket.onclose = () => {
        if (ws === socket) ws = null
        scheduleReconnect()
      }
    } catch (e) {
      lastError = (e as Error).message
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
  }

  /** 调 OneBot 动作(带 echo 等待响应);超时 reject */
  function callAction<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('NapCat 未连接(请确认 NapCat 已启动)'))
        return
      }
      const echo = `napcat-${++echoSeq}-${Math.random().toString(36).slice(2, 8)}`
      const timer = setTimeout(() => {
        pending.delete(echo)
        reject(new Error(`NapCat 动作 ${action} 超时`))
      }, ACTION_TIMEOUT_MS)
      // 泛型 T 经闭包收窄:Map 存 unknown,resolve 时断言
      pending.set(echo, { resolve: resolve as (v: unknown) => void, timer })
      try {
        ws.send(JSON.stringify({ action, params, echo }))
      } catch (e) {
        clearTimeout(timer)
        pending.delete(echo)
        reject(new Error(`NapCat 发送失败:${(e as Error).message}`))
      }
    })
  }

  /** 图片下载目录(userData/napcat-media/) */
  const mediaDir = () => path.join(userDataDir(), 'napcat-media')

  /** 下载图片(2026-08-12 收图链路):
   * ① file 缓存名(如 xxx.image)→ get_image 动作拿真实本地路径(优先);
   * ② 无 file 或转换失败 → url 直链 HTTP 下载;
   * ③ 复制到 userData/napcat-media/ 统一落点(带时间戳防重名)。
   * 全部失败返回 null(不阻断消息链路,对话只显示文本标注) */
  async function downloadImage(img: NapcatImage): Promise<string | null> {
    try {
      await fs.mkdir(mediaDir(), { recursive: true })
      let localPath = ''
      if (img.file) {
        try {
          const res = (await callAction<{ data?: { file?: string } }>('get_image', { file: img.file })) as {
            status?: string
            retcode?: number
            data?: { file?: string }
          }
          const p = res?.data?.file
          if (p && existsSync(p)) localPath = p
        } catch {
          // get_image 失败(缓存已过期等)走 url 下载
        }
      }
      if (!localPath && img.file && existsSync(img.file)) localPath = img.file
      if (!localPath && img.url) {
        try {
          const resp = await fetch(img.url)
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer())
            const ct = String(resp.headers.get('content-type') ?? '')
            const ext = /image\/(png|jpe?g|gif|webp|bmp)/.exec(ct)?.[1]?.replace('jpeg', 'jpg') ?? 'jpg'
            localPath = path.join(mediaDir(), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
            await fs.writeFile(localPath, buf)
            return localPath
          }
        } catch {
          // 下载失败
        }
      }
      if (!localPath) return null
      const ext = path.extname(localPath) || '.img'
      const dest = path.join(mediaDir(), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
      await fs.copyFile(localPath, dest)
      return dest
    } catch {
      return null
    }
  }

  return {
    /** 下载消息里的图片段 → 本地路径列表(2026-08-12 收图链路) */
    async downloadImages(images?: NapcatImage[]): Promise<string[]> {
      if (!images || images.length === 0) return []
      const out: string[] = []
      for (const img of images) {
        const p = await downloadImage(img)
        if (p) out.push(p)
      }
      return out
    },
    /** 备份一条聊天记录(2026-08-12:工具记忆原始层,消息到达自动调用) */
    appendChat(record: Omit<NapcatChatRecord, 'time'> & { time?: number }) {
      appendNapcatChat({
        ...record,
        time: record.time ?? Math.floor(Date.now() / 1000),
      })
    },
    start() {
      stopped = false
      connect()
    },
    stop() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      for (const [, p] of pending) clearTimeout(p.timer)
      pending.clear()
      try {
        ws?.close()
      } catch {
        // 已关闭
      }
      ws = null
    },
    /** 给指定 QQ 发私聊消息(回复用户);返回 message_id。
     * image 可选(2026-08-12 发图链路):本地路径或 URL → 组装 image 段
     * 一并发送(文本 + 图);file 可选:upload_private_file 发文件本体 */
    async sendToQQ(qq: string, text: string, opts?: { image?: string; file?: string }): Promise<string> {
      const image = typeof opts?.image === 'string' && opts.image.trim() ? opts.image.trim() : ''
      const file = typeof opts?.file === 'string' && opts.file.trim() ? opts.file.trim() : ''
      if (!text.trim() && !image && !file) return ''
      if (file) {
        // 校验文件存在(与 send_group 同款)
        if (!existsSync(file)) {
          throw new Error(`文件不存在:${file}(send 的 file 需要本地绝对路径)`)
        }
        const up = (await callAction<{ status?: string; retcode?: number }>('upload_private_file', {
          user_id: qq,
          file,
          name: path.basename(file),
        })) as { status?: string; retcode?: number }
        if (up?.status !== 'ok' && up?.retcode !== 0) {
          throw new Error(`文件上传失败(${up?.retcode ?? '未知'})`)
        }
      }
      // 组装消息段:文本 + 图片(本地路径/URL 校验存在)
      let message: unknown = text
      if (image) {
        if (!/^https?:|^data:image\//.test(image) && !existsSync(image)) {
          throw new Error(`图片不存在:${image}(image 需要本地绝对路径或 http(s) 链接)`)
        }
        const segs: unknown[] = []
        if (text.trim()) segs.push({ type: 'text', data: { text } })
        segs.push({ type: 'image', data: { file: image } })
        message = segs
      }
      const res = (await callAction<{ status?: string; data?: { message_id?: number } }>('send_private_msg', {
        user_id: qq,
        message,
      })) as { status?: string; retcode?: number; data?: { message_id?: number } }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`QQ 发送失败(${res?.retcode ?? '未知'})`)
      }
      const id = String(res?.data?.message_id ?? '')
      // 记录发出的消息(2026-08-12 撤回修复:自动回复/主动发送都走本方法,
      // 记下 message_id 后 LLM 经 sent action 查到即可撤回)
      recordSent({ messageId: id, type: 'private', target: qq, text: text.slice(0, 100) || '(图片/文件)' })
      repliedCount++
      return id
    },
    /** 联系人档案读写(2026-08-12):LLM 经 napcat 工具 contacts 操作 */
    async getContacts(): Promise<Record<string, NapcatContact>> {
      return loadNapcatContacts()
    },
    /** 聊天记录备份读取(2026-08-12:工具记忆的原始层,LLM 经 chats 查询) */
    async getChats(): Promise<NapcatChatRecord[]> {
      return loadNapcatChats()
    },
    /** 会话人格(2026-08-12:不同会话不同人设,工具记忆持久化) */
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
    /** 给指定群发消息(群聊接话回复);返回 message_id。
     * filePath 可选(2026-08-12,用户要求"LLM 下载好群友提到的文件后
     * 直接调工具发群里"):带本地路径时**真正上传文件本体**——走
     * OneBot upload_group_file 动作(2026-08-12 二轮,用户指出"别甩
     * 本地路径文本":CQ:file 传路径有"只发路径"风险,且中文路径在
     * CQ 码里有 URL 编码坑——upload_group_file 的 file/name 是 JSON
     * 参数直传,中文文件名/路径无编码问题),文件上传后再发文字;
     * image 可选(2026-08-12 发图链路):本地路径/URL → 组装 image 段 */
    async sendToGroup(groupId: string, text: string, filePath?: string, image?: string): Promise<string> {
      const file = typeof filePath === 'string' && filePath.trim() ? filePath.trim() : ''
      const img = typeof image === 'string' && image.trim() ? image.trim() : ''
      if (!text.trim() && !file && !img) return ''
      if (file) {
        // 校验文件存在(不存在报错,LLM 可自纠路径)
        if (!existsSync(file)) {
          throw new Error(`文件不存在:${file}(send_group 的 file 需要本地绝对路径,如 D:/music/关羽之歌.mp3)`)
        }
        const up = (await callAction<{ status?: string; retcode?: number }>('upload_group_file', {
          group_id: groupId,
          file,
          name: path.basename(file),
        })) as { status?: string; retcode?: number }
        if (up?.status !== 'ok' && up?.retcode !== 0) {
          throw new Error(`群文件上传失败(${up?.retcode ?? '未知'})`)
        }
      }
      // 组装消息段:文本 + 图片(本地路径/URL 校验存在)
      let message: unknown = text
      if (img) {
        if (!/^https?:|^data:image\//.test(img) && !existsSync(img)) {
          throw new Error(`图片不存在:${img}(send_group 的 image 需要本地绝对路径或 http(s) 链接)`)
        }
        const segs: unknown[] = []
        if (text.trim()) segs.push({ type: 'text', data: { text } })
        segs.push({ type: 'image', data: { file: img } })
        message = segs
      }
      let messageId = ''
      if (text.trim() || img) {
        const res = (await callAction<{ status?: string; data?: { message_id?: number } }>('send_group_msg', {
          group_id: groupId,
          message,
        })) as { status?: string; retcode?: number; data?: { message_id?: number } }
        if (res?.status !== 'ok' && res?.retcode !== 0) {
          throw new Error(`群发送失败(${res?.retcode ?? '未知'})`)
        }
        messageId = String(res?.data?.message_id ?? '')
      }
      // 记录发出的消息(2026-08-12 撤回修复):群消息也留 message_id——
      // 原实现恒返回 'ok',工具回显的 message_id 是假的,LLM 无法撤回
      // 自己发的群消息;只发文件(upload_group_file 无 message_id)不记
      recordSent({ messageId, type: 'group', target: groupId, text: text.slice(0, 100) || '(图片/文件)' })
      repliedCount++
      return messageId
    },
    /** 撤回消息(2026-08-12 消息控制,私聊/群聊通用);返回 void */
    async recallMessage(messageId: string): Promise<void> {
      const res = (await callAction<{ status?: string; retcode?: number }>('delete_msg', {
        message_id: messageId,
      })) as { status?: string; retcode?: number }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`撤回失败(${res?.retcode ?? '未知'}——需要机器人有撤回权限)`)
      }
    },
    /** 群成员列表(2026-08-12 成员查询):get_group_member_list 原始返回 */
    async getGroupMembers(groupId: string): Promise<Array<{ user_id: string; nickname?: string; card?: string }>> {
      const res = (await callAction<{ data?: Array<Record<string, unknown>> }>('get_group_member_list', {
        group_id: groupId,
      })) as { status?: string; retcode?: number; data?: Array<Record<string, unknown>> }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`群成员列表获取失败(${res?.retcode ?? '未知'})`)
      }
      return (res?.data ?? []).map((m) => ({
        user_id: String(m.user_id ?? ''),
        nickname: m.nickname !== undefined ? String(m.nickname) : undefined,
        card: m.card !== undefined ? String(m.card) : undefined,
      }))
    },
    /** 好友列表(2026-08-12 成员查询):get_friend_list 原始返回 */
    async getFriendList(): Promise<Array<{ user_id: string; nickname?: string; remark?: string }>> {
      const res = (await callAction<{ data?: Array<Record<string, unknown>> }>('get_friend_list', {})) as {
        status?: string
        retcode?: number
        data?: Array<Record<string, unknown>>
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`好友列表获取失败(${res?.retcode ?? '未知'})`)
      }
      return (res?.data ?? []).map((m) => ({
        user_id: String(m.user_id ?? ''),
        nickname: m.nickname !== undefined ? String(m.nickname) : undefined,
        remark: m.remark !== undefined ? String(m.remark) : undefined,
      }))
    },
    /** 陌生人资料(2026-08-12 成员查询):get_stranger_info */
    async getStrangerInfo(qq: string): Promise<{ nickname?: string; age?: number; sex?: string }> {
      const res = (await callAction<{ data?: Record<string, unknown> }>('get_stranger_info', {
        user_id: qq,
      })) as { status?: string; retcode?: number; data?: Record<string, unknown> }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`资料查询失败(${res?.retcode ?? '未知'})`)
      }
      const d = res?.data ?? {}
      return {
        nickname: d.nickname !== undefined ? String(d.nickname) : undefined,
        age: typeof d.age === 'number' ? d.age : undefined,
        sex: d.sex !== undefined ? String(d.sex) : undefined,
      }
    },
    /** 群信息(2026-08-12 群管理):get_group_info */
    async getGroupInfo(groupId: string): Promise<{ groupName?: string; memberCount?: number }> {
      const res = (await callAction<{ data?: Record<string, unknown> }>('get_group_info', {
        group_id: groupId,
      })) as { status?: string; retcode?: number; data?: Record<string, unknown> }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`群信息获取失败(${res?.retcode ?? '未知'})`)
      }
      const d = res?.data ?? {}
      return {
        groupName: d.group_name !== undefined ? String(d.group_name) : undefined,
        memberCount: typeof d.member_count === 'number' ? d.member_count : undefined,
      }
    },
    /** 查看 QQ 空间动态(2026-08-12,用户要求"添加查看QQ动态的接口"):
     * NapCat 扩展 action 只有发说说(send_qzone_msg)/删说说
     * (delete_qzone_msg),**没有查看动态列表的接口**——自行实现:
     * ① get_cookies(domain=qzone.qq.com)拿登录 Cookie + bkn(CSRF
     * token,即 g_tk);② 直接调 QQ 空间 taotao emotion_cgi_msglist_v6
     * cgi 接口(带 Cookie/Referer/g_tk)拉说说列表。qq 缺省 = 主人
     * (MASTER_QQ,即用户自己的空间);查别人的公开空间传 qq 即可 */
    async getQzoneFeeds(
      qq: string,
      num: number,
    ): Promise<Array<{ tid: string; content: string; createTime: number; picnum: number; commentnum: number; likenum: number }>> {
      const res = (await callAction<{ cookies?: string; bkn?: string }>('get_cookies', { domain: 'qzone.qq.com' })) as {
        status?: string
        retcode?: number
        cookies?: string
        bkn?: string
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`QQ 空间 Cookie 获取失败(${res?.retcode ?? '未知'})`)
      }
      const cookies = String(res?.cookies ?? '')
      if (!cookies) throw new Error('QQ 空间 Cookie 为空(get_cookies 未返回——NapCat 版本可能过旧)')
      // bkn 优先(go-cqhttp 返回的 CSRF token = g_tk),缺失时从
      // p_skey/skey 现场计算兜底
      const gtk = String(res?.bkn ?? '') || gtkFromCookie(cookies)
      if (!gtk) throw new Error('无法计算 g_tk(get_cookies 未返回 bkn 且 cookie 无 p_skey/skey)')
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
    /** 禁言群成员(2026-08-12 群管理):duration 秒,0 = 解除禁言 */
    async setGroupBan(groupId: string, qq: string, durationSec: number): Promise<void> {
      const res = (await callAction<{ status?: string; retcode?: number }>('set_group_ban', {
        group_id: groupId,
        user_id: qq,
        duration: durationSec,
      })) as { status?: string; retcode?: number }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`禁言失败(${res?.retcode ?? '未知'}——需要管理员权限)`)
      }
    },
    /** 踢出群成员(2026-08-12 群管理) */
    async setGroupKick(groupId: string, qq: string): Promise<void> {
      const res = (await callAction<{ status?: string; retcode?: number }>('set_group_kick', {
        group_id: groupId,
        user_id: qq,
      })) as { status?: string; retcode?: number }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`踢人失败(${res?.retcode ?? '未知'}——需要管理员权限)`)
      }
    },
    /** 全员禁言(2026-08-12 群管理):enable = 开/关全员禁言 */
    async setGroupWholeBan(groupId: string, enable: boolean): Promise<void> {
      const res = (await callAction<{ status?: string; retcode?: number }>('set_group_whole_ban', {
        group_id: groupId,
        enable,
      })) as { status?: string; retcode?: number }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`全员禁言设置失败(${res?.retcode ?? '未知'}——需要管理员权限)`)
      }
    },
    /** 批量补联系人昵称(2026-08-12 成员查询自动填充):只补**缺失**
     * name 的条目(已有备注不覆盖——LLM 手动记录的备注优先),一次
     * 合并写盘(不逐条原子写) */
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
      } catch {
        // 档案填充失败忽略(不阻断查询)
      }
    },
    /** 标记某条消息已回复(回复落定后) */
    markReplied(messageId: string) {
      const m = messages.find((x) => x.messageId === messageId)
      if (m) m.replied = true
    },
    status(): NapcatStatus {
      return {
        connected: !!ws && ws.readyState === WebSocket.OPEN,
        url: cfg().napcatWsUrl?.trim() || DEFAULT_WS_URL,
        lastError,
        receivedCount,
        repliedCount,
        allowed: cfg().napcatAllowed ?? [],
        allowedGroups: cfg().napcatAllowedGroups ?? [],
      }
    },
    getRecentMessages(): NapcatMessage[] {
      return [...messages].reverse()
    },
    /** 机器人发出的消息记录(2026-08-12 撤回修复:带 message_id,供
     * recall 撤回;新记录在前) */
    getSentMessages(): NapcatSentMessage[] {
      return [...sentMessages].reverse()
    },
  }
}

export type NapcatClient = ReturnType<typeof createNapcatClient>

/**
 * napcat 工具(engine 注入 client 时注册):LLM 对话里查询连接状态 /
 * 查看最近收到的 QQ 消息 / 主动给 QQ 发消息。
 * 描述引导 LLM:QQ 消息自动回复走系统链路,本工具用于主动发消息与查状态。
 * 参数 = 引擎注入的窄接口(EngineDeps.napcat,只暴露工具用到的三个方法)
 */
export function createNapcatTools(client: {
  status(): NapcatStatus
  sendToQQ(qq: string, text: string, opts?: { image?: string; file?: string }): Promise<string>
  sendToGroup(groupId: string, text: string, filePath?: string, image?: string): Promise<string>
  getRecentMessages(): NapcatMessage[]
  getContacts(): Promise<Record<string, NapcatContact>>
  updateContact(patch: { qq: string; name?: string; info?: string; source?: 'private' | 'group' }): Promise<NapcatContact>
  getChats?(): Promise<NapcatChatRecord[]>
  getPersonas?(): Promise<Record<string, NapcatPersona>>
  setPersona?(scope: string, persona: string): Promise<NapcatPersona | null>
  recallMessage?(messageId: string): Promise<void>
  mergeContactNames?(entries: Array<{ qq: string; name?: string; source?: 'private' | 'group' }>): Promise<void>
  getGroupMembers?(groupId: string): Promise<Array<{ user_id: string; nickname?: string; card?: string }>>
  getFriendList?(): Promise<Array<{ user_id: string; nickname?: string; remark?: string }>>
  getStrangerInfo?(qq: string): Promise<{ nickname?: string; age?: number; sex?: string }>
  getGroupInfo?(groupId: string): Promise<{ groupName?: string; memberCount?: number }>
  setGroupBan?(groupId: string, qq: string, durationSec: number): Promise<void>
  setGroupKick?(groupId: string, qq: string): Promise<void>
  setGroupWholeBan?(groupId: string, enable: boolean): Promise<void>
  /** 机器人发出的消息记录(2026-08-12 撤回修复:sent action 查询) */
  getSentMessages?(): NapcatSentMessage[]
  /** QQ 空间动态列表(2026-08-12:zone action 查询,自行实现) */
  getQzoneFeeds?(
    qq: string,
    num: number,
  ): Promise<Array<{ tid: string; content: string; createTime: number; picnum: number; commentnum: number; likenum: number }>>
}): AgentTool[] {
  return [
    {
      name: 'napcat',
      description:
        'NapCat QQ 机器人(2026-08-12):查询连接状态 / 最近 QQ 消息 / **机器人发出的消息(带 ID 可撤回)** / 联系人档案 / **聊天记录备份(工具记忆)** / 主动发私聊或群消息 / **图片收发** / 群成员好友查询 / 撤回消息 / 群管理 / **查看 QQ 空间动态**。' +
        '**QQ 消息自动回复是系统链路**(收到私聊/群聊自动进入对话并回复——无需调用本工具);' +
        '**收到图片自动下载保存并进对话**(主人窗口可见图片,文本标注路径——无需本工具处理);' +
        '本工具适合:用户问"QQ 那边有消息吗""NapCat 连上没""之前和谁聊过什么""看看我的 QQ 动态"时查询;' +
        '**交流中认识新联系人/群成员时,用 contact_update 记录对方信息**(称呼/喜好/身份,方便下次交流);' +
        '或需要**主动**发消息时(action=send 私聊 / action=send_group 群聊)。' +
        'action=status 查连接与收发统计;action=recent 看最近收到的 QQ 消息;' +
        'action=sent 看**机器人发出的消息**(发送成功自动记录,带 message_id——发错想撤时先查这里拿 ID,再 recall 撤回);' +
        'action=contacts 查看联系人档案;action=contact_update 记录/更新联系人(qq 必填,name/info 可选,认识来源 source=private/group);' +
        'action=chats 查看**聊天记录备份**(工具记忆,全部私聊/群聊原始消息,可按 user_id 或 group_id 过滤);' +
        'action=persona 查看**会话人格**(不同会话不同人设:群聊一个、私聊一个,按 scope 存);' +
        'action=persona_set 设置会话人格(scope 必填,如 group:1045765371 或 private:1178821869,' +
        'persona = 该会话的人设/回复风格,整合该会话联系人的喜好与风格;persona 空串 = 删除该会话人格);' +
        'action=send 发私聊(user_id 必填,message 必填;**image 可选 = 图片本地路径或 http(s) 链接**——' +
        '把图片发给对方(文本+图一起发);**file 可选 = 本地文件路径**,私聊也能发文件);' +
        'action=send_group 发群消息(group_id 必填,message 必填,**image 可选同 send**,' +
        '**file 可选 = 本地文件路径**——**下载好群友要的文件后直接发到群里**,如 bili 下载完成的视频/音频);' +
        'action=recall 撤回消息(message_id 必填,私聊/群聊通用——**自己发错的消息先用 sent 查 ID 再撤**,收到撤别人的需要机器人有撤回权限);' +
        'action=zone 查看 **QQ 空间动态**(qq 可选 = 查看谁的动态,缺省主人自己的空间;num 可选 = 条数 1-20 缺省 10,' +
        '返回说说内容/时间/图片数/点赞评论数——用户问"QQ 动态""空间说说"时调用);' +
        'action=members 查**群成员列表**(group_id 必填——群里有谁、昵称是什么,自动补进联系人档案);' +
        'action=friends 查**好友列表**;action=profile 按 QQ 号查**陌生人资料**(user_id 必填,昵称/性别/年龄);' +
        'action=group_info 查群信息(group_id 必填,群名/人数);' +
        'action=group_manage 群管理(group_id 必填,op=ban 禁言(配 user_id + duration 秒,0=解除)/ kick 踢人(配 user_id)/ whole_ban 全员禁言(配 enable true/false))。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'status', 'recent', 'sent', 'contacts', 'contact_update', 'chats', 'persona', 'persona_set', 'send',
              'send_group', 'recall', 'zone', 'members', 'friends', 'profile', 'group_info', 'group_manage',
            ],
            description: '操作:status 连接 / recent 最近收到消息 / sent 机器人发出的消息(带 ID 可撤回) / contacts 联系人档案 / contact_update 记录联系人 / chats 聊天备份 / persona 会话人格 / persona_set 设置人格 / send 发私聊 / send_group 发群消息 / recall 撤回消息 / zone 查看 QQ 空间动态 / members 群成员列表 / friends 好友列表 / profile 陌生人资料 / group_info 群信息 / group_manage 群管理',
          },
          user_id: { type: 'string', description: 'send:目标 QQ 号;chats:按 QQ 号过滤备份;profile:要查资料的 QQ 号;group_manage(ban/kick):目标成员 QQ 号' },
          group_id: { type: 'string', description: 'send_group:目标群号;chats:按群号过滤备份;members/group_info/group_manage:目标群号' },
          message: { type: 'string', description: 'send/send_group:要发送的消息文本' },
          image: {
            type: 'string',
            description:
              'send/send_group:要一并发送的图片(本地绝对路径或 http(s) 链接,如 bili 下载的封面/截图)' +
              '——文本+图片一起发;本地路径必须存在(报错可自纠)',
          },
          file: {
            type: 'string',
            description:
              'send/send_group:要一并发送的本地文件绝对路径(下载完成的文件直接发,如 D:/music/关羽之歌.mp3)。' +
              '走 upload_*_file **真正上传文件本体**,不是发路径文本;中文文件名/路径无编码问题',
          },
          message_id: { type: 'string', description: 'recall:要撤回的消息 ID——撤回**机器人自己发的**消息先从 sent 拿 ID;撤回收到的消息可从 recent/chats 拿' },
          qq: { type: 'string', description: 'contact_update:联系人 QQ 号(必填);zone:要查看谁的 QQ 空间动态(缺省 = 主人,即用户自己的空间)' },
          num: { type: 'number', description: 'zone:动态条数(1-20,缺省 10)' },
          name: { type: 'string', description: 'contact_update:备注名/群昵称' },
          info: { type: 'string', description: 'contact_update:已知信息(身份/喜好/关系等,一句话)' },
          source: { type: 'string', enum: ['private', 'group'], description: 'contact_update:认识来源(私聊/群聊)' },
          scope: { type: 'string', description: 'persona_set:会话范围,如 group:1045765371 / private:1178821869(必填)' },
          persona: { type: 'string', description: 'persona_set:该会话的人格/回复风格描述(整合联系人喜好;空串 = 删除)' },
          op: { type: 'string', enum: ['ban', 'kick', 'whole_ban'], description: 'group_manage:操作(ban 禁言 / kick 踢人 / whole_ban 全员禁言)' },
          duration: { type: 'number', description: 'group_manage ban:禁言时长(秒),0 = 解除禁言' },
          enable: { type: 'boolean', description: 'group_manage whole_ban:true 开启全员禁言 / false 关闭' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        if (action === 'status') {
          const s = client.status()
          return (
            `NapCat 状态:${s.connected ? '已连接' : '未连接'}(${s.url})` +
            (s.lastError ? `\n最近错误:${s.lastError}` : '') +
            `\n收到消息 ${s.receivedCount} 条,已回复 ${s.repliedCount} 条` +
            // 白名单诊断(2026-08-12:换群监听后新群收不到 = 群白名单
            // 没变,status 直接可见)
            // **主人恒为 MASTER_QQ 硬编码(2026-08-12 用户要求"主人永远
            // 只有 1178821869"):列表 = 扩展信任(额外可自主回复的 QQ),
            // 空列表 = 只回复主人,不再是"全部信任"——"(全部)"文案误导,
            // LLM 看到后可能把任意 QQ 当信任对象**
            `\n主人:${MASTER_QQ}(硬编码,唯一主人)` +
            `\n私聊扩展信任:${s.allowed && s.allowed.length > 0 ? s.allowed.join('、') : '(仅主人)'}` +
            `\n监听群:${s.allowedGroups && s.allowedGroups.length > 0 ? s.allowedGroups.join('、') : '(无)'}` +
            `\n(换群监听用 set_napcat_config 的 allowedGroups 参数)`
          )
        }
        if (action === 'recent') {
          const list = client.getRecentMessages()
          if (list.length === 0) return '(最近没有收到 QQ 消息)'
          return list
            .slice(0, 10)
            .map((m) => `- ${m.replied ? '[已回复]' : '[未回复]'} ${m.qq}(${new Date(m.time * 1000).toLocaleTimeString('zh-CN')}):${m.text.slice(0, 80)}`)
            .join('\n')
        }
        if (action === 'sent') {
          // 机器人发出的消息(2026-08-12 撤回修复:发送成功自动记录,
          // 带 message_id——发错想撤时先查这里拿 ID 再 recall)
          if (!client.getSentMessages) throw new Error('发出的消息记录不可用')
          const list = client.getSentMessages()
          if (list.length === 0) return '(机器人还没有发出过消息——主动发送或自动回复后自动记录)'
          return list
            .slice(0, 10)
            .map(
              (m) =>
                `- ${new Date(m.time * 1000).toLocaleString('zh-CN')} [${m.type === 'group' ? `群${m.target}` : `QQ${m.target}`}] ${(m.text || '(图片/文件)').slice(0, 60)}(message_id ${m.messageId}——要撤回就 recall 这个 ID)`,
            )
            .join('\n')
        }
        if (action === 'zone') {
          // 查看 QQ 空间动态(2026-08-12,用户要求"添加查看QQ动态的接口":
          // NapCat 无此 action,client 自行走 get_cookies + taotao cgi)
          if (!client.getQzoneFeeds) throw new Error('QQ 空间动态查询不可用')
          const qq = String(params.qq ?? '').trim()
          const num = params.num !== undefined ? Math.floor(Number(params.num)) : 10
          if (!Number.isFinite(num) || num < 1 || num > 20) throw new Error('zone 的 num 需要在 1-20 之间(条数)')
          // 缺省 = 主人自己的空间(用户问"看看我的 QQ 动态"最常查自己)
          const feeds = await client.getQzoneFeeds(qq || MASTER_QQ, num)
          if (feeds.length === 0) return `(QQ ${qq || MASTER_QQ} 的动态为空——还没有说说,或空间对当前登录账号不可见)`
          return (
            `QQ ${qq || MASTER_QQ} 的最近动态(${feeds.length} 条):\n` +
            feeds
              .map(
                (f, i) =>
                  `${i + 1}. ${new Date(f.createTime * 1000).toLocaleString('zh-CN')} ${(f.content || '(无文字)').slice(0, 100)}` +
                  `${f.picnum > 0 ? ` [图片×${f.picnum}]` : ''}${f.likenum > 0 ? ` 👍${f.likenum}` : ''}${f.commentnum > 0 ? ` 💬${f.commentnum}` : ''}`,
              )
              .join('\n')
          )
        }
        if (action === 'contacts') {
          const contacts = await client.getContacts()
          const list = Object.values(contacts)
          if (list.length === 0) return '(联系人档案为空——交流中认识新联系人时可用 contact_update 记录)'
          return list
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((c) => `- ${c.qq}${c.name ? `(${c.name})` : ''}${c.info ? `: ${c.info}` : ''}${c.source === 'group' ? ' [群聊]' : ' [私聊]'}`)
            .join('\n')
        }
        if (action === 'chats') {
          if (!client.getChats) return '(聊天记录备份不可用)'
          const chats = await client.getChats()
          const qqFilter = String(params.user_id ?? '').trim()
          const groupFilter = String(params.group_id ?? '').trim()
          let list = chats
          if (qqFilter) list = list.filter((c) => c.type === 'private' && c.target === qqFilter)
          if (groupFilter) list = list.filter((c) => c.type === 'group' && c.target === groupFilter)
          if (list.length === 0) {
            return '(聊天记录备份为空' + (qqFilter || groupFilter ? `(按 ${qqFilter || groupFilter} 过滤)` : '') + '——有 QQ 消息后自动备份)'
          }
          return list
            .slice(-20)
            .map(
              (c) =>
                `- ${new Date(c.time * 1000).toLocaleString('zh-CN')} [${c.type === 'group' ? `群${c.target}` : `QQ${c.target}`}] ${c.qq}: ${c.text.slice(0, 80)}${c.atMe ? ' (@鲸鱼娘)' : ''}`,
            )
            .join('\n')
        }
        if (action === 'contact_update') {
          const qq = String(params.qq ?? '').trim()
          if (!qq) throw new Error('contact_update 需要 qq(联系人 QQ 号)')
          const c = await client.updateContact({
            qq,
            name: params.name !== undefined ? String(params.name) : undefined,
            info: params.info !== undefined ? String(params.info) : undefined,
            source: params.source === 'group' ? 'group' : 'private',
          })
          return `已记录联系人 ${c.qq}${c.name ? `(${c.name})` : ''}${c.info ? `: ${c.info}` : ''}`
        }
        if (action === 'send') {
          const qq = String(params.user_id ?? '').trim()
          if (!qq) throw new Error('send 需要 user_id(目标 QQ 号)')
          const text = String(params.message ?? '').trim()
          const image = String(params.image ?? '').trim()
          const file = String(params.file ?? '').trim()
          if (!text && !image && !file) throw new Error('send 需要 message(消息文本)、image(图片)或 file(文件)至少一个')
          // 图片路径校验(2026-08-12 发图链路,工具层先校验——LLM 拿错
          // 路径即时自纠,不用等 client 发送失败)
          if (image && !/^https?:|^data:image\//.test(image) && !existsSync(image)) {
            throw new Error(`图片不存在:${image}(image 需要本地绝对路径或 http(s) 链接)`)
          }
          const id = await client.sendToQQ(qq, text, { image: image || undefined, file: file || undefined })
          return `已通过 QQ 发送给 ${qq}(message_id ${id}${image ? ',含图片' : ''}${file ? ',含文件' : ''})`
        }
        if (action === 'persona') {
          if (!client.getPersonas) return '(会话人格不可用)'
          const personas = await client.getPersonas()
          const list = Object.entries(personas)
          if (list.length === 0) {
            return '(未设置会话人格——不同会话(群聊/私聊)可各设一个人设,用 persona_set 设置)'
          }
          return list
            .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
            .map(([scope, p]) => `- ${scope}: ${p.persona}`)
            .join('\n')
        }
        if (action === 'persona_set') {
          if (!client.setPersona) throw new Error('会话人格不可用')
          const scope = String(params.scope ?? '').trim()
          if (!/^(private|group):[0-9]+$/.test(scope)) {
            throw new Error('scope 需要是 private:<QQ号> 或 group:<群号>(如 group:1045765371)')
          }
          const persona = String(params.persona ?? '').trim()
          const next = await client.setPersona(scope, persona)
          if (!next) return `已删除会话 ${scope} 的人格(恢复默认)`
          return `已设置会话 ${scope} 的人格:「${next.persona}」——之后该会话的消息回复按此人格`
        }
        if (action === 'send_group') {
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('send_group 需要 group_id(目标群号)')
          const text = String(params.message ?? '').trim()
          const file = String(params.file ?? '').trim()
          const image = String(params.image ?? '').trim()
          if (!text && !file && !image) throw new Error('send_group 需要 message、file 或 image(至少一个)')
          if (image && !/^https?:|^data:image\//.test(image) && !existsSync(image)) {
            throw new Error(`图片不存在:${image}(send_group 的 image 需要本地绝对路径或 http(s) 链接)`)
          }
          const id = await client.sendToGroup(groupId, text, file || undefined, image || undefined)
          return `已发送到群 ${groupId}${file ? '(含文件)' : ''}${image ? '(含图片)' : ''}(message_id ${id})`
        }
        if (action === 'recall') {
          if (!client.recallMessage) throw new Error('撤回消息不可用')
          const messageId = String(params.message_id ?? '').trim()
          if (!messageId) throw new Error('recall 需要 message_id(要撤回的消息 ID,可从 recent/chats 拿到)')
          await client.recallMessage(messageId)
          return `已撤回消息 ${messageId}`
        }
        if (action === 'members') {
          if (!client.getGroupMembers) throw new Error('群成员查询不可用')
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('members 需要 group_id(目标群号)')
          const members = await client.getGroupMembers(groupId)
          if (members.length === 0) return '(群成员列表为空)'
          // **自动补联系人档案昵称(2026-08-12 用户要求"读取并记忆群成员
          // 信息")**:缺失备注的成员自动填昵称(群名片优先),一次性合并
          // 写盘(不覆盖 LLM 手动记录的备注);失败静默不阻断查询
          if (client.mergeContactNames) {
            void client.mergeContactNames(
              members.map((m) => ({ qq: m.user_id, name: m.card || m.nickname, source: 'group' as const })),
            )
          }
          return members
            .slice(0, 200)
            .map((m) => `- ${m.user_id}${m.card || m.nickname ? `(${m.card || m.nickname})` : ''}`)
            .join('\n')
        }
        if (action === 'friends') {
          if (!client.getFriendList) throw new Error('好友列表不可用')
          const list = await client.getFriendList()
          if (list.length === 0) return '(好友列表为空)'
          return list
            .slice(0, 200)
            .map((m) => `- ${m.user_id}${m.remark || m.nickname ? `(${m.remark || m.nickname})` : ''}`)
            .join('\n')
        }
        if (action === 'profile') {
          if (!client.getStrangerInfo) throw new Error('资料查询不可用')
          const qq = String(params.user_id ?? '').trim()
          if (!qq) throw new Error('profile 需要 user_id(要查资料的 QQ 号)')
          const p = await client.getStrangerInfo(qq)
          return `QQ ${qq} 的资料:${p.nickname ? `昵称 ${p.nickname}` : '无昵称'}${p.sex ? `,性别 ${p.sex}` : ''}${p.age !== undefined ? `,年龄 ${p.age}` : ''}`
        }
        if (action === 'group_info') {
          if (!client.getGroupInfo) throw new Error('群信息查询不可用')
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('group_info 需要 group_id(目标群号)')
          const g = await client.getGroupInfo(groupId)
          return `群 ${groupId}:${g.groupName ? `群名「${g.groupName}」` : '群名未知'}${g.memberCount !== undefined ? `,成员 ${g.memberCount} 人` : ''}`
        }
        if (action === 'group_manage') {
          if (!client.setGroupBan || !client.setGroupKick || !client.setGroupWholeBan) throw new Error('群管理不可用')
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('group_manage 需要 group_id(目标群号)')
          const op = String(params.op ?? '').trim()
          if (!op) throw new Error('group_manage 需要 op(ban / kick / whole_ban)')
          if (op === 'ban') {
            const qq = String(params.user_id ?? '').trim()
            if (!qq) throw new Error('group_manage ban 需要 user_id(被禁言成员 QQ 号)')
            const duration = params.duration !== undefined ? Number(params.duration) : NaN
            if (!Number.isFinite(duration) || duration < 0) throw new Error('group_manage ban 需要 duration(禁言秒数,0 = 解除禁言)')
            await client.setGroupBan(groupId, qq, Math.floor(duration))
            return duration === 0 ? `已解除 ${qq} 在群 ${groupId} 的禁言` : `已禁言 ${qq}(群 ${groupId},${Math.floor(duration)} 秒)`
          }
          if (op === 'kick') {
            const qq = String(params.user_id ?? '').trim()
            if (!qq) throw new Error('group_manage kick 需要 user_id(被踢成员 QQ 号)')
            await client.setGroupKick(groupId, qq)
            return `已把 ${qq} 移出群 ${groupId}`
          }
          if (op === 'whole_ban') {
            if (typeof params.enable !== 'boolean') throw new Error('group_manage whole_ban 需要 enable(true = 全员禁言 / false = 解除)')
            await client.setGroupWholeBan(groupId, params.enable)
            return params.enable ? `已在群 ${groupId} 开启全员禁言` : `已解除群 ${groupId} 的全员禁言`
          }
          throw new Error('group_manage 的 op 仅支持 ban / kick / whole_ban')
        }
        throw new Error('action 仅支持 status/recent/sent/contacts/contact_update/chats/persona/persona_set/send/send_group/recall/zone/members/friends/profile/group_info/group_manage')
      },
    },
  ]
}

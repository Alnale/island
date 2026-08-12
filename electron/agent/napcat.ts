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
  /** 动作调用:echo → resolve(等待响应;泛型经闭包转换) */
  const pending = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
  let echoSeq = 0

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
          const text = extractText(obj.message ?? obj.raw_message)
          const msg: NapcatMessage = {
            qq,
            text,
            messageId,
            time: Number(obj.time ?? Math.floor(Date.now() / 1000)),
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
          const text = extractText(obj.message ?? obj.raw_message)
          // @ 机器人检测(段数组里 at 段 qq = 机器人自身)
          const atMe = (Array.isArray(obj.message) ? obj.message : []).some(
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

  return {
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
    /** 给指定 QQ 发私聊消息(回复用户);返回 message_id */
    async sendToQQ(qq: string, text: string): Promise<string> {
      if (!text.trim()) return ''
      const res = (await callAction<{ status?: string; data?: { message_id?: number } }>('send_private_msg', {
        user_id: qq,
        message: text,
      })) as { status?: string; retcode?: number; data?: { message_id?: number } }
      if (res?.status !== 'ok' && res?.retcode !== 0) {
        throw new Error(`QQ 发送失败(${res?.retcode ?? '未知'})`)
      }
      repliedCount++
      return String(res?.data?.message_id ?? '')
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
     * 参数直传,中文文件名/路径无编码问题),文件上传后再发文字 */
    async sendToGroup(groupId: string, text: string, filePath?: string): Promise<string> {
      const file = typeof filePath === 'string' && filePath.trim() ? filePath.trim() : ''
      if (!text.trim() && !file) return ''
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
      if (text.trim()) {
        const res = (await callAction<{ status?: string; data?: { message_id?: number } }>('send_group_msg', {
          group_id: groupId,
          message: text,
        })) as { status?: string; retcode?: number; data?: { message_id?: number } }
        if (res?.status !== 'ok' && res?.retcode !== 0) {
          throw new Error(`群发送失败(${res?.retcode ?? '未知'})`)
        }
      }
      repliedCount++
      return 'ok'
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
      }
    },
    getRecentMessages(): NapcatMessage[] {
      return [...messages].reverse()
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
  sendToQQ(qq: string, text: string): Promise<string>
  sendToGroup(groupId: string, text: string, filePath?: string): Promise<string>
  getRecentMessages(): NapcatMessage[]
  getContacts(): Promise<Record<string, NapcatContact>>
  updateContact(patch: { qq: string; name?: string; info?: string; source?: 'private' | 'group' }): Promise<NapcatContact>
  getChats?(): Promise<NapcatChatRecord[]>
  getPersonas?(): Promise<Record<string, NapcatPersona>>
  setPersona?(scope: string, persona: string): Promise<NapcatPersona | null>
}): AgentTool[] {
  return [
    {
      name: 'napcat',
      description:
        'NapCat QQ 机器人(2026-08-12):查询连接状态 / 最近 QQ 消息 / 联系人档案 / **聊天记录备份(工具记忆)** / 主动发私聊或群消息。' +
        '**QQ 消息自动回复是系统链路**(收到私聊/群聊自动进入对话并回复——无需调用本工具);' +
        '本工具适合:用户问"QQ 那边有消息吗""NapCat 连上没""之前和谁聊过什么"时查询;' +
        '**交流中认识新联系人/群成员时,用 contact_update 记录对方信息**(称呼/喜好/身份,方便下次交流);' +
        '或需要**主动**发消息时(action=send 私聊 / action=send_group 群聊)。' +
        'action=status 查连接与收发统计;action=recent 看最近收到的 QQ 消息;' +
        'action=contacts 查看联系人档案;action=contact_update 记录/更新联系人(qq 必填,name/info 可选,认识来源 source=private/group);' +
        'action=chats 查看**聊天记录备份**(工具记忆,全部私聊/群聊原始消息,可按 user_id 或 group_id 过滤);' +
        'action=persona 查看**会话人格**(不同会话不同人设:群聊一个、私聊一个,按 scope 存);' +
        'action=persona_set 设置会话人格(scope 必填,如 group:1045765371 或 private:1178821869,' +
        'persona = 该会话的人设/回复风格,整合该会话联系人的喜好与风格;persona 空串 = 删除该会话人格);' +
        'action=send 发私聊(user_id 必填,message 必填);' +
        'action=send_group 发群消息(group_id 必填,message 必填,**file 可选 = 本地文件路径**——' +
        '**下载好群友要的文件后直接发到群里**,如 bili 下载完成的视频/音频)。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'recent', 'contacts', 'contact_update', 'chats', 'persona', 'persona_set', 'send', 'send_group'],
            description: '操作:status 查询连接 / recent 最近 QQ 消息 / contacts 联系人档案 / contact_update 记录联系人 / chats 聊天记录备份 / persona 会话人格 / persona_set 设置会话人格 / send 发私聊 / send_group 发群消息',
          },
          user_id: { type: 'string', description: 'send:目标 QQ 号;chats:按 QQ 号过滤备份' },
          group_id: { type: 'string', description: 'send_group:目标群号;chats:按群号过滤备份' },
          message: { type: 'string', description: 'send/send_group:要发送的消息文本' },
          file: {
            type: 'string',
            description:
              'send_group:要一并发送的本地文件绝对路径(下载完成的文件直接发群里,如 D:/music/关羽之歌.mp3)。' +
              '走 upload_group_file **真正上传文件本体**,不是发路径文本;中文文件名/路径无编码问题',
          },
          qq: { type: 'string', description: 'contact_update:联系人 QQ 号(必填)' },
          name: { type: 'string', description: 'contact_update:备注名/群昵称' },
          info: { type: 'string', description: 'contact_update:已知信息(身份/喜好/关系等,一句话)' },
          source: { type: 'string', enum: ['private', 'group'], description: 'contact_update:认识来源(私聊/群聊)' },
          scope: { type: 'string', description: 'persona_set:会话范围,如 group:1045765371 / private:1178821869(必填)' },
          persona: { type: 'string', description: 'persona_set:该会话的人格/回复风格描述(整合联系人喜好;空串 = 删除)' },
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
            `\n收到消息 ${s.receivedCount} 条,已回复 ${s.repliedCount} 条`
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
          if (!text) throw new Error('send 需要 message(消息文本)')
          const id = await client.sendToQQ(qq, text)
          return `已通过 QQ 发送给 ${qq}(message_id ${id})`
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
          if (!text && !file) throw new Error('send_group 需要 message 或 file(至少一个)')
          const id = await client.sendToGroup(groupId, text, file || undefined)
          return `已发送到群 ${groupId}${file ? '(含文件)' : ''}(message_id ${id})`
        }
        throw new Error('action 仅支持 status/recent/contacts/contact_update/send/send_group')
      },
    },
  ]
}

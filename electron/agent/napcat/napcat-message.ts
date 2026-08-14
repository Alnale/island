/**
 * NapCat 消息解析(纯函数簇 + 消息类型)
 *
 * 2026-08-14 插件化五期从 napcat.ts 拆出:OneBot 消息段文本化(CQ码与
 * 段数组双形态)、图片段提取、CQ 码 @ 判定——全部纯函数,无 IO/无状态;
 * 消息类型定义随函数同迁。napcat.ts barrel 兼容 re-export,
 * engine.ts/main.cjs 既有导入路径不变。
 */

// ---- 消息段文本化 ----
/** OneBot 消息 → 文本(兼容 string 与段数组;测试用导出):text 段拼接,
 * face/emoji 标注,@ 段标注(机器人自身 = @鲸鱼娘),其它段(图片/语音/视频等)标注类型 */
export function napcatMessageText(msg: unknown, botQQ?: string): string {
  if (typeof msg === 'string') {
    // CQ码字符串消息:处理CQ:at
    return msg.replace(/\[CQ:at,qq=(\d+)(?:,name=([^\]]*))?\]/g, (_m, qq: string, name?: string) => {
      return String(qq) === String(botQQ ?? '') ? '@鲸鱼娘' : `@${name || qq}`
    }).replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
      .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
      .replace(/\[CQ:forward[^\]]*\]/g, '[转发消息]')
      .replace(/\[CQ:reply[^\]]*\]/g, '[回复]')
      .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:[a-z]+[^\]]*\]/g, (m) => `[${m.slice(4, -1).split(',')[0]}]`)
  }
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
        if (s?.type === 'record') return '[语音]'
        if (s?.type === 'video') return '[视频]'
        if (s?.type === 'forward') return '[转发消息]'
        if (s?.type === 'reply') return '[回复]'
        return `[${s.type ?? 'segment'}]`
      })
      .join('')
  }
  return String(msg ?? '')
}

// ---- 类型定义 ----
/** 收到的 QQ 消息(私聊) */
export interface NapcatMessage {
  qq: string
  text: string
  messageId: string
  time: number
  replied?: boolean
  images?: NapcatImage[]
}

/** 收到的群消息 */
export interface NapcatGroupMessage {
  groupId: string
  qq: string
  text: string
  atMe: boolean
  messageId: string
  time: number
  images?: NapcatImage[]
}

/** 消息中的图片段 */
export interface NapcatImage {
  file?: string
  url?: string
}

/** 机器人发出的消息 */
export interface NapcatSentMessage {
  messageId: string
  type: 'private' | 'group'
  target: string
  text: string
  time: number
}

/** 提取消息中的图片段 */
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

/** 检测CQ码字符串消息中的atMe(段数组已在napcatMessageText处理,这里单独检测) */
export function cqAtMe(raw: unknown, botQQ: string): boolean {
  if (typeof raw === 'string') {
    return new RegExp(`\\[CQ:at,qq=${botQQ}(?:,|\\])`).test(raw)
  }
  return false
}

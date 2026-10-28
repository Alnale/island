/**
 * NapCat 出站文本清洗(纯函数簇)
 *
 * 2026-08-14 插件化四期从 napcat.ts 拆出:发往 QQ 前的文本处理——
 * 工具叙述句/主人视角叙述句剥离、夹带图片引用提取、思考腔开头剥离、
 * QQ空间 g_tk 计算。全部纯函数,无 IO/无状态。
 */

import { BOT_SELF_NAMES } from './napcat-session'

// ---- QQ空间 g_tk 计算 ----
export function gtkFromCookie(cookie: string): string {
  const m = /p_skey=([^;]+)/.exec(cookie) ?? /skey=([^;]+)/.exec(cookie)
  if (!m) return ''
  let hash = 5381
  for (let i = 0; i < m[1].length; i++) hash += (hash << 5) + m[1].charCodeAt(i)
  return String(hash & 0x7fffffff)
}

// ---- 文本清洗函数 ----
/** 工具调用叙述句剥离(对外人不暴露内部工作流) */
const TOOL_NARRATION_ACTION =
  /(我去|我来|我直接|我先|我再|我换|我细看|我用|我基于|我拿到|拿到|我找到|找到|拿到了|发现|定位|我挖|我探|我绘|我调用|我搜|我开|我拼|我测|我下载|我解析|我查|探测|拼接|绘制|下载|解析|抓取|爬取|请求|接口是|接口走)/
const TOOL_NARRATION_WORD =
  /(接口|API|api|数据源|数据端点|端点|路径|域名|JS|脚本|命令|直播间|URL|网址|matplotlib|环境|胜率曲线|曲线|cookies|二维码|数据库|服务器|fetch|请求|响应|解析|网页|抓|爬|绘图|拼接|打开网页|打开浏览器|数据)/
export function stripToolNarration(text: string): string {
  const t = String(text ?? '').trim()
  if (!t) return t
  const sentences = t.split(/(?<=[。！？!?\n])/).map((s) => s.replace(/^[^\S\n]*/, ''))
  if (sentences.length < 2) return t
  const isNarration = (s: string) => TOOL_NARRATION_ACTION.test(s) && TOOL_NARRATION_WORD.test(s)
  const flags = sentences.map(isNarration)
  const keep: string[] = []
  let i = 0
  while (i < sentences.length) {
    if (flags[i]) {
      let j = i
      while (j < sentences.length && flags[j]) j++
      if (j - i >= 2) {
        i = j
        continue
      }
    }
    keep.push(sentences[i])
    i++
  }
  const out = keep.join('').trim()
  return out || t
}

/** 主人视角叙述句剥离(「展示给你看」「他回你了」不外发) */
const MASTER_NARRATION_RE =
  /(他|她)(回你|回我|发来|发的是|发了|在回|回应)|(回你|回你了|发来)|(给你看|展示给|展示在|先展示)|(窗口里|你可以看看)|(识别一下|识别出来|临时文件|清理掉|清理了|顺便把)/
export function stripMasterNarration(text: string): string {
  const t = String(text ?? '').trim()
  if (!t) return t
  const sentences = t.split(/(?<=[。！？!?\n])/).map((s) => s.replace(/^[^\S\n]*/, ''))
  if (sentences.length < 2) return t
  const flags = sentences.map((s) => MASTER_NARRATION_RE.test(s))
  const keep: string[] = []
  let i = 0
  while (i < sentences.length) {
    if (flags[i]) {
      let j = i
      while (j < sentences.length && flags[j]) j++
      if (j - i >= 2) {
        i = j
        continue
      }
    }
    keep.push(sentences[i])
    i++
  }
  const out = keep.join('').trim()
  if (out) return out
  const quoted = /回(他|她|对方)[^。！？!?\n]{0,20}[「"“]([\s\S]{2,120}?)[」"”]/.exec(t)
  if (quoted && quoted[2].trim()) return quoted[2].trim()
  return t
}

/** 从文本中提取夹带的图片路径/URL(用于发图兜底)
 * 加强边界条件:必须在行首/空白/引号/括号之后,避免"C盘的那个.png我看过了"误提取 */
export function extractImageRefs(text: string): { text: string; images: string[] } {
  const images: string[] = []
  // 路径前必须是空白、引号、括号、中文标点或行首,避免在句子中间误匹配
  const cleaned = String(text ?? '').replace(
    /(^|[\s，,。;；!！?？"'“”‘’【】(（)）>》])((?:[A-Za-z]:[\\/]|https?:\/\/)[^\s，,。;；!！?？"'“”‘’【】()（）<>《》]+\.(?:png|jpe?g|gif|webp|bmp)(?:[?#&][^\s，,。;；!！"'“”‘’【】()（）<>《》？]*)?)/gi,
    (_m, prefix: string, p: string) => {
      images.push(p)
      return prefix
    },
  )
  return { text: cleaned.replace(/\(\)|（）|\[]|【】/g, '').replace(/\s+/g, ' ').trim(), images }
}

// ---- 出站消息段组装(纯函数;2026-09-22 加 record 语音段) ----
export interface OutgoingSeg {
  type: string
  data: Record<string, unknown>
}

/**
 * 去掉群回复里艾特机器人自己的写法。
 * 模型会把提示词里的 @岛灵 / @鲸鱼娘,或自己的 QQ、CQ 码 at,抄进正文;
 * QQ 会把这些显示成艾特自己。只删 @ 这一下,句子里的自称留着。
 * extraNames = 自己发出的群消息上见过的群名片、昵称。
 */
export function stripSelfMentions(text: string, selfQQ?: string | null, extraNames?: readonly string[]): string {
  let t = String(text ?? '')
  if (!t) return t
  const self = String(selfQQ ?? '').trim()
  if (/^\d{5,12}$/.test(self)) {
    t = t.replace(new RegExp(`\\[CQ:at,qq=${self}(?:,[^\\]]*)?\\]`, 'g'), '')
    t = t.replace(new RegExp(`(?<![0-9])[@＠]\\s*${self}(?![0-9])`, 'g'), '')
  }
  const names = [...BOT_SELF_NAMES, ...(extraNames ?? [])]
    .map((n) => String(n ?? '').trim())
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length)
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp(`[@＠]\\s*${escaped}`, 'g'), '')
  }
  return t
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[，,、\s]+/, '')
    .replace(/[，,、\s]+$/, '')
    .trim()
}

/** 艾特名单里去掉机器人自己。at=all 保留。 */
export function withoutSelfAt(
  at: string | string[] | undefined,
  selfQQ?: string | null,
): string | string[] | undefined {
  const self = String(selfQQ ?? '').trim()
  const list = (Array.isArray(at) ? at : at ? [at] : [])
    .map((x) => String(x ?? '').trim())
    .filter((x) => x && x !== self)
  if (list.length === 0) return undefined
  return list.length === 1 ? list[0] : list
}

/**
 * 组装 OneBot 11 出站消息:纯文本 → 字符串;含图/语音/@/引用 → 段数组
 * (reply 段在最前 → at 段 → text 段 → image 段 → record 段;
 * record.data.file = 路径/URL/base64,NapCat 侧自动转 QQ silk 语音编码)。
 * selfQQ 给了就把艾特自己的段丢掉。纯函数,单测钉段形状。
 */
export function buildOutgoingMessage(
  text: string,
  images: string[],
  voice?: string,
  extra?: { at?: string | string[]; replyTo?: string; selfQQ?: string },
): string | OutgoingSeg[] {
  const v = typeof voice === 'string' && voice.trim() ? voice.trim() : ''
  const replyTo = typeof extra?.replyTo === 'string' ? extra.replyTo.trim() : ''
  const rawAt = withoutSelfAt(extra?.at, extra?.selfQQ)
  const ats = (Array.isArray(rawAt) ? rawAt : rawAt ? [rawAt] : [])
    .map((x) => String(x ?? '').trim())
    .filter((x) => x && (x === 'all' || /^\d+$/.test(x)))
    .slice(0, 10)
  if (images.length === 0 && !v && !replyTo && ats.length === 0) return text
  const segs: OutgoingSeg[] = []
  if (replyTo) segs.push({ type: 'reply', data: { id: replyTo } })
  for (const qq of ats) segs.push({ type: 'at', data: { qq } })
  if (text) segs.push({ type: 'text', data: { text } })
  for (const img of images) segs.push({ type: 'image', data: { file: img } })
  if (v) segs.push({ type: 'record', data: { file: v } })
  return segs
}

/** 合并转发节点(gocq 标准 uin/name/content) */
export interface OutgoingForwardNode {
  type: 'node'
  data: { uin: string; name: string; content: string | OutgoingSeg[] }
}

/** 文本列表 → 合并转发节点(2026-10-25:napcat forward send) */
export function buildForwardNodes(
  texts: string[],
  botQQ: string,
  botName = '岛灵',
): OutgoingForwardNode[] {
  return texts
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((t) => ({
      type: 'node' as const,
      data: { uin: String(botQQ || '0'), name: botName, content: t },
    }))
}

/** 内部独白/思维链泄漏**疑似**粗筛(2026-08-17):只返回是否疑似,**
 * 不删除任何内容**——真正判定交给 main.cjs 的审核 Sub Agent
 * (ReplyIntentClassifier.judgeMonologue,见 subagents.ts)。正则宽召回
 * (宁可多调一次审核也不误删):疑似命中才调审核,非疑似零成本放行。
 * 特征 = 内部自我分析标记(话题收尾/这段聊得/我就不主动打扰/他没再提),
 * 对应 LLM 思考模式把思维链写进正文而非 reasoning_content 的偶发形态 */
export function isSuspectedMonologue(text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t) return false
  return /话题收尾|这段聊得|这轮聊得|刚才聊得|我就不主动打扰(?![你])|没再提别的要求|没再提其它|没再提其他|对方没再提|看来[他她]|我决定不|打算不再/.test(t)
}

/*** 思考腔开头剥离 */
const THINK_LEAD =
  /^(好的|好|嗯|嗯嗯|OK|ok|okay|可以的|可以|没问题|收到|明白了|行|行吧)[,，、\s]*(让我|我先|我|让我来|我来)先?(分析|梳理|思考|想想|整理|回顾|总结|看一下|看看|确认|理一下|查一下|研究)/
const THINK_START = /^(让我|我先|我(来)?|容我)先?(分析|梳理|思考|想想|整理|回顾|总结|看一下|看看|理一下)/
export function stripThinkingPreamble(text: string): string {
  const t = String(text ?? '').trim()
  if (!t) return t
  const m = /^([\s\S]*?[。！？!?\n:：])/.exec(t)
  if (!m) return t
  const head = m[1]
  if (head.length > 40) return t
  const headTrimmed = head.replace(/[。！？!?\n:：]+$/, '').trim()
  if (!headTrimmed) return t
  const isThink = THINK_LEAD.test(headTrimmed) || THINK_START.test(headTrimmed)
  if (!isThink) return t
  const rest = t.slice(m[1].length).trim()
  return rest || t
}

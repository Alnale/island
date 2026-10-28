/**
 * DeepSeek 图像输入编码(2026-10-22 图像理解适配)
 *
 * 官方文档:
 * - 图像理解指南 https://api-docs.deepseek.com/zh-cn/guides/vision
 * - Responses input_image(https://api-docs.deepseek.com/zh-cn/api/create-response)
 * - Chat image_url(同 vision 指南 OpenAI 兼容格式)
 * - Anthropic 兼容 image 块(vision 指南"Anthropic 兼容端点"节)
 *
 * 限制口径(官方 vision 指南):
 * - 格式 JPEG/PNG/GIF/WebP(按实际内容判断,非扩展名/MIME);
 * - 请求体 48MiB;单图(base64/URL)32MiB;URL ≤8192 字符(60s 内下载完成);
 * - 单请求图片数 600,图片总大小(不含 file_id)64MiB;单边 ≤8192px;
 * - 图片 token 上限 1024/张(小图等比放大、大图缩到约 1300×1300);
 * - **仅 user 消息可带图**(system/assistant 带图返回 400)。
 *
 * 三协议图片形状(image_url 与 file_id 互斥,本引擎只用内联/URL):
 * - responses:`{type:'input_image', image_url: <URL|data URI **字符串**>}`;
 * - chat:`{type:'image_url', image_url: {url: <URL|data URI>}}`;
 * - anthropic:`{type:'image', source:{type:'base64', media_type, data}}`
 *   / `{type:'image', source:{type:'url', url}}`。
 *
 * 历史韧性(与 mimo-media.ts 同款约定):附件缺失/超限/不支持**不抛错**,
 * 降级为文本占位(写明原因),LLM 转告用户即可,不断整轮请求。
 *
 * 单请求体积预算(DeepSeek 专属):请求体硬上限 48MiB,内联图片按 base64
 * 字符计预算 32MiB(留文本余量);超限时**新图优先**——旧图降级占位
 * (新图是用户当前关注点;旧图降级只损失回看语境,预算只在超限时生效)。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentMessage, AgentPart } from '../types'

/** 三协议内容块形状:Responses / Chat Completions / Anthropic Messages */
export type DeepSeekShape = 'responses' | 'chat' | 'anthropic'

/** 本地图片读盘转 base64 的原始字节上限(官方单图 base64/URL 32MiB,留裕量) */
export const DEEPSEEK_IMAGE_LOCAL_MAX_BYTES = 20 * 1024 * 1024
/** 单条消息最多附图(官方单请求 600 张;对话上下文收敛到 8 张/条,同 lmstudio 先例) */
export const DEEPSEEK_IMAGE_MESSAGE_MAX = 8
/** 单请求内联图片 base64 字符总预算(请求体 48MiB 硬上限,留文本余量) */
export const DEEPSEEK_IMAGE_REQUEST_MAX_CHARS = 32 * 1024 * 1024

/** 扩展名 → MIME(官方按实际内容判断格式,未知扩展名按 jpeg 兜底) */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

function imageMime(url: string): string {
  const ext = path.extname(String(url ?? '').split(/[?#]/)[0]).toLowerCase()
  return IMAGE_MIME[ext] ?? 'image/jpeg'
}

/** 本地图片 → dataUrl 缓存(path → {mtimeMs, dataUrl},mtime 变了重读) */
const dataUrlCache = new Map<string, { mtimeMs: number; dataUrl: string }>()
/** dataUrl 缓存上限(历史每轮回传,避免同一图片反复读盘编码) */
const DATA_URL_CACHE_LIMIT = 16

/** 本地图片文件 → base64 dataUrl(超限/读失败返回 null,由调用方降级) */
async function localImageToDataUrl(pathname: string): Promise<string | null> {
  try {
    const st = await fs.stat(pathname)
    if (!st.isFile() || st.size > DEEPSEEK_IMAGE_LOCAL_MAX_BYTES) return null
    const cached = dataUrlCache.get(pathname)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.dataUrl
    const buf = await fs.readFile(pathname)
    const dataUrl = `data:${imageMime(pathname)};base64,${buf.toString('base64')}`
    // 重插保证 LRU 语义(Map 迭代序 = 插入序,超限删最旧)
    if (dataUrlCache.has(pathname)) dataUrlCache.delete(pathname)
    dataUrlCache.set(pathname, { mtimeMs: st.mtimeMs, dataUrl })
    if (dataUrlCache.size > DATA_URL_CACHE_LIMIT) {
      const oldest = dataUrlCache.keys().next().value
      if (oldest !== undefined) dataUrlCache.delete(oldest)
    }
    return dataUrl
  } catch {
    return null
  }
}

/** 是否本地绝对路径(Windows 盘符 / UNC / POSIX 根) */
function isLocalFilePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

/** 附件 part(image / media 两类;工具调用等其余 part 与图像无关) */
type DeepSeekMediaPart = Extract<AgentPart, { type: 'image' } | { type: 'media' }>

/** 可作图像输入的 part(image part / media part 的 img 类) */
export function isDeepseekImagePart(p: AgentPart): p is DeepSeekMediaPart {
  return p.type === 'image' || (p.type === 'media' && p.kind === 'img')
}

/** 历史里是否有用户侧图片输入(带图请求才换视觉模型/走内容块形状) */
export function historyHasImages(history: AgentMessage[]): boolean {
  return history.some((m) => m.role === 'user' && m.parts.some(isDeepseekImagePart))
}

/** 单图解析结果:成功 = 可直接进请求的 URL|data URI;失败 = 降级原因 */
type ImageResolution = { ok: true; ref: string; chars: number } | { ok: false; reason: string }

/**
 * 单个图片 part → 请求引用:
 * - image part:dataUrl 直取(格式校验);
 * - media part:data URI 直取 / 公网 URL 透传(官方:模型自动下载)、
 *   本地路径读盘转 base64(官方无本地文件上传)。
 */
async function resolveImageRef(part: DeepSeekMediaPart): Promise<ImageResolution> {
  if (part.type === 'image') {
    const url = String(part.dataUrl ?? '').trim()
    if (!url.startsWith('data:image/')) return { ok: false, reason: '不是合法的图片 data URL' }
    return { ok: true, ref: url, chars: url.length }
  }
  const raw = String(part.url ?? '').trim()
  if (!raw) return { ok: false, reason: '附件路径为空' }
  if (raw.startsWith('data:')) return { ok: true, ref: raw, chars: raw.length }
  if (/^https?:\/\//i.test(raw)) {
    // 公开 URL 直接透传(官方 URL ≤8192 字符,模型侧自动下载)
    if (raw.length > 8192) return { ok: false, reason: 'URL 超过 8192 字符上限' }
    return { ok: true, ref: raw, chars: raw.length }
  }
  if (!isLocalFilePath(raw)) return { ok: false, reason: '不是本地路径或 http(s) URL' }
  const st = await fs.stat(raw).catch(() => null)
  if (!st?.isFile()) return { ok: false, reason: '文件不存在或不可读' }
  if (st.size > DEEPSEEK_IMAGE_LOCAL_MAX_BYTES) {
    return { ok: false, reason: `文件 ${(st.size / 1024 / 1024).toFixed(1)}MB 超过单图上限(约 20MB)` }
  }
  const dataUrl = await localImageToDataUrl(raw)
  if (!dataUrl) return { ok: false, reason: '读取失败或不是可识别的图片' }
  return { ok: true, ref: dataUrl, chars: dataUrl.length }
}

/** 图片附着计划条目:成功带 ref,失败/超预算带降级原因 */
export interface DeepSeekImagePlanEntry {
  ref?: string
  reason?: string
}
/** 一次请求的图片附着计划(part → 结果;不在 Map 里的 part 按无图处理) */
export type DeepSeekImagePlan = Map<AgentPart, DeepSeekImagePlanEntry>

/**
 * 为一次请求挑选可内联的图片(新图优先):
 * 倒序遍历历史与部件,预算内登记 ref(单条消息 8 张上限取"最近的 8 张"),
 * 超限/失败登记降级原因——正序回放(序列化)时按条目降级为文本占位。
 * budgetChars 仅测试可覆盖,生产走 DEEPSEEK_IMAGE_REQUEST_MAX_CHARS。
 */
export async function planDeepseekImages(
  history: AgentMessage[],
  budgetChars: number = DEEPSEEK_IMAGE_REQUEST_MAX_CHARS,
): Promise<DeepSeekImagePlan> {
  const plan: DeepSeekImagePlan = new Map()
  let used = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    if (msg.role !== 'user') continue
    let inMessage = 0
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j]
      if (!isDeepseekImagePart(part)) continue
      inMessage += 1
      if (inMessage > DEEPSEEK_IMAGE_MESSAGE_MAX) {
        plan.set(part, { reason: `单条消息最多附 ${DEEPSEEK_IMAGE_MESSAGE_MAX} 张图片,其余已省略` })
        continue
      }
      const r = await resolveImageRef(part)
      if (!r.ok) {
        plan.set(part, { reason: r.reason })
        continue
      }
      if (used + r.chars > budgetChars) {
        plan.set(part, { reason: '超出单次请求图片体积预算(已保留更近的图片)' })
        continue
      }
      used += r.chars
      plan.set(part, { ref: r.ref })
    }
  }
  return plan
}

/** 文本块(按协议形状) */
function textBlock(shape: DeepSeekShape, text: string): Record<string, unknown> {
  // chat/anthropic 文本块同名;responses 用 input_text
  return shape === 'responses' ? { type: 'input_text', text } : { type: 'text', text }
}

/** 图片块(按协议形状;anthropic 的 data URI 拆 media_type + base64 data) */
function imageBlock(shape: DeepSeekShape, ref: string): Record<string, unknown> {
  if (shape === 'chat') return { type: 'image_url', image_url: { url: ref } }
  if (shape === 'anthropic') {
    if (ref.startsWith('data:')) {
      const comma = ref.indexOf(',')
      const meta = comma > 0 ? ref.slice(5, comma) : ''
      const semi = meta.indexOf(';')
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: semi > 0 ? meta.slice(0, semi) : 'image/jpeg',
          data: comma > 0 ? ref.slice(comma + 1) : '',
        },
      }
    }
    return { type: 'image', source: { type: 'url', url: ref } }
  }
  // responses:image_url 是**字符串**(与 file_id 互斥,官方 create-response)
  return { type: 'input_image', image_url: ref }
}

/**
 * 用户消息 parts → user content(三协议共用):
 * - 纯文本(无任何附件 part):文本 join('\n') 单串——与旧版序列化逐字节
 *   一致(前缀缓存要求序列化幂等,不带图的历史请求体不变);
 * - 含附件:按 parts 顺序交错文本块与图片块;图片按 plan 成功=图片块、
 *   失败/超预算=文本占位;音频/视频 DeepSeek 无法输入,一律文本占位;
 * - 纯附件消息补一句中性引导(官方示例均配提问)。
 */
export function deepseekUserContent(
  parts: AgentPart[],
  shape: DeepSeekShape,
  plan: DeepSeekImagePlan,
): string | Array<Record<string, unknown>> {
  const textParts = parts.filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
  const mediaParts = parts.filter((p) => p.type === 'image' || p.type === 'media')
  // 纯文本路径:与旧版 join 语义一致(含空串占位,逐字节稳定)
  if (mediaParts.length === 0) {
    const text = textParts.map((p) => p.text).join('\n')
    return text
  }
  const items: Array<Record<string, unknown>> = []
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text) items.push(textBlock(shape, p.text))
      continue
    }
    if (p.type !== 'image' && p.type !== 'media') continue
    const kind = p.type === 'image' ? 'img' : p.kind
    if (kind !== 'img') {
      items.push(
        textBlock(
          shape,
          `【附件未附上:${kind === 'audio' ? '语音' : '视频'}(DeepSeek 仅支持图片理解,不支持音频/视频输入)】`,
        ),
      )
      continue
    }
    const entry = plan.get(p)
    if (entry?.ref) items.push(imageBlock(shape, entry.ref))
    else items.push(textBlock(shape, `【附件未附上:图片(${entry?.reason ?? '未能解析'};路径见消息文本标注)】`))
  }
  if (items.length === 0) return ''
  // 纯附件消息(图片全部成功附上、无文本)补中性引导
  if (!items.some((i) => i.type === 'text' || i.type === 'input_text')) {
    items.push(textBlock(shape, '请理解以上附件内容'))
  }
  return items
}

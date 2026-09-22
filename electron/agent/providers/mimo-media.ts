/**
 * MiMo 多模态 content parts 编码(2026-09-22 官网接入文档专项适配)
 *
 * **Responses API 第一优先(2026-09-22 用户定调,Chat Completions 过旧)**:
 * 官网 Responses 文档明示 input 支持"文本、图像、音频、视频"(ResponseInputText /
 * ResponseInputImage / ResponseInputAudioContent / ResponseInputVideoContent),
 * 活体探针实证(`/v1/responses`,mimo-v2.6-flash)以下形状全部 200:
 * - 文本:`{type:'input_text', text}`
 * - 图片:`{type:'input_image', image_url: <URL|data URI 字符串>}`
 * - 音频:`{type:'input_audio', input_audio:{data: <URL|data URI>}}`
 * - 视频:`{type:'input_video', input_video:{data: <data URI> | url: <URL>}}`
 *   + 可选 `fps`(0.1-10,缺省 2)+ `media_resolution`(default|max)同级字段
 *   (同 chat 形状的 fps 档位,探针 Q1 实证有效)。
 *
 * Chat Completions 形状(显式 chat 地址的兼容路径,官网多模态文档原形状):
 * - `{type:'image_url', image_url:{url}}` / `{type:'input_audio', input_audio:{data}}`
 *   / `{type:'video_url', video_url:{url}, fps, media_resolution}`。
 *
 * 输入方式与限制(官网原文,两协议一致):
 * - **不支持本地文件上传**——本地路径一律读盘转 `data:{MIME};base64,` data URI;
 *   公网 URL 直接透传(音频 ≤100MB / 视频 ≤300MB / 图片 ≤50MB,URL 侧无法
 *   预检大小,由 API 端校验);
 * - Base64 编码后字符串 ≤50MB(三类一致)→ 本地原始字节上限 ≈37.5MB,
 *   取 36MB 留裕量;
 * - 格式:音频 MP3/WAV/FLAC/M4A/OGG;视频 MP4/MOV/AVI/WMV;图片 JPEG/PNG/
 *   GIF/WebP/BMP(「不能保证所有文件都能被识别」——相邻常见格式宽容放行,
 *   见各 MIME 表注释)。
 *
 * 历史韧性约定:对话历史里的附件可能已被删除/超限/格式不明——**不抛错**,
 * 降级为文本占位(写明原因),LLM 转告用户即可,不断整轮请求。
 * 工具路径(mimo_media)需要硬错误自纠,走 strict 模式抛中文错误。
 *
 * 官方文档:
 * - Responses(多模态 input 首选)https://mimo.mi.com/docs/zh-CN/api/chat/responses
 * - 音频 https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/audio-understanding
 * - 视频 https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/video-understanding
 * - 图片 https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/image-understanding
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { mimoSupportsMedia } from './mimo-constants'
import type { AgentPart } from '../types'

/** 媒体 part(MiMo 编码只关心 image / media 两类附件) */
export type MimoMediaPart = Extract<AgentPart, { type: 'media' } | { type: 'image' }>

/** Base64 编码后 ≤50MB(官网)→ 原始字节上限取 36MB 留裕量 */
export const MIMO_MEDIA_LOCAL_MAX_BYTES = 36 * 1024 * 1024

/** 视频抽帧参数(官网默认 fps=2、media_resolution='default') */
export const MIMO_VIDEO_FPS_DEFAULT = 2
export const MIMO_VIDEO_RESOLUTION_DEFAULT = 'default'

/**
 * 扩展名 → MIME。每类前列为官网支持清单,其后为相邻常见格式(宽容放行,
 * 识别不保证——官方明示「不能保证所有文件都能被识别」)。
 */
export const MIMO_AUDIO_MIME: Record<string, string> = {
  // 官网清单:MP3 / WAV / FLAC / M4A / OGG
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  // 相邻常见格式(宽容)
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  '.opus': 'audio/opus',
}

export const MIMO_VIDEO_MIME: Record<string, string> = {
  // 官网清单:MP4 / MOV / AVI / WMV
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-ms-video',
  '.wmv': 'video/x-ms-wmv',
  // 相邻常见格式(宽容)
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/mp4',
}

export const MIMO_IMAGE_MIME: Record<string, string> = {
  // 官网清单:JPEG / PNG / GIF / WebP / BMP
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  // 相邻常见格式(宽容)
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}

const MIME_TABLES = {
  img: MIMO_IMAGE_MIME,
  video: MIMO_VIDEO_MIME,
  audio: MIMO_AUDIO_MIME,
} as const

const KIND_LABEL: Record<'img' | 'video' | 'audio', string> = {
  img: '图片',
  video: '视频',
  audio: '音频',
}

/** media part 的 kind(image part 恒为 img) */
export function mimoKindOf(part: MimoMediaPart): 'img' | 'video' | 'audio' | null {
  if (part.type === 'image') return 'img'
  if (part.kind === 'img' || part.kind === 'video' || part.kind === 'audio') return part.kind
  return null
}

/** 按扩展名推断 MIME(未知返回 null) */
export function mimoMimeOf(kind: 'img' | 'video' | 'audio', url: string): string | null {
  const ext = path.extname(String(url ?? '').split(/[?#]/)[0]).toLowerCase()
  return MIME_TABLES[kind][ext] ?? null
}

/** 附件展示名(media part 可带 name;缺省回退文件名) */
function partName(part: MimoMediaPart): string {
  if (part.type === 'image') return '图片附件'
  return part.name?.trim() || path.basename(String(part.url ?? '')) || `${KIND_LABEL[part.kind]}附件`
}

/** 占位文本 part(附件无法附上时降级,写明原因供 LLM 转告;两协议通用) */
function placeholder(kind: 'img' | 'video' | 'audio', name: string, source: string, reason: string) {
  return { type: 'text', text: `【附件未附上:${KIND_LABEL[kind]}「${name}」(${reason};来源:${source})】` }
}

/** Responses 形状的文本 part */
function responsesText(text: string) {
  return { type: 'input_text', text }
}

/** Chat 形状的文本 part */
function chatText(text: string) {
  return { type: 'text', text }
}

interface MediaRef {
  kind: 'img' | 'video' | 'audio'
  name: string
  /** URL 或 data URI(可直接进请求) */
  ref: string
}

/**
 * 附件解析(两协议共用):data URI / http(s) 透传;本地路径读盘转 data URI。
 * strict=false(历史路径,默认):失败降级文本占位,不抛错;
 * strict=true(工具路径):失败抛中文错误,LLM 自纠。
 */
async function resolveMediaRef(
  part: MimoMediaPart,
  opts: { strict?: boolean },
): Promise<MediaRef | { fail: true; kind: 'img' | 'video' | 'audio'; name: string; source: string; reason: string }> {
  const strict = opts.strict === true
  const kind = mimoKindOf(part) ?? 'img'
  const name = partName(part)
  const source = part.type === 'image' ? '(data URL)' : String(part.url ?? '')
  const fail = (reason: string) => {
    if (strict) throw new Error(`${KIND_LABEL[kind]}附件「${name}」无法附上:${reason}`)
    console.warn(`[agent] MiMo 附件降级为文本占位:${name}(${reason})`)
    return { fail: true as const, kind, name, source, reason }
  }

  // image part:data URL 直接作引用
  if (part.type === 'image') {
    const url = String(part.dataUrl ?? '').trim()
    if (!url.startsWith('data:image/')) return fail('不是合法的图片 data URL')
    return { kind, name, ref: url }
  }

  const raw = String(part.url ?? '').trim()
  if (!raw) return fail('附件路径为空')

  let ref = raw
  if (!raw.startsWith('data:') && !/^https?:\/\//i.test(raw)) {
    // 本地路径 → 读盘转 data URI(官网不支持本地文件上传)
    const mime = mimoMimeOf(kind, raw)
    if (!mime) {
      return fail(`不支持的文件格式 ${path.extname(raw) || '(无扩展名)'}(音频支持 mp3/wav/flac/m4a/ogg;视频支持 mp4/mov/avi/wmv;图片支持 jpg/png/gif/webp/bmp)`)
    }
    const stat = await fs.stat(raw).catch(() => null)
    if (!stat?.isFile()) return fail('文件不存在或不可读')
    if (stat.size <= 0) return fail('文件为空')
    if (stat.size > MIMO_MEDIA_LOCAL_MAX_BYTES) {
      return fail(`文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 base64 上限(原始约 36MB,官网限制 base64 编码后 ≤50MB)${kind === 'video' ? ';可截取片段或压缩后再发' : ''}`)
    }
    const buf = await fs.readFile(raw)
    ref = `data:${mime};base64,${buf.toString('base64')}`
  }
  return { kind, name, ref }
}

function refToFail(r: Extract<Awaited<ReturnType<typeof resolveMediaRef>>, { fail: true }>) {
  return placeholder(r.kind, r.name, r.source, r.reason)
}

/**
 * 媒体/图片 part → **Responses 原生 content part**(第一优先形状,活体实证):
 * input_image{image_url:字符串} / input_audio{input_audio:{data}} /
 * input_video{input_video:{data|url}}+fps+media_resolution。
 * strict 语义见 resolveMediaRef。
 */
export async function mimoResponsesContentPart(
  part: MimoMediaPart,
  opts?: { strict?: boolean; videoFps?: number; videoResolution?: string },
): Promise<Record<string, unknown>> {
  const r = await resolveMediaRef(part, opts ?? {})
  if ('fail' in r) return refToFail(r)
  switch (r.kind) {
    case 'audio':
      // 官网 ResponseInputAudioContent:data 字段收 URL 或 data URI(探针 C/Q2)
      return { type: 'input_audio', input_audio: { data: r.ref } }
    case 'video':
      // ResponseInputVideoContent:data URI 挂 data、公网 URL 挂 url(探针 P1/P2);
      // fps/media_resolution 同级字段(探针 Q1,与 chat 形状同档位)
      return {
        type: 'input_video',
        input_video: r.ref.startsWith('data:') ? { data: r.ref } : { url: r.ref },
        fps: opts?.videoFps ?? MIMO_VIDEO_FPS_DEFAULT,
        media_resolution: opts?.videoResolution ?? MIMO_VIDEO_RESOLUTION_DEFAULT,
      }
    case 'img':
    default:
      // ResponseInputImage:image_url 为 URL|data URI 字符串(探针 A;对象形式 B 亦收)
      return { type: 'input_image', image_url: r.ref }
  }
}

/**
 * 媒体/图片 part → **Chat Completions content part**(显式 chat 地址兼容路径,
 * 官网多模态文档原形状):image_url{url} / input_audio{input_audio:{data}} /
 * video_url{video_url:{url}}+fps+media_resolution。
 */
export async function mimoChatContentPart(
  part: MimoMediaPart,
  opts?: { strict?: boolean; videoFps?: number; videoResolution?: string },
): Promise<Record<string, unknown>> {
  const r = await resolveMediaRef(part, opts ?? {})
  if ('fail' in r) return refToFail(r)
  switch (r.kind) {
    case 'audio':
      return { type: 'input_audio', input_audio: { data: r.ref } }
    case 'video':
      return {
        type: 'video_url',
        video_url: { url: r.ref },
        fps: opts?.videoFps ?? MIMO_VIDEO_FPS_DEFAULT,
        media_resolution: opts?.videoResolution ?? MIMO_VIDEO_RESOLUTION_DEFAULT,
      }
    case 'img':
    default:
      return { type: 'image_url', image_url: { url: r.ref } }
  }
}

/** 兼容旧名:mimoMediaPart = Chat 形状(mimo-chat 协议路径) */
export const mimoMediaPart = mimoChatContentPart

/** 两协议共用的 user content 组装(文本 part 形状与媒体 part 形状按协议注入) */
async function buildUserContent(
  parts: AgentPart[],
  shape: 'responses' | 'chat',
  opts?: { model?: string; strict?: boolean; videoFps?: number; videoResolution?: string },
): Promise<string | Array<Record<string, unknown>>> {
  const model = opts?.model ?? ''
  const mediaOk = mimoSupportsMedia(model)
  const textPart = shape === 'responses' ? responsesText : chatText
  const mediaPart = shape === 'responses' ? mimoResponsesContentPart : mimoChatContentPart
  const items: Array<Record<string, unknown>> = []
  let hasMedia = false
  for (const p of parts) {
    if (p.type === 'text') {
      const t = p.text.trim()
      if (t) items.push(textPart(p.text))
      continue
    }
    if (p.type !== 'media' && p.type !== 'image') continue
    hasMedia = true
    if (!mediaOk) {
      const name = partName(p)
      items.push(
        textPart(
          `【附件未附上:${p.type === 'image' ? '图片' : KIND_LABEL[p.kind]}「${name}」(当前模型 ${model || '(未指定)'} 不支持多模态输入——官网多模态支持清单为 mimo-v2.6 系 / mimo-v2.5;换支持模型后重发即可)】`,
        ),
      )
      continue
    }
    items.push(await mediaPart(p, opts))
  }
  if (items.length === 0) return ''
  if (!hasMedia) {
    // 纯文本历史:string content(与旧版行为一致,也最小化请求体积)
    return items.map((i) => String(i.text)).join('\n')
  }
  // 附件历史:至少带一条 text(官网示例均配提问;纯附件消息补一句中性引导)
  if (!items.some((i) => (shape === 'responses' ? i.type === 'input_text' : i.type === 'text'))) {
    items.push(textPart('请理解以上附件内容'))
  }
  return items
}

/** 用户消息 parts → **Responses** user content(第一优先;纯文本返回 string) */
export function mimoResponsesUserContent(
  parts: AgentPart[],
  opts?: { model?: string; strict?: boolean; videoFps?: number; videoResolution?: string },
): Promise<string | Array<Record<string, unknown>>> {
  return buildUserContent(parts, 'responses', opts)
}

/** 用户消息 parts → **Chat Completions** user content(chat 兼容路径) */
export function mimoUserContent(
  parts: AgentPart[],
  opts?: { model?: string; strict?: boolean; videoFps?: number; videoResolution?: string },
): Promise<string | Array<Record<string, unknown>>> {
  return buildUserContent(parts, 'chat', opts)
}

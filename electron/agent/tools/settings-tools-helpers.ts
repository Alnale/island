/**
 * 灵动岛设置工具辅助簇(扩展名/MIME 常量、文件校验转 data URL、
 * 参数校验、设置快照格式化)
 *
 * 2026-08-14 插件化六期从 settingsTools.ts 拆出:createSettingsTools
 * 共用的校验与格式化纯逻辑;fileToDataUrl 含读盘但无状态。
 * settingsTools.ts barrel 兼容 re-export。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 渲染端设置桥操作名(settingsBridge.ts 的 window.__islandSettings 方法;
 *  九期下沉至本簇——settingsTools.ts 与各 builder 簇共用,经 barrel 兼容) */
export type IslandSettingsOp =
  | 'getSettings'
  | 'setThemeColor'
  | 'setAgentScale'
  | 'importFont'
  | 'listFonts'
  | 'renameFont'
  | 'importBackground'
  | 'listLibraryImages'
  | 'renameLibraryImage'
  | 'setFontColor'
  | 'setBackgroundOpacity'
  | 'setMediaWindowSize'
  | 'listAudioLibrary'
  | 'importAudioLibrary'
  | 'renameAudioLibrary'
  | 'removeAudioLibrary'
  | 'listVideoLibrary'
  | 'importVideoLibrary'
  | 'renameVideoLibrary'
  | 'removeVideoLibrary'
  | 'playLibraryVideo'
  | 'getVideoPrefs'
  | 'setVideoPrefs'
  | 'setFullscreen'
  | 'setVideoState'
  | 'setAudioState'
  | 'getConversationMedia'
  | 'deleteFontItem'
  | 'deleteLibraryImage'
  | 'removeBackground'
  | 'addAudioLibraryToPlaylist'
  | 'setBackgroundCrop'
  | 'setLyricProvider'
  | 'setFontWeight'
  | 'listPlaylist'
  | 'removePlaylistItem'

/** 字体文件上限(与设置界面上传一致:30MB) */
export const MAX_FONT_BYTES = 30 * 1024 * 1024

/** 允许的字体扩展名 → data URL MIME */
export const FONT_EXTENSIONS: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** 允许的图片扩展名 → data URL MIME */
export const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/* 多媒体库(2026-08-08):音频库导入的扩展名 → data URL MIME(上限 200MB) */
export const AUDIO_LIB_EXTENSIONS: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
}
export const MAX_AUDIO_LIB_BYTES = 200 * 1024 * 1024
/** 视频库导入允许的扩展名(路径引用,仅校验,无 MIME 需要) */
export const VIDEO_LIB_EXTENSIONS: Record<string, boolean> = {
  '.mp4': true,
  '.m4v': true,
  '.mov': true,
  '.webm': true,
}

/** 读取文件转 data URL(校验扩展名与大小上限;失败抛中文错误供 LLM 自纠) */
export async function fileToDataUrl(
  filePath: string,
  extMap: Record<string, string>,
  maxBytes: number,
  label: string,
): Promise<{ dataUrl: string; name: string }> {
  const p = String(filePath ?? '').trim()
  if (!p) throw new Error(`${label}路径不能为空`)
  const ext = path.extname(p).toLowerCase()
  const mime = extMap[ext]
  if (!mime) throw new Error(`不支持的文件类型 "${ext}",仅支持:${Object.keys(extMap).join(' / ')}`)
  const stat = await fs.stat(p).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error(`文件不存在:${p}`)
  if (stat.size <= 0) throw new Error(`文件为空:${p}`)
  if (stat.size > maxBytes) {
    throw new Error(`文件过大:${(stat.size / 1024 / 1024).toFixed(1)}MB,上限 ${Math.round(maxBytes / 1024 / 1024)}MB`)
  }
  const buf = await fs.readFile(p)
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, name: path.basename(p) }
}

/** 主题色 hex 校验(# 可省略,6 位十六进制) */
export function parseHexColor(color: unknown): string {
  const t = String(color ?? '').trim()
  if (!/^#?[0-9a-fA-F]{6}$/.test(t)) {
    throw new Error('颜色格式不正确:需要 6 位十六进制,如 #4d6bfe 或 4d6bfe')
  }
  const hex = t.startsWith('#') ? t : `#${t}`
  return hex.toLowerCase()
}

/** 缩放百分比校验与钳制(100-400,与设置界面一致;2026-08-11 用户
 * 要求最大缩放从 300% 上调到 400%) */
export function parseScale(percent: unknown): number {
  const n = Number(percent)
  if (!Number.isFinite(n)) throw new Error('缩放比例需要是数字(100-400)')
  return Math.min(400, Math.max(100, Math.round(n)))
}

/** 库条目名称校验(非空、≤50 字) */
export function parseItemName(name: unknown): string {
  const t = String(name ?? '').trim()
  if (!t) throw new Error('名称不能为空')
  if (t.length > 50) throw new Error(`名称过长(≤50 字):${t.slice(0, 12)}…`)
  return t
}

/** 设置快照 → 人类可读文本(LLM 回复依据;缺失字段回退默认) */
export function formatSettings(s: unknown): string {
  const d = (s ?? {}) as {
    themeColor?: string | null
    agentScale?: number
    fontColorMode?: string
    fontColorValue?: string | null
    currentFontName?: string | null
    backgroundOpacity?: { expanded?: number; compact?: number }
    mediaWindowWidth?: number
    fontWeight?: number
    video?: { volume?: number; speed?: number; loop?: boolean; fullscreen?: boolean }
  }
  const opacity = d.backgroundOpacity ?? {}
  const video = d.video ?? {}
  return [
    '当前灵动岛设置:',
    `- 主题色:${d.themeColor ? ` ${d.themeColor}` : ' 未设置(默认)'}`,
    `- 界面缩放:${typeof d.agentScale === 'number' ? ` ${d.agentScale}%` : ' 未设置(默认 200%)'}`,
    `- 文字颜色:${d.fontColorMode === 'custom' && d.fontColorValue ? ` 自定义 ${d.fontColorValue}` : ' 自动(按背景亮度黑白)'}`,
    `- 背景不透明度:展开 ${opacity.expanded ?? 0.4} / 紧凑 ${opacity.compact ?? 0.4}(0-1,1 = 完全不透明)`,
    `- 当前字体:${d.currentFontName ? `「${d.currentFontName}」` : ' 无(系统默认)'}`,
    `- 媒体窗口默认宽:${typeof d.mediaWindowWidth === 'number' ? ` ${d.mediaWindowWidth}px` : ' 未设置(默认 320px)'}`,
    `- 视频播放:音量 ${Math.round((video.volume ?? 1) * 100)}% / 速度 ${video.speed ?? 1}x / 循环${video.loop ? '开' : '关'} / ${video.fullscreen ? '全屏中' : '非全屏'}`,
    `- 字体粗细:${typeof d.fontWeight === 'number' ? ` ${d.fontWeight}` : ' 400(常规)'}`,
  ].join('\n')
}

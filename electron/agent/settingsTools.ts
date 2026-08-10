/**
 * 灵动岛设置工具 —— LLM 对话中直接修改挂件可控设置(应用后即时生效)
 *
 * 存储全部在渲染端(localStorage / IndexedDB),主进程经 runIslandSettings
 * 回调 → executeJavaScript 在页面上下文调设置桥(window.__islandSettings,
 * 见 src/settingsBridge.ts);桥写完存储后派发 island-settings-changed
 * 事件,WidgetApp / DynamicIsland 监听重读 React 状态 → 即时生效,
 * 无需用户手动进设置界面。
 *
 * 文件类导入(字体/背景图)在本模块读盘校验(扩展名/大小上限),转
 * data URL 后交桥入库并应用(与设置界面上传同款存储层)。
 * 工具命名/参数 JSON Schema 供 LLM 生成参数,执行结果回填对话。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentTool, ToolParams } from './types'

/** 渲染端设置桥操作名(settingsBridge.ts 的 window.__islandSettings 方法) */
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
  | 'getConversationMedia'
  | 'deleteFontItem'
  | 'deleteLibraryImage'

export interface SettingsToolsDeps {
  /** 调渲染端设置桥(主进程注入;未注入则不注册设置工具) */
  runIslandSettings?(op: IslandSettingsOp, args: unknown[]): Promise<unknown>
}

/** 字体文件上限(与设置界面上传一致:30MB) */
const MAX_FONT_BYTES = 30 * 1024 * 1024

/** 允许的字体扩展名 → data URL MIME */
const FONT_EXTENSIONS: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** 允许的图片扩展名 → data URL MIME */
const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/* 多媒体库(2026-08-08):音频库导入的扩展名 → data URL MIME(上限 200MB) */
const AUDIO_LIB_EXTENSIONS: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
}
const MAX_AUDIO_LIB_BYTES = 200 * 1024 * 1024
/** 视频库导入允许的扩展名(路径引用,仅校验,无 MIME 需要) */
const VIDEO_LIB_EXTENSIONS: Record<string, boolean> = {
  '.mp4': true,
  '.m4v': true,
  '.mov': true,
  '.webm': true,
}

/** 读取文件转 data URL(校验扩展名与大小上限;失败抛中文错误供 LLM 自纠) */
async function fileToDataUrl(
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
function parseHexColor(color: unknown): string {
  const t = String(color ?? '').trim()
  if (!/^#?[0-9a-fA-F]{6}$/.test(t)) {
    throw new Error('颜色格式不正确:需要 6 位十六进制,如 #4d6bfe 或 4d6bfe')
  }
  const hex = t.startsWith('#') ? t : `#${t}`
  return hex.toLowerCase()
}

/** 缩放百分比校验与钳制(100-300,与设置界面一致) */
function parseScale(percent: unknown): number {
  const n = Number(percent)
  if (!Number.isFinite(n)) throw new Error('缩放比例需要是数字(100-300)')
  return Math.min(300, Math.max(100, Math.round(n)))
}

/** 库条目名称校验(非空、≤50 字) */
function parseItemName(name: unknown): string {
  const t = String(name ?? '').trim()
  if (!t) throw new Error('名称不能为空')
  if (t.length > 50) throw new Error(`名称过长(≤50 字):${t.slice(0, 12)}…`)
  return t
}

/** 设置快照 → 人类可读文本(LLM 回复依据;缺失字段回退默认) */
function formatSettings(s: unknown): string {
  const d = (s ?? {}) as {
    themeColor?: string | null
    agentScale?: number
    fontColorMode?: string
    fontColorValue?: string | null
    currentFontName?: string | null
    backgroundOpacity?: { expanded?: number; compact?: number }
    mediaWindowWidth?: number
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
  ].join('\n')
}

/** 灵动岛设置工具清单(LLM 可调用;deps 无桥时返回空 = 不注册) */
export function createSettingsTools(deps: SettingsToolsDeps): AgentTool[] {
  const run = deps.runIslandSettings
  if (!run) return []
  return [
    {
      name: 'get_island_settings',
      description:
        '读取灵动岛**当前**的界面设置快照(主题色 / 界面缩放百分比 / 文字颜色模式与值 / ' +
        '背景不透明度(展开/紧凑)/ 当前字体 / 媒体窗口默认宽 / 视频播放设置(音量/速度/循环/是否全屏))。' +
        '**修改任何设置前先调用本工具确认当前值**——' +
        '用户说「调到 200%」「换个颜色」时,先知道现在是 300% 还是 100%、当前色是什么,才能' +
        '准确执行并回复「从 300% 调整为 200%」;若当前已是目标值则无需修改,直接告知用户。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const s = await run('getSettings', [])
        return formatSettings(s)
      },
    },
    {
      name: 'set_theme_color',
      description:
        '设置灵动岛**主题色**(强调色:按钮/气泡/进度条/开关等控件的颜色,影响整个 UI),' +
        '立即生效。颜色为 6 位十六进制(如 #4d6bfe 蓝色、#f87171 红色)。' +
        '**只改主题色,不改文字颜色**——用户说「字体/文字/字颜色」时改用 set_font_color。' +
        '适合:用户要求换主题色、自定义 UI 主色等。',
      parameters: {
        type: 'object',
        properties: {
          color: { type: 'string', description: '主题色 hex,如 #4d6bfe' },
        },
        required: ['color'],
      },
      async execute(params: ToolParams) {
        const hex = parseHexColor(params.color)
        const res = (await run('setThemeColor', [hex])) as {
          ok?: boolean
          color?: string
          previous?: string | null
        }
        const prev = typeof res?.previous === 'string' ? res.previous : null
        if (prev === hex) return `主题色当前已是 ${hex},无需修改`
        return prev !== null
          ? `已将主题色从 ${prev} 调整为 ${hex}`
          : `已将主题色设置为 ${hex}`
      },
    },
    {
      name: 'set_agent_scale',
      description:
        '设置 Agent 模式界面缩放比例(100%-300%,默认 200%)。' +
        '只放大面板/窗口尺寸,UI 元素(文字/按钮)不缩放——适合用户觉得' +
        '"字太小/面板太小"时调大。',
      parameters: {
        type: 'object',
        properties: {
          percent: { type: 'number', description: '缩放百分比,100-300,如 150' },
        },
        required: ['percent'],
      },
      async execute(params: ToolParams) {
        const scale = parseScale(params.percent)
        const res = (await run('setAgentScale', [scale])) as {
          ok?: boolean
          scale?: number
          previous?: number
        }
        const prev = typeof res?.previous === 'number' ? res.previous : null
        if (prev === scale) return `界面缩放当前已是 ${scale}%,无需修改`
        return prev !== null
          ? `已将界面缩放从 ${prev}% 调整为 ${scale}%`
          : `已将界面缩放设置为 ${scale}%`
      },
    },
    {
      name: 'import_font',
      description:
        '导入字体文件到字体库并应用为当前字体(立即生效,全岛文字换字体)。' +
        '支持 ttf/otf/woff/woff2,≤30MB。适合:用户提供字体文件路径要求换字体。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '字体文件绝对路径' },
          name: { type: 'string', description: '可选:字体显示名称,缺省用文件名' },
        },
        required: ['path'],
      },
      async execute(params: ToolParams) {
        const { dataUrl, name } = await fileToDataUrl(
          String(params.path ?? ''),
          FONT_EXTENSIONS,
          MAX_FONT_BYTES,
          '字体文件',
        )
        const display = String(params.name ?? '').trim() || name
        await run('importFont', [dataUrl, parseItemName(display)])
        return `已导入字体「${display}」并应用为当前字体`
      },
    },
    {
      name: 'list_fonts',
      description: '列出字体库全部字体(id + 名称)。改名/管理字体前先查 id。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const items = (await run('listFonts', [])) as Array<{ id: string; name: string }>
        if (!Array.isArray(items) || items.length === 0) return '(字体库为空)'
        return items.map((f) => `- ${f.id} ${f.name}`).join('\n')
      },
    },
    {
      name: 'rename_font',
      description: '修改字体库中某个字体的名称(立即生效;id 用 list_fonts 查询)。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '字体条目 id' },
          name: { type: 'string', description: '新名称(≤50 字)' },
        },
        required: ['id', 'name'],
      },
      async execute(params: ToolParams) {
        const id = String(params.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        const name = parseItemName(params.name)
        await run('renameFont', [id, name])
        return `已将字体 ${id} 改名为「${name}」`
      },
    },
    {
      name: 'import_background',
      description:
        '导入图片作为灵动岛自定义背景(展开态与紧凑态同时应用,立即生效),' +
        '并加入图片库。支持 png/jpg/jpeg/gif/webp/bmp。适合:用户给图片路径' +
        '要求设为背景。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片文件绝对路径' },
          name: { type: 'string', description: '可选:图片库显示名称,缺省用文件名' },
        },
        required: ['path'],
      },
      async execute(params: ToolParams) {
        const { dataUrl, name } = await fileToDataUrl(
          String(params.path ?? ''),
          IMAGE_EXTENSIONS,
          20 * 1024 * 1024,
          '图片文件',
        )
        const display = String(params.name ?? '').trim() || name
        await run('importBackground', [dataUrl, parseItemName(display)])
        return `已导入图片「${display}」作为背景并加入图片库`
      },
    },
    {
      name: 'set_font_color',
      description:
        '设置灵动岛**文字颜色**(岛内文字的显示颜色,立即生效),**不是主题色**——' +
        '用户说「字体颜色/文字颜色/字颜色/字体的颜色」时用本工具;说「主题色/按钮/强调色」' +
        '时改用 set_theme_color。mode=custom 用自定义颜色(6 位十六进制,如 #ffffff 白、' +
        '#0b0b0f 黑);mode=auto 恢复自动(按背景亮度自动黑白)。' +
        '颜色名词(如「奶油杏」「暖白」)需换算成 hex 填入。' +
        '适合:用户要求改文字颜色、深色背景上文字看不清时调亮等。',
      parameters: {
        type: 'object',
        properties: {
          color: { type: 'string', description: '自定义颜色 hex,如 #ffffff(custom 模式必填)' },
          mode: {
            type: 'string',
            enum: ['custom', 'auto'],
            description: 'custom = 自定义颜色;auto = 自动亮度(默认 custom)',
          },
        },
        required: [],
      },
      async execute(params: ToolParams) {
        const mode = String(params.mode ?? 'custom')
        if (mode !== 'custom' && mode !== 'auto') throw new Error('mode 只能是 custom 或 auto')
        // 校验先于桥调用(坏 hex 不落存储)
        const hex = mode === 'custom' ? parseHexColor(params.color) : ''
        const res = (await run('setFontColor', [hex, mode])) as {
          ok?: boolean
          previousMode?: string
          previousValue?: string | null
        }
        const prevLabel =
          res?.previousMode === 'custom' && res.previousValue ? `自定义 ${res.previousValue}` : '自动'
        if (mode === 'custom') {
          if (res?.previousMode === 'custom' && res.previousValue === hex) {
            return `文字颜色当前已是 ${hex}(自定义模式),无需修改`
          }
          return `已将文字颜色从 ${prevLabel} 调整为 ${hex}(自定义模式)`
        }
        if (res?.previousMode === 'auto') return '文字颜色当前已是自动(按背景亮度黑白),无需修改'
        return `已恢复文字颜色为自动(原为 ${prevLabel})`
      },
    },
    {
      name: 'set_background_opacity',
      description:
        '设置自定义背景图的不透明度(0-1 小数,如 0.3 = 30% 不透明,1 = 完全不透明;' +
        '数值越透明背景越淡)。expanded/compact 分别对应展开态与紧凑态,' +
        '只传一个就只改对应形态(另一个不变)。适合:背景图太抢眼看不清文字时' +
        '调低、太淡时调高。',
      parameters: {
        type: 'object',
        properties: {
          expanded: { type: 'number', description: '展开态不透明度 0-1,如 0.4(可选)' },
          compact: { type: 'number', description: '紧凑态不透明度 0-1,如 0.4(可选)' },
        },
        required: [],
      },
      async execute(params: ToolParams) {
        const hasExpanded = params.expanded !== undefined
        const hasCompact = params.compact !== undefined
        if (!hasExpanded && !hasCompact) throw new Error('需要至少提供 expanded 或 compact 之一')
        const parseOpacity = (v: unknown): number => {
          const n = Number(v)
          if (!Number.isFinite(n)) throw new Error('不透明度需要是数字(0-1)')
          return Math.min(1, Math.max(0, n))
        }
        const patches: { expanded?: number; compact?: number } = {}
        if (hasExpanded) patches.expanded = parseOpacity(params.expanded)
        if (hasCompact) patches.compact = parseOpacity(params.compact)
        const res = (await run('setBackgroundOpacity', [patches])) as {
          ok?: boolean
          opacity?: { expanded?: number; compact?: number }
          previous?: { expanded?: number; compact?: number }
        }
        const next = res?.opacity
        const prev = res?.previous
        if (prev && next && prev.expanded === next.expanded && prev.compact === next.compact) {
          return '背景不透明度已是该值,无需修改'
        }
        const prevLabel = (v?: number) => (typeof v === 'number' ? String(v) : '?')
        const parts = [
          hasExpanded ? `展开 ${next?.expanded ?? patches.expanded}` : '',
          hasCompact ? `紧凑 ${next?.compact ?? patches.compact}` : '',
        ].filter(Boolean)
        return `已将背景不透明度调整为:${parts.join(' / ')}(原为:展开 ${prevLabel(prev?.expanded)} / 紧凑 ${prevLabel(prev?.compact)})`
      },
    },
    {
      name: 'set_media_window_size',
      description:
        '设置对话里**媒体窗口的默认宽度**(图片/视频在消息里的初始显示宽度,立即生效,' +
        '160-800 像素,如 480)。用户说「媒体窗口大一点/小一点」「图片显示太小吃不下」时用本工具。' +
        '适合:Agent 回复里的图片/视频窗口默认大小调整。',
      parameters: {
        type: 'object',
        properties: {
          width: { type: 'number', description: '媒体窗口默认宽(160-800 像素)' },
        },
        required: ['width'],
      },
      async execute(params: ToolParams) {
        const w = Number(params.width)
        if (!Number.isFinite(w)) throw new Error('width 需要是数字(160-800)')
        const width = Math.min(800, Math.max(160, Math.round(w)))
        const res = (await run('setMediaWindowSize', [width])) as {
          ok?: boolean
          width?: number
          previous?: number
        }
        if (res?.width === res?.previous) {
          return `媒体窗口默认宽已是 ${res.width}px,无需修改`
        }
        return `已将媒体窗口默认宽从 ${res?.previous ?? '?'}px 调整为 ${res?.width ?? width}px(新消息里的图片/视频生效)`
      },
    },
    /* ---- 多媒体库(2026-08-08):音频库(ArrayBuffer)/ 视频库(路径引用) ---- */
    {
      name: 'list_audio_library',
      description:
        '列出多媒体库音频库的全部歌曲(id + 名称 + 大小)。管理音频库前先查 id。' +
        '适合:用户问"库里有什么歌"、改名/移除前查询。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const items = (await run('listAudioLibrary', [])) as Array<{ id: string; name: string; size: number }>
        if (!Array.isArray(items) || items.length === 0) return '(音频库为空)'
        return items.map((it) => `- ${it.id} ${it.name}(${(it.size / 1024 / 1024).toFixed(1)}MB)`).join('\n')
      },
    },
    {
      name: 'import_audio_library',
      description:
        '导入本地音频文件到多媒体库音频库(立即生效,可再从音频库导入播放列表)。' +
        '支持 mp3/wav/flac/ogg/m4a/aac 等,上限 200MB。适合:用户给音频文件路径要求存入多媒体库。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '音频文件绝对路径' },
          name: { type: 'string', description: '可选:库内显示名称,缺省用文件名' },
        },
        required: ['path'],
      },
      async execute(params: ToolParams) {
        const { dataUrl, name } = await fileToDataUrl(
          String(params.path ?? ''),
          AUDIO_LIB_EXTENSIONS,
          MAX_AUDIO_LIB_BYTES,
          '音频文件',
        )
        const display = String(params.name ?? '').trim() || name
        const res = (await run('importAudioLibrary', [dataUrl, parseItemName(display)])) as {
          id?: string
          name?: string
        }
        return `已将「${res?.name ?? display}」导入音频库(可用 list_audio_library 查看)`
      },
    },
    {
      name: 'rename_audio_library',
      description: '修改多媒体库音频库中某首歌的名称(立即生效;id 用 list_audio_library 查询)。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '音频条目 id' },
          name: { type: 'string', description: '新名称(≤100 字)' },
        },
        required: ['id', 'name'],
      },
      async execute(params: ToolParams) {
        const id = String(params.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        const name = parseItemName(params.name)
        await run('renameAudioLibrary', [id, name])
        return `已把音频 ${id} 改名为「${name}」`
      },
    },
    {
      name: 'remove_audio_library',
      description: '从多媒体库音频库移除一首歌(立即生效;**不影响播放列表**——播放列表有自己的存储)。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '音频条目 id(list_audio_library 查询)' },
        },
        required: ['id'],
      },
      async execute(params: ToolParams) {
        const id = String(params.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        await run('removeAudioLibrary', [id])
        return `已从音频库移除 ${id}`
      },
    },
    {
      name: 'list_video_library',
      description: '列出多媒体库视频库的全部视频(id + 名称 + 大小 + 路径)。管理视频库前先查 id。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const items = (await run('listVideoLibrary', [])) as Array<{ id: string; name: string; size: number; path: string }>
        if (!Array.isArray(items) || items.length === 0) return '(视频库为空)'
        return items.map((it) => `- ${it.id} ${it.name}(${(it.size / 1024 / 1024).toFixed(1)}MB,${it.path})`).join('\n')
      },
    },
    {
      name: 'import_video_library',
      description:
        '导入本地视频文件到多媒体库视频库(路径引用:记录文件路径,对话媒体窗口经流式协议播放;' +
        '上限 10GB)。支持 mp4/m4v/mov/webm。适合:用户给视频文件路径要求存入多媒体库。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '视频文件绝对路径' },
          name: { type: 'string', description: '可选:库内显示名称,缺省用文件名' },
        },
        required: ['path'],
      },
      async execute(params: ToolParams) {
        const p = String(params.path ?? '').trim()
        if (!p) throw new Error('视频路径不能为空')
        const ext = path.extname(p).toLowerCase()
        if (!VIDEO_LIB_EXTENSIONS[ext]) throw new Error(`不支持的文件类型 "${ext}",仅支持:mp4/m4v/mov/webm`)
        const stat = await fs.stat(p).catch(() => null)
        if (!stat || !stat.isFile()) throw new Error(`文件不存在:${p}`)
        if (stat.size > 10 * 1024 * 1024 * 1024) {
          throw new Error(`文件过大:${(stat.size / 1024 / 1024 / 1024).toFixed(1)}GB,上限 10GB`)
        }
        const name = String(params.name ?? '').trim() || path.basename(p)
        const res = (await run('importVideoLibrary', [p, parseItemName(name), stat.size])) as {
          id?: string
          name?: string
        }
        return `已将「${res?.name ?? name}」导入视频库(路径:${p})`
      },
    },
    {
      name: 'rename_video_library',
      description: '修改多媒体库视频库中某个视频的名称(立即生效;id 用 list_video_library 查询)。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '视频条目 id' },
          name: { type: 'string', description: '新名称(≤100 字)' },
        },
        required: ['id', 'name'],
      },
      async execute(params: ToolParams) {
        const id = String(params.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        const name = parseItemName(params.name)
        await run('renameVideoLibrary', [id, name])
        return `已把视频 ${id} 改名为「${name}」`
      },
    },
    {
      name: 'remove_video_library',
      description: '从多媒体库视频库移除一个视频(立即生效;只删库记录,**不删除源文件**)。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '视频条目 id(list_video_library 查询)' },
        },
        required: ['id'],
      },
      async execute(params: ToolParams) {
        const id = String(params.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        await run('removeVideoLibrary', [id])
        return `已从视频库移除 ${id}`
      },
    },
    {
      name: 'play_library_video',
      description:
        '跳转到多媒体库的视频 tab 并**立即播放指定视频**(展开面板 + 自动开始播放,2026-08-10)。' +
        'id 用 list_video_library 查询(名称可能重复,id 唯一)。' +
        '适合:用户说"把视频库里的 XX 放给我看""帮我打开播放 XX 视频"——' +
        '注意与 open_file 的区别:open_file 把视频作为对话媒体附件播放,' +
        '本工具从多媒体库视频库播放(用户能在多媒体库面板看到该视频)。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '视频库条目 id(list_video_library 查询)' },
        },
        required: ['id'],
      },
      async execute(params: ToolParams) {
        const id = String(params.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        const res = (await run('playLibraryVideo', [id])) as {
          ok?: boolean
          id?: string
          name?: string
        }
        return `已跳转到多媒体库播放「${res?.name ?? id}」`
      },
    },
    {
      name: 'set_video_config',
      description:
        '调整 Agent 对话窗口内视频播放的设置(立即生效;音量/速度/循环与' +
        '视频岛、多媒体库**双向同步**):' +
        'volume = **灵动岛独立音量**(0-1,只影响岛内媒体播放,与系统音量互不影响——' +
        '系统音量用 set_system_volume 工具调);' +
        'speed = 播放速度(0.5-2,如 1.5 = 1.5 倍速);' +
        'loop = 是否循环播放(true/false);' +
        'fullscreen = 进入/退出全屏(true = 把对话窗口里正在播放的视频全屏,false = 退出全屏);' +
        'width = 媒体窗口默认宽(160-800,新播放的图片/视频生效)。' +
        '参数全部可选、至少给一个。适合:用户说"视频慢一点/倍速播放/循环播放/全屏看/退出全屏/' +
        '视频声音大一点/媒体窗口大一点"。修改前可先调 get_island_settings 看当前值。',
      parameters: {
        type: 'object',
        properties: {
          volume: { type: 'number', description: '灵动岛独立音量 0-1,如 0.6(可选)' },
          speed: { type: 'number', description: '播放速度 0.5-2,如 1.5(可选)' },
          loop: { type: 'boolean', description: '是否循环播放(可选)' },
          fullscreen: { type: 'boolean', description: 'true = 进入全屏,false = 退出全屏(可选)' },
          width: { type: 'number', description: '媒体窗口默认宽 160-800,如 480(可选)' },
        },
        required: [],
      },
      async execute(params: ToolParams) {
        const hasVolume = params.volume !== undefined
        const hasSpeed = params.speed !== undefined
        const hasLoop = params.loop !== undefined
        const hasFs = params.fullscreen !== undefined
        const hasWidth = params.width !== undefined
        if (!hasVolume && !hasSpeed && !hasLoop && !hasFs && !hasWidth) {
          throw new Error('需要至少提供一个参数:volume / speed / loop / fullscreen / width')
        }
        const parts: string[] = []
        if (hasVolume || hasSpeed || hasLoop) {
          const vol = hasVolume ? Number(params.volume) : undefined
          if (hasVolume && (!Number.isFinite(vol) || vol! < 0 || vol! > 1)) {
            throw new Error('volume 需要是 0-1 的数字(如 0.6 = 60%)')
          }
          const spd = hasSpeed ? Number(params.speed) : undefined
          if (hasSpeed && (!Number.isFinite(spd) || spd! < 0.5 || spd! > 2)) {
            throw new Error('speed 需要是 0.5-2 的数字(如 1.5 = 1.5 倍速)')
          }
          const res = (await run('setVideoPrefs', [
            {
              volume: hasVolume ? Math.min(1, Math.max(0, vol!)) : undefined,
              speed: hasSpeed ? Math.min(2, Math.max(0.5, spd!)) : undefined,
              loop: hasLoop ? Boolean(params.loop) : undefined,
            },
          ])) as {
            ok?: boolean
            volume?: number
            speed?: number
            loop?: boolean
            previous?: { volume: number; speed: number; loop: boolean }
          }
          const prev = res?.previous
          const cur = res
          if (hasVolume && prev) {
            parts.push(prev.volume === cur?.volume ? `音量已是 ${Math.round((cur.volume ?? 0) * 100)}%` : `音量从 ${Math.round(prev.volume * 100)}% 调整为 ${Math.round((cur?.volume ?? 0) * 100)}%`)
          } else if (hasVolume && cur) {
            parts.push(`音量已设为 ${Math.round((cur.volume ?? 1) * 100)}%`)
          }
          if (hasSpeed && prev) {
            parts.push(prev.speed === cur?.speed ? `速度已是 ${cur?.speed}x` : `速度从 ${prev.speed}x 调整为 ${cur?.speed}x`)
          } else if (hasSpeed && cur) {
            parts.push(`速度已设为 ${cur.speed ?? 1}x`)
          }
          if (hasLoop && cur) {
            parts.push(`循环播放${cur.loop ? '已开启' : '已关闭'}`)
          }
        }
        if (hasFs) {
          const fsRes = (await run('setFullscreen', [Boolean(params.fullscreen)])) as {
            ok?: boolean
            fullscreen?: boolean
          }
          parts.push(params.fullscreen ? (fsRes?.fullscreen ? '已进入全屏' : '已请求进入全屏(无可播放视频时忽略)') : '已退出全屏')
        }
        if (hasWidth) {
          const w = Number(params.width)
          if (!Number.isFinite(w)) throw new Error('width 需要是数字(160-800)')
          const width = Math.min(800, Math.max(160, Math.round(w)))
          const res = (await run('setMediaWindowSize', [width])) as {
            ok?: boolean
            width?: number
            previous?: number
          }
          parts.push(
            res?.width === res?.previous
              ? `媒体窗口默认宽已是 ${res?.width}px`
              : `媒体窗口默认宽从 ${res?.previous ?? '?'}px 调整为 ${res?.width ?? width}px`,
          )
        }
        return parts.join(';')
      },
    },
    {
      name: 'list_conversation_media',
      description:
        '列出 Agent 对话窗口内**作为附件展示**的多媒体元素(图片/视频/音频,' +
        '含 LLM 在回复里 markdown 内嵌的 ![名字](路径));' +
        '视频带详细播放状态:是否正在播放、音量(0-100%)、播放速度(x)、' +
        '是否循环播放、是否全屏、播放进度。' +
        '适合:用户问"对话里有什么媒体""现在播的是什么""视频声音多大/几倍速/全屏没"' +
        '等;配合 set_video_config 调整(如用户说"把声音调大"先查当前音量)。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const items = (await run('getConversationMedia', [])) as Array<{
          kind: 'img' | 'video' | 'audio'
          name?: string
          playing?: boolean
          volume?: number
          speed?: number
          loop?: boolean
          fullscreen?: boolean
          position?: number
          duration?: number | null
        }>
        if (!Array.isArray(items) || items.length === 0) {
          return '(对话窗口当前没有媒体附件)'
        }
        const label = (n?: string) => (n ? `「${n}」` : '(未命名)')
        return items
          .map((it) => {
            if (it.kind === 'video') {
              const dur = typeof it.duration === 'number' && it.duration > 0 ? it.duration : null
              const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
              return (
                `- 视频 ${label(it.name)}:${it.playing ? ' 正在播放' : ' 已暂停'}` +
                `,音量 ${it.volume ?? '?'}%,速度 ${it.speed ?? 1}x,循环${it.loop ? '开' : '关'}` +
                `,${it.fullscreen ? '全屏中' : '非全屏'}` +
                (dur ? `,进度 ${fmt(it.position ?? 0)} / ${fmt(dur)}` : '')
              )
            }
            if (it.kind === 'audio') {
              return `- 音频 ${label(it.name)}:${it.playing ? ' 正在播放' : ' 已暂停'}`
            }
            return `- 图片 ${label(it.name)}`
          })
          .join('\n')
      },
    },
    {
      name: 'list_library_images',
      description: '列出图片库全部图片(id + 名称)。改名/管理图片前先查 id。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const items = (await run('listLibraryImages', [])) as Array<{ id: string; name: string }>
        if (!Array.isArray(items) || items.length === 0) return '(图片库为空)'
        return items.map((img) => `- ${img.id} ${img.name}`).join('\n')
      },
    },
    {
      name: 'rename_library_image',
      description:
        '修改图片库中某张图片的名称(立即生效;id 用 list_library_images 查询)。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '图片条目 id' },
          name: { type: 'string', description: '新名称(≤50 字)' },
        },
        required: ['id', 'name'],
      },
      async execute(params: ToolParams) {
        const id = String(params.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        const name = parseItemName(params.name)
        await run('renameLibraryImage', [id, name])
        return `已将图片 ${id} 改名为「${name}」`
      },
    },
  ]
}

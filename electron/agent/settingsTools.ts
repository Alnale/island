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
  }
  const opacity = d.backgroundOpacity ?? {}
  return [
    '当前灵动岛设置:',
    `- 主题色:${d.themeColor ? ` ${d.themeColor}` : ' 未设置(默认)'}`,
    `- 界面缩放:${typeof d.agentScale === 'number' ? ` ${d.agentScale}%` : ' 未设置(默认 200%)'}`,
    `- 文字颜色:${d.fontColorMode === 'custom' && d.fontColorValue ? ` 自定义 ${d.fontColorValue}` : ' 自动(按背景亮度黑白)'}`,
    `- 背景不透明度:展开 ${opacity.expanded ?? 0.4} / 紧凑 ${opacity.compact ?? 0.4}(0-1,1 = 完全不透明)`,
    `- 当前字体:${d.currentFontName ? `「${d.currentFontName}」` : ' 无(系统默认)'}`,
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
        '背景不透明度(展开/紧凑)/ 当前字体)。**修改任何设置前先调用本工具确认当前值**——' +
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

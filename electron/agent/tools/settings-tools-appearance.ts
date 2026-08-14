/**
 * 灵动岛设置工具——界面外观簇(主题色/缩放/字体/背景/歌词源)
 *
 * 九期自 settingsTools.ts 的 createSettingsTools 工厂拆出(按域细分);
 * 由工厂组合装配(顺序 = 工具列表呈现顺序)。run = 渲染端设置桥调用。
 */


import type { AgentTool, ToolParams } from '../types'
import type { IslandSettingsOp } from './settings-tools-helpers'
import {
  FONT_EXTENSIONS,
  fileToDataUrl,
  IMAGE_EXTENSIONS,
  MAX_FONT_BYTES,
  parseHexColor,
  parseItemName,
  parseScale,
} from './settings-tools-helpers'

export function buildAppearanceTools(run: (op: IslandSettingsOp, args: unknown[]) => Promise<unknown>): AgentTool[] {
  return [
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
        '设置 Agent 模式界面缩放比例(100%-400%,默认 200%)。' +
        '只放大面板/窗口尺寸,UI 元素(文字/按钮)不缩放——适合用户觉得' +
        '"字太小/面板太小"时调大。',
      parameters: {
        type: 'object',
        properties: {
          percent: { type: 'number', description: '缩放百分比,100-400,如 150' },
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
      name: 'set_font_weight',
      description:
        '设置灵动岛**字体粗细**(字重,立即生效):300(细)/ 400(常规)/ 500 / 600 / 700(粗)/ 800 / 900(特粗)。' +
        '适合:用户说"字太细了""字加粗一点""字体再细一点"。' +
        '注意:单字重字体(如部分自定义字体)由浏览器合成粗细,效果有限。',
      parameters: {
        type: 'object',
        properties: {
          weight: { type: 'number', description: '字重 300-900,档位:300/400/500/600/700/800/900,如 700' },
        },
        required: ['weight'],
      },
      async execute(params: ToolParams) {
        const w = Number(params.weight)
        if (!Number.isFinite(w)) throw new Error('weight 需要是数字(300-900)')
        const res = (await run('setFontWeight', [w])) as {
          ok?: boolean
          weight?: number
          previous?: number
        }
        if (res?.weight === res?.previous) return `字体粗细当前已是 ${res.weight},无需修改`
        return `已将字体粗细从 ${res?.previous ?? '?'} 调整为 ${res?.weight ?? w}`
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
      name: 'set_background_crop',
      description:
        '调整自定义背景图的**取景/裁切**(立即生效,与设置界面背景编辑器的取景框同款参数):' +
        'zoom = 放大倍数(1-4,1 = 原图铺满,越大放大越多);' +
        'posX = 水平位置(0-100,0 = 最左,100 = 最右,50 = 居中);' +
        'posY = 垂直位置(0-100,0 = 最上,100 = 最下,50 = 居中)。' +
        'expanded/compact 分别对应展开态与紧凑态,只传一个就只改对应形态。' +
        '每个形态的 zoom/posX/posY 都可单独传(只改提供的字段)。' +
        '适合:用户说"背景图放太大了/太小了""背景往左移/往右移/往上一点/往下一点"。',
      parameters: {
        type: 'object',
        properties: {
          expanded: {
            type: 'object',
            description: '展开态取景参数(可选):{zoom: 1-4, posX: 0-100, posY: 0-100}',
          },
          compact: {
            type: 'object',
            description: '紧凑态取景参数(可选):{zoom: 1-4, posX: 0-100, posY: 0-100}',
          },
        },
        required: [],
      },
      async execute(params: ToolParams) {
        const hasExpanded = params.expanded && typeof params.expanded === 'object'
        const hasCompact = params.compact && typeof params.compact === 'object'
        if (!hasExpanded && !hasCompact) {
          throw new Error('需要至少提供 expanded 或 compact 之一(取景参数对象)')
        }
        const patches: {
          expanded?: { zoom?: number; posX?: number; posY?: number }
          compact?: { zoom?: number; posX?: number; posY?: number }
        } = {}
        if (hasExpanded) patches.expanded = params.expanded as Record<string, number>
        if (hasCompact) patches.compact = params.compact as Record<string, number>
        const res = (await run('setBackgroundCrop', [patches])) as {
          ok?: boolean
          crop?: { expanded: { zoom: number; posX: number; posY: number }; compact: { zoom: number; posX: number; posY: number } }
          previous?: { expanded: { zoom: number; posX: number; posY: number }; compact: { zoom: number; posX: number; posY: number } }
        }
        const fmt = (c?: { zoom: number; posX: number; posY: number }) =>
          c ? `缩放 ${c.zoom}x / 位置 (${c.posX},${c.posY})` : '?'
        const parts = [
          hasExpanded ? `展开态:${fmt(res?.crop?.expanded)}` : '',
          hasCompact ? `紧凑态:${fmt(res?.crop?.compact)}` : '',
        ].filter(Boolean)
        const prevParts = [
          hasExpanded ? `展开态:${fmt(res?.previous?.expanded)}` : '',
          hasCompact ? `紧凑态:${fmt(res?.previous?.compact)}` : '',
        ].filter(Boolean)
        return `已调整背景取景:${parts.join(' / ')}(原为:${prevParts.join(' / ')})`
      },
    },
    {
      name: 'set_lyric_provider',
      description:
        '设置**歌词 API 厂商**(立即生效):provider 支持 qq(QQ音乐)/ netease(网易云音乐)/ ' +
        'kuwo(酷我音乐)/ kugou(酷狗音乐)/ custom(自定义模板)。' +
        'auto = 是否按监听平台自动切换对应厂商(默认开启;如开着,SMTC 识别到网易云时自动用网易云歌词)。' +
        'custom 需要 url 模板(占位符 {title} 歌名 / {artist} 歌手,如 https://example.com/lyric?t={title}&a={artist})。' +
        '适合:用户说"歌词换成酷狗的""歌词接口用网易云""关掉歌词自动切换""用自定义歌词接口"。' +
        '修改前可先调 get_island_settings 看当前配置。',
      parameters: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['qq', 'netease', 'kuwo', 'kugou', 'custom'],
            description: '歌词厂商:qq/netease/kuwo/kugou/custom',
          },
          url: { type: 'string', description: 'custom 模式的 URL 模板(占位符 {title}/{artist}),其他厂商不需要' },
          auto: { type: 'boolean', description: '按监听平台自动切换开关(默认开启),可选' },
        },
        required: ['provider'],
      },
      async execute(params: ToolParams) {
        const provider = String(params.provider ?? '')
        if (!['qq', 'netease', 'kuwo', 'kugou', 'custom'].includes(provider)) {
          throw new Error('provider 仅支持 qq/netease/kuwo/kugou/custom')
        }
        if (provider === 'custom') {
          const url = String(params.url ?? '').trim()
          if (!url) throw new Error('custom 模式需要 url 模板(含 {title}/{artist} 占位符)')
        }
        const auto = params.auto !== undefined ? Boolean(params.auto) : true
        const res = (await run('setLyricProvider', [{ id: provider, url: params.url ? String(params.url) : undefined }, auto])) as {
          ok?: boolean
          id?: string
          url?: string
          auto?: boolean
          previous?: { id: string; url?: string; auto: boolean }
        }
        const NAME: Record<string, string> = { qq: 'QQ音乐', netease: '网易云音乐', kuwo: '酷我音乐', kugou: '酷狗音乐', custom: '自定义' }
        if (res?.id === res?.previous?.id && res?.auto === res?.previous?.auto) {
          return `歌词 API 当前已是 ${NAME[provider]},自动切换${res.auto ? '开' : '关'},无需修改`
        }
        const urlPart = provider === 'custom' && res?.url ? `(模板:${res.url})` : ''
        return (
          `已将歌词 API 从 ${NAME[res?.previous?.id ?? ''] ?? '?'} 切换为 ${NAME[provider]}${urlPart};` +
          `自动切换${res?.auto ? '开启(按监听平台自动换对应厂商)' : '关闭(固定用当前厂商)'}`
        )
      },
    },
  ]
}

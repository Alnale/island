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

import type { AgentTool, ToolParams } from '../types'
import { buildAppearanceTools } from './settings-tools-appearance'
import { buildMediaLibTools } from './settings-tools-media-lib'
// 已拆出的辅助簇:本文件内部仍需使用的部分显式导入(barrel re-export 见下方)
import { formatSettings, parseItemName } from './settings-tools-helpers'
import type { IslandSettingsOp } from './settings-tools-helpers'

// ---- 辅助簇已拆出,barrel 兼容 re-export(engine.ts 既有路径不变) ----
export * from './settings-tools-helpers'

export interface SettingsToolsDeps {
  /** 调渲染端设置桥(主进程注入;未注入则不注册设置工具) */
  runIslandSettings?(op: IslandSettingsOp, args: unknown[]): Promise<unknown>
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
    // 界面外观簇 / 媒体库簇(九期拆出,顺序 = 工具列表呈现顺序)
    ...buildAppearanceTools(run),
    ...buildMediaLibTools(run),
    // 媒体查看簇(会话媒体/图片库)
    {
      name: 'list_conversation_media',
      description:
        '列出 Agent 对话窗口内**作为附件展示**的多媒体元素(图片/视频/音频,' +
        '含 LLM 在回复里 markdown 内嵌的 ![名字](路径));' +
        '视频带详细播放状态:是否正在播放、音量(0-100%)、播放速度(x)、' +
        '是否循环播放、是否全屏、播放进度;' +
        '音频带播放状态、音量(0-100%)、是否循环、播放进度。' +
        '适合:用户问"对话里有什么媒体""现在播的是什么""声音多大/循环没"' +
        '等;配合 set_video_config / set_audio_config 调整(如用户说"把声音调大"先查当前音量)。',
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


/**
 * 音乐控制工具(2026-08-12,QQ 远程控制 / 后台对话:主进程经
 * __islandMusicControl 桥 → 外部平台(SMTC)优先,本地播放器兜底)。
 * 与设置工具分离——桥不同(runIslandSettings 调 __islandSettings)
 */
export function createMusicControlTools(run: (op: string, args: unknown[]) => Promise<unknown>): AgentTool[] {
  return [
    {
      name: 'music_control',
      description:
        '控制灵动岛音乐播放(2026-08-12,QQ 远程控制 / 后台对话——即使当前是音乐模式也能用):' +
        'play 播放 / pause 暂停 / next 下一首 / previous 上一首 / status 查询当前播放状态。' +
        '外部平台(QQ音乐/网易云等,经 SMTC)与本地播放器自动适配。' +
        '适合:用户(含 QQ 消息)说"暂停/播放/下一首/上一首/现在放的是什么"。' +
        '注意:切回音乐模式用 switch_to_music;调系统音量用 set_system_volume。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'pause', 'next', 'previous', 'status'],
            description: '操作:play/pause/next/previous 控制播放,status 查询当前播放状态',
          },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        const actions = ['play', 'pause', 'next', 'previous', 'status']
        if (!actions.includes(action)) throw new Error(`action 仅支持:${actions.join('/')}`)
        // 桥操作:status 查状态,其余 action 走 control(白名单只有这两个)
        const op = action === 'status' ? 'status' : 'control'
        const res = (await run(op, action === 'status' ? [] : [action])) as
          | { ok?: boolean; action?: string; error?: string }
          | {
              ok?: boolean
              external?: boolean
              playing?: boolean
              title?: string | null
              artist?: string | null
              position?: number
              duration?: number
            }
        if (res && 'error' in res && typeof res.error === 'string') {
          throw new Error(res.error)
        }
        if (action === 'status') {
          const s = res as {
            external?: boolean
            playing?: boolean
            title?: string | null
            artist?: string | null
            position?: number
            duration?: number
          }
          const title = s.title || '(无曲目)'
          const artist = s.artist ? ` - ${s.artist}` : ''
          const mode = s.external ? '外部平台(QQ音乐等)' : '本地播放器'
          const playing = s.playing ? '播放中' : '已暂停'
          const pos = s.position != null ? Math.round(s.position) : 0
          const dur = s.duration != null ? Math.round(s.duration) : 0
          const progress = dur > 0 ? ` ${Math.floor(pos / 60)}:${String(pos % 60).padStart(2, '0')}/${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}` : ''
          return `当前播放:${title}${artist}(${mode},${playing}${progress})`
        }
        const label = action === 'play' ? '播放' : action === 'pause' ? '暂停' : action === 'next' ? '下一首' : '上一首'
        return `已${label}`
      },
    },
  ]
}

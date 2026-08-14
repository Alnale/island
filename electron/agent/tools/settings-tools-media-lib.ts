/**
 * 灵动岛设置工具——媒体库簇(音频/视频库/播放列表/播放配置)
 *
 * 九期自 settingsTools.ts 的 createSettingsTools 工厂拆出(按域细分);
 * 由工厂组合装配(顺序 = 工具列表呈现顺序)。run = 渲染端设置桥调用。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentTool, ToolParams } from '../types'
import type { IslandSettingsOp } from './settings-tools-helpers'
import {
  AUDIO_LIB_EXTENSIONS,
  fileToDataUrl,
  MAX_AUDIO_LIB_BYTES,
  parseItemName,
  VIDEO_LIB_EXTENSIONS,
} from './settings-tools-helpers'

export function buildMediaLibTools(run: (op: IslandSettingsOp, args: unknown[]) => Promise<unknown>): AgentTool[] {
  return [
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
      name: 'list_playlist',
      description:
        '列出音乐模式**当前播放列表**的全部歌曲(key + 名称 + 大小)。' +
        '适合:用户问"播放列表里有什么歌""现在列表里有哪些歌"。' +
        '删除曲目用 remove_playlist_item(先查 key)。' +
        '注意:播放列表 ≠ 音频库(音频库用 list_audio_library 查)。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const items = (await run('listPlaylist', [])) as Array<{ key: string; name: string; size: number }>
        if (!Array.isArray(items) || items.length === 0) return '(播放列表为空)'
        return items
          .map((it, i) => `- ${i + 1}. ${it.name}(${(it.size / 1024 / 1024).toFixed(1)}MB,key:${it.key})`)
          .join('\n')
      },
    },
    {
      name: 'remove_playlist_item',
      description:
        '从音乐模式**播放列表**删除一首歌(key 用 list_playlist 查询,立即生效;' +
        '正在播放该曲目时自动切到相邻曲目)。' +
        '注意:删除的是播放列表条目,**音频库与源文件不受影响**。' +
        '适合:用户说"把播放列表里那首歌删掉""清掉这首歌"。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '播放列表条目 key(list_playlist 查询)' },
        },
        required: ['key'],
      },
      async execute(params: ToolParams) {
        const key = String(params.key ?? '').trim()
        if (!key) throw new Error('key 不能为空(list_playlist 查询)')
        await run('removePlaylistItem', [key])
        return `已从播放列表删除 ${key}`
      },
    },
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
        '导入本地音频文件到**多媒体库音频库**(立即生效)。' +
        '支持 mp3/wav/flac/ogg/m4a/aac 等,上限 200MB。适合:用户给音频文件路径要求存入多媒体库。' +
        '**注意:音频库 ≠ 播放列表**——音乐模式播放的是播放列表,' +
        '音频库条目不会自动出现在音乐模式;要加入播放列表并让用户能点播,导入后调用 ' +
        'add_audio_to_playlist(传返回的 id)。',
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
      name: 'add_audio_to_playlist',
      description:
        '把多媒体库**音频库**里的歌曲加入音乐模式**播放列表**(加入后切到音乐模式即可见可点播;' +
        '**不会自动切音乐模式、不会自动开始播放**——用户明确要求"切到音乐模式播放"时,加入后调 ' +
        'switch_to_music(play:true);要在对话窗口直接播放,用 open_file 打开音频文件)。' +
        'id 用 list_audio_library 查询(可一次传多个 id 批量加入)。' +
        '适合:用户说"把这首歌加入播放列表/加进歌单""下载的歌曲放进播放列表"——' +
        '注意 import_audio_library 只进音频库,**音乐模式播不了音频库里的歌**,必须经本工具加入播放列表。',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '音频库条目 id 列表(list_audio_library 查询),至少一个',
          },
        },
        required: ['ids'],
      },
      async execute(params: ToolParams) {
        const ids = Array.isArray(params.ids)
          ? params.ids.map(String).map((s) => s.trim()).filter(Boolean)
          : []
        if (ids.length === 0) throw new Error('ids 需要至少一个音频条目 id(list_audio_library 查询)')
        const res = (await run('addAudioLibraryToPlaylist', [ids])) as {
          ok?: boolean
          count?: number
          names?: string[]
        }
        const names = res?.names ?? []
        return (
          `已将 ${res?.count ?? names.length} 首歌加入播放列表(音乐模式侧)${names.length > 0 ? `:${names.join('、')}` : ''}` +
          '(未切换模式;对话窗口直接播放可用 open_file 打开音频,切音乐模式播放需用户明确要求)'
        )
      },
    },
    {
      name: 'remove_background',
      description:
        '移除灵动岛自定义背景,恢复默认纯色底(立即生效)。' +
        'scope=expanded 只移除展开态 / scope=compact 只移除紧凑态 / scope=both(默认)两态都移除。' +
        '移除后背景裁切参数复位,不透明度保留。适合:用户说"背景去掉""不要背景了""恢复默认背景"。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['both', 'expanded', 'compact'],
            description: '移除范围:both = 展开+紧凑都移除(默认)/ expanded = 仅展开态 / compact = 仅紧凑态',
          },
        },
        required: [],
      },
      async execute(params: ToolParams) {
        const scope = String(params.scope ?? 'both')
        if (!['both', 'expanded', 'compact'].includes(scope)) throw new Error('scope 只能是 both/expanded/compact')
        const res = (await run('removeBackground', [scope])) as {
          ok?: boolean
          removed: string[]
          previous?: unknown
        }
        const removed = res?.removed ?? []
        if (removed.length === 0) return '当前没有自定义背景,无需移除'
        const label = removed.map((s) => (s === 'expanded' ? '展开态' : '紧凑态')).join('、')
        return `已移除${label}背景,恢复默认纯色底`
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
        '调整 Agent 对话窗口内视频播放的设置(立即生效):' +
        '**target = 指定单个视频**(可选,名称为 list_conversation_media 返回的 ' +
        'name;缺省 = 全局共享设置,影响所有视频的默认值);' +
        'volume = **灵动岛独立音量**(0-1,只影响岛内媒体播放,与系统音量互不影响——' +
        '系统音量用 set_system_volume 工具调;带 target 只调该视频,其它视频不变);' +
        'speed = 播放速度(0.5-2,如 1.5 = 1.5 倍速);' +
        'loop = 是否循环播放(true/false);' +
        'playing = 播放/暂停开关(true = 播放,false = 暂停;带 target 控制指定视频,缺省控制当前正在播放的视频);' +
        'fullscreen = 进入/退出全屏(true = 把对话窗口里正在播放的视频全屏,false = 退出全屏);' +
        'width = 媒体窗口默认宽(160-800,新播放的图片/视频生效)。' +
        '参数全部可选、至少给一个。适合:用户说"视频慢一点/倍速播放/循环播放/全屏看/退出全屏/' +
        '视频声音大一点/把第二个视频暂停/这个视频音量调小一点"。修改前可先调 ' +
        'list_conversation_media(查视频名字与当前状态)或 get_island_settings 看全局值。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标视频名(list_conversation_media 返回的 name;可选,缺省 = 全局设置)' },
          volume: { type: 'number', description: '灵动岛独立音量 0-1,如 0.6(可选)' },
          speed: { type: 'number', description: '播放速度 0.5-2,如 1.5(可选)' },
          loop: { type: 'boolean', description: '是否循环播放(可选)' },
          playing: { type: 'boolean', description: '播放/暂停:true = 播放,false = 暂停(可选)' },
          fullscreen: { type: 'boolean', description: 'true = 进入全屏,false = 退出全屏(可选)' },
          width: { type: 'number', description: '媒体窗口默认宽 160-800,如 480(可选)' },
        },
        required: [],
      },
      async execute(params: ToolParams) {
        const hasVolume = params.volume !== undefined
        const hasSpeed = params.speed !== undefined
        const hasLoop = params.loop !== undefined
        const hasPlaying = params.playing !== undefined
        const hasFs = params.fullscreen !== undefined
        const hasWidth = params.width !== undefined
        const target = typeof params.target === 'string' && params.target.trim() ? params.target.trim() : undefined
        if (!hasVolume && !hasSpeed && !hasLoop && !hasPlaying && !hasFs && !hasWidth) {
          throw new Error('需要至少提供一个参数:target / volume / speed / loop / playing / fullscreen / width')
        }
        const parts: string[] = []
        if (hasVolume || hasSpeed || hasLoop || hasPlaying) {
          const vol = hasVolume ? Number(params.volume) : undefined
          if (hasVolume && (!Number.isFinite(vol) || vol! < 0 || vol! > 1)) {
            throw new Error('volume 需要是 0-1 的数字(如 0.6 = 60%)')
          }
          const spd = hasSpeed ? Number(params.speed) : undefined
          if (hasSpeed && (!Number.isFinite(spd) || spd! < 0.5 || spd! > 2)) {
            throw new Error('speed 需要是 0.5-2 的数字(如 1.5 = 1.5 倍速)')
          }
          // 按单个视频控制(2026-08-10,target 指定):桥定位该视频,音量/
          // 倍速/循环写该视频个性化(其它视频不变),playing 播放/暂停
          if (target !== undefined) {
            const res = (await run('setVideoState', [
              {
                name: target,
                volume: hasVolume ? Math.min(1, Math.max(0, vol!)) : undefined,
                speed: hasSpeed ? Math.min(2, Math.max(0.5, spd!)) : undefined,
                loop: hasLoop ? Boolean(params.loop) : undefined,
                playing: hasPlaying ? Boolean(params.playing) : undefined,
              },
            ])) as {
              ok?: boolean
              name?: string
              volume?: number
              speed?: number
              loop?: boolean
              playing?: boolean
            }
            const label = res?.name ? `「${res.name}」` : '视频'
            if (hasVolume && res) parts.push(`${label}音量已设为 ${res.volume ?? 0}%`)
            if (hasSpeed && res) parts.push(`${label}速度已设为 ${res.speed ?? 1}x`)
            if (hasLoop && res) parts.push(`${label}循环播放${res.loop ? '已开启' : '已关闭'}`)
            if (hasPlaying && res) {
              parts.push(res.playing ? `已播放 ${label}` : `已暂停 ${label}`)
              if (!hasVolume && !hasSpeed && !hasLoop) return parts.join(';')
            }
          } else if (hasPlaying) {
            // 无 target 的 playing:控制当前正在播放的视频(桥 name 缺省语义)
            const res = (await run('setVideoState', [{ playing: Boolean(params.playing) }])) as {
              ok?: boolean
              name?: string
              playing?: boolean
            }
            parts.push(res?.playing ? '已播放当前视频' : '已暂停当前视频')
          }
          // 无 target 的 volume/speed/loop:全局共享设置(向后兼容)
          if (target === undefined && (hasVolume || hasSpeed || hasLoop)) {
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
      name: 'set_audio_config',
      description:
        '调整 Agent 对话窗口内音频(语音气泡)的播放设置(2026-08-12,立即生效):' +
        '**target = 指定单条音频**(可选,名称为 list_conversation_media 返回的 ' +
        'name;缺省 = 当前正在播放的音频,无播放取最后一条);' +
        'volume = **灵动岛独立音量**(0-1,只影响岛内媒体播放,与系统音量互不影响——' +
        '系统音量用 set_system_volume 工具调;带 target 只调该音频,其它音频不变);' +
        'loop = 是否循环播放(true/false);' +
        'playing = 播放/暂停开关(true = 播放,false = 暂停;带 target 控制指定音频,缺省控制当前正在播放的音频)。' +
        '参数全部可选、至少给一个。适合:用户说"把这首歌声音调大/静音/循环播放/' +
        '暂停这首歌/继续播放"。修改前可先调 list_conversation_media(查音频名字与当前状态)。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标音频名(list_conversation_media 返回的 name;可选,缺省 = 当前播放中的音频)' },
          volume: { type: 'number', description: '灵动岛独立音量 0-1,如 0.6(可选)' },
          loop: { type: 'boolean', description: '是否循环播放(可选)' },
          playing: { type: 'boolean', description: '播放/暂停:true = 播放,false = 暂停(可选)' },
        },
        required: [],
      },
      async execute(params: ToolParams) {
        const hasVolume = params.volume !== undefined
        const hasLoop = params.loop !== undefined
        const hasPlaying = params.playing !== undefined
        const target = typeof params.target === 'string' && params.target.trim() ? params.target.trim() : undefined
        if (!hasVolume && !hasLoop && !hasPlaying) {
          throw new Error('需要至少提供一个参数:target / volume / loop / playing')
        }
        if (hasVolume) {
          const vol = Number(params.volume)
          if (!Number.isFinite(vol) || vol < 0 || vol > 1) {
            throw new Error('volume 需要是 0-1 的数字(如 0.6 = 60%)')
          }
        }
        const res = (await run('setAudioState', [
          {
            name: target,
            volume: hasVolume ? Math.min(1, Math.max(0, Number(params.volume))) : undefined,
            loop: hasLoop ? Boolean(params.loop) : undefined,
            playing: hasPlaying ? Boolean(params.playing) : undefined,
          },
        ])) as {
          ok?: boolean
          name?: string
          volume?: number
          loop?: boolean
          playing?: boolean
        }
        if (!res || res.ok !== true) {
          throw new Error(res && 'error' in res ? String((res as { error: unknown }).error) : '音频设置失败')
        }
        const label = res.name ? `「${res.name}」` : '音频'
        const parts: string[] = []
        if (hasVolume) parts.push(`${label}音量已设为 ${res.volume ?? 0}%`)
        if (hasLoop) parts.push(`${label}循环播放${res.loop ? '已开启' : '已关闭'}`)
        if (hasPlaying) parts.push(res.playing ? `已播放 ${label}` : `已暂停 ${label}`)
        return parts.join(';')
      },
    },
  ]
}

/**
 * 灵动岛设置桥 —— 渲染端暴露给主进程(LLM 设置工具)的设置操作入口
 *
 * 架构:引擎设置工具(electron/agent/settingsTools.ts,主进程)经
 * runIslandSettings → executeJavaScript 在页面上下文调用本桥的
 * window.__islandSettings 方法。每个操作:写 localStorage / IndexedDB
 * (与设置界面 UI 同款存储层)→ **派发 island-settings-changed 事件**
 * (带 scopes)→ WidgetApp / DynamicIsland 监听重读 React 状态 →
 * 即时生效(无需用户进设置界面)。
 *
 * 仅在挂件版注册(WidgetApp 挂载时);Web 演示版无主进程工具调用,不注册。
 * 桥只做存储写入与事件通知,不直接操作 React 状态(状态刷新统一走监听)。
 */

import {
  clearBackgroundImage,
  DEFAULT_BG_CROP,
  deleteImageItem,
  downscaleBackgroundImage,
  genImageId,
  loadBackgroundImage,
  loadImageItems,
  readBackgroundParams,
  saveBackgroundImage,
  saveBackgroundParams,
  saveImageItem,
  type ImageLibraryItem,
} from './media/backgroundStore'
import {
  deleteFontItem as deleteFontItemStore,
  genFontId,
  loadFontItems,
  loadFontSettings,
  saveFontItem,
  saveFontSettings,
  type FontLibraryItem,
} from './media/fontStore'
// 多媒体库(2026-08-08):LLM 设置工具的 audio/video 库操作入口
import {
  genLibraryId,
  loadAudioLibrary,
  loadVideoLibrary,
  removeAudioItem,
  removeVideoItem,
  saveAudioItem,
  saveVideoItem,
} from './media/libraryStore'
// 视频播放偏好(2026-08-10,LLM 工具 set_video_config 的 volume/speed/loop:
// 写共享偏好经 island:video-prefs 事件三处播放器即时同步;2026-08-10 二轮
// 支持 key = 单个视频个性化,事件带 key 只影响匹配播放器)
import { loadVideoPrefs, setVideoPrefs as saveVideoPrefs } from './media/videoPrefs'
// 音频播放偏好(2026-08-12,LLM 工具 set_audio_config 的 volume/loop:
// 写共享/个性化偏好经 island:audio-prefs 事件语音气泡即时同步,同
// videoPrefs 的双层(key = 单条音频个性化)语义)
import { setAudioPrefs } from './media/audioPrefs'
// 歌词 API 提供商(2026-08-11,LLM 工具 set_lyric_provider:与设置视图
// 歌词 API 页同款 localStorage 存储,运行时查询即时生效)
import {
  loadLyricAuto,
  loadLyricProvider,
  saveLyricAuto,
  saveLyricProvider,
  type LyricProvider,
} from './media/lyricProviders'
// 字重档位(2026-08-11,LLM 工具 set_font_weight 校验用)
import { FONT_WEIGHTS } from './media/fontStore'
// 播放列表持久化(2026-08-11,LLM 工具 list_playlist / remove_playlist_item:
// 读 IndexedDB island-uploads + 删除,与播放列表 state 经事件同步)
import { loadUploads, removeUpload } from './media/uploadStore'

/** 主题色持久化键(与 WidgetApp 的 THEME_STORAGE_KEY 一致) */
export const THEME_STORAGE_KEY = 'widget-theme-color'
/** Agent 界面缩放持久化键(单一来源;useAgentPanelLayout 反向导入,
 * 审计 P2 #3 修过时注释) */
export const AGENT_SCALE_STORAGE_KEY = 'widget-agent-scale'
/** 媒体窗口默认宽持久化键(2026-08-08 单一来源;MediaFrame 反向导入,
 * 与 AGENT_SCALE_STORAGE_KEY 同款) */
export const MEDIA_WINDOW_STORAGE_KEY = 'widget-media-window'
// 背景参数键与读取在 backgroundStore 共享(不透明度/裁切,含旧版迁移)
/** 设置变更事件名(桥写完存储后派发,UI 监听重读) */
export const ISLAND_SETTINGS_EVENT = 'island-settings-changed'
/** 变更涉及的状态域(监听方按域重读对应状态) */
export type IslandSettingsScope =
  | 'theme'
  | 'scale'
  | 'font'
  | 'background'
  | 'imageLibrary'
  | 'mediaWindow'
  | 'mediaLibrary'
  | 'lyric'

/** 桥方法(主进程 executeJavaScript 调用;方法名与 settingsTools 的 op 一致) */
export interface IslandSettingsBridge {
  /** 读取当前设置快照(LLM 修改前先查;setter 返回值也带 previous 原值) */
  getSettings(): Promise<{
    themeColor: string | null
    agentScale: number
    fontColorMode: 'custom' | 'auto'
    fontColorValue: string | null
    currentFontId: string | null
    currentFontName: string | null
    backgroundOpacity: { expanded: number; compact: number }
    /** 媒体窗口默认宽(2026-08-10 补进快照:LLM 改前先查当前值) */
    mediaWindowWidth: number
    /** 视频播放设置(2026-08-10 补进快照:音量/速度/循环 + 是否全屏) */
    video: { volume: number; speed: number; loop: boolean; fullscreen: boolean }
  }>
  setThemeColor(color: string): Promise<{ ok: true; color: string; previous: string | null }>
  setAgentScale(percent: number): Promise<{ ok: true; scale: number; previous: number }>
  importFont(dataUrl: string, name: string): Promise<{ ok: true; id: string; name: string }>
  listFonts(): Promise<Array<{ id: string; name: string }>>
  renameFont(id: string, name: string): Promise<{ ok: true; id: string; name: string }>
  importBackground(dataUrl: string, name: string): Promise<{ ok: true; id: string; name: string }>
  listLibraryImages(): Promise<Array<{ id: string; name: string }>>
  renameLibraryImage(id: string, name: string): Promise<{ ok: true; id: string; name: string }>
  /** 设置文字颜色(custom = 自定义 hex;auto = 恢复按背景亮度自动黑白);
      返回 previousMode/previousValue 供 LLM 回复原值 */
  setFontColor(
    color: string,
    mode: 'custom' | 'auto',
  ): Promise<{
    ok: true
    colorMode: 'custom' | 'auto'
    colorValue: string | null
    previousMode: 'custom' | 'auto'
    previousValue: string | null
  }>
  /** 设置背景不透明度(只改提供的槽位,另一个保持现值;0-1);
      返回 previous 供 LLM 回复原值 */
  setBackgroundOpacity(patches: {
    expanded?: number
    compact?: number
  }): Promise<{
    ok: true
    opacity: { expanded: number; compact: number }
    previous: { expanded: number; compact: number }
  }>
  /** 设置媒体窗口默认宽(160-800;对话图片/视频初始宽);
      返回 previous 供 LLM 回复原值 */
  setMediaWindowSize(width: number): Promise<{ ok: true; width: number; previous: number }>
  /* ---- 多媒体库(2026-08-08):音频库(ArrayBuffer)/ 视频库(路径引用) ---- */
  listAudioLibrary(): Promise<Array<{ id: string; name: string; size: number }>>
  /** 导入音频(data URL 经 executeJavaScript 传入,桥解码为 ArrayBuffer 存库) */
  importAudioLibrary(dataUrl: string, name: string): Promise<{ ok: true; id: string; name: string }>
  renameAudioLibrary(id: string, name: string): Promise<{ ok: true; id: string; name: string }>
  removeAudioLibrary(id: string): Promise<{ ok: true }>
  listVideoLibrary(): Promise<Array<{ id: string; name: string; size: number; path: string }>>
  /** 导入视频(路径引用:校验在工具层,桥只记路径,播放经 island-media 流式) */
  importVideoLibrary(path: string, name: string, size: number): Promise<{ ok: true; id: string; name: string }>
  renameVideoLibrary(id: string, name: string): Promise<{ ok: true; id: string; name: string }>
  removeVideoLibrary(id: string): Promise<{ ok: true }>
  /** 跳转多媒体库视频 tab 并播放指定视频(2026-08-10,LLM 工具
   * play_library_video:校验条目存在后派发 island:media-library-play
   * 事件,WidgetApp 监听展开面板,MediaLibraryView 定位该视频自动播放) */
  playLibraryVideo(id: string): Promise<{ ok: true; id: string; name: string }>
  /* ---- 视频播放设置(2026-08-10,LLM 工具 set_video_config)---- */
  /** 读取当前视频播放设置(音量/速度/循环 + 媒体窗口默认宽 + 是否全屏) */
  getVideoPrefs(): Promise<{
    volume: number
    speed: number
    loop: boolean
    mediaWindowWidth: number
    fullscreen: boolean
  }>
  /** 修改视频播放设置(音量/速度/循环,经 videoPrefs 事件三处播放器
   * 即时同步;返回 previous 供 LLM 回复原值) */
  setVideoPrefs(patch: {
    volume?: number
    speed?: number
    loop?: boolean
  }): Promise<{
    ok: true
    volume: number
    speed: number
    loop: boolean
    previous: { volume: number; speed: number; loop: boolean }
  }>
  /** 进入/退出全屏(enter=true 时把对话窗口内正在播放的视频容器全屏;
   * 无播放中的视频取最后挂载的;false 退出全屏) */
  setFullscreen(enter: boolean): Promise<{ ok: true; fullscreen: boolean }>
  /** 按视频名控制**单个视频**(2026-08-10 多视频独立控制,LLM 工具
   * set_video_config target 参数):音量/倍速/循环写该视频的个性化存储
   * (只影响匹配的视频,其它视频不变),playing 直接播放/暂停。
   * name 缺省 = 对话窗口里正在播放的第一个视频(无播放中的取最后挂载);
   * 找不到抛错(LLM 可先 list_conversation_media 查名字) */
  setVideoState(input: {
    name?: string
    volume?: number
    speed?: number
    loop?: boolean
    playing?: boolean
  }): Promise<{
    ok: true
    name?: string
    playing: boolean
    volume: number
    speed: number
    loop: boolean
  }>
  /** 按音频名控制**单条音频**(2026-08-12,LLM 工具 set_audio_config):
   * 音量/循环写该音频的个性化存储(只影响匹配的音频,其它音频不变),
   * playing 直接播放/暂停。name 缺省 = 对话窗口里正在播放的音频
   * (无播放中的取最后挂载);找不到抛错(LLM 可先 list_conversation_media
   * 查名字) */
  setAudioState(input: {
    name?: string
    volume?: number
    loop?: boolean
    playing?: boolean
  }): Promise<{
    ok: true
    name?: string
    playing: boolean
    volume: number
    loop: boolean
  }>
  /** 对话窗口媒体清单(2026-08-10,LLM 工具 list_conversation_media):
   * 遍历消息气泡 DOM 列出全部媒体附件(图片/视频/音频),视频带播放
   * 状态(播放中/音量/速度/循环/全屏/进度),音频带播放/音量/循环/进度
   * ——LLM 据此回答"对话里有什么媒体、哪个在播放、音量多大" */
  getConversationMedia(): Promise<
    Array<
      | { kind: 'img'; name?: string }
      | {
          kind: 'audio'
          name?: string
          playing: boolean
          volume: number
          loop: boolean
          position: number
          duration: number | null
        }
      | {
          kind: 'video'
          name?: string
          playing: boolean
          volume: number
          speed: number
          loop: boolean
          fullscreen: boolean
          position: number
          duration: number | null
        }
    >
  >
  /**
   * 移除自定义背景(2026-08-10,LLM 工具 remove_background):scope =
   * both(默认,两形态)/ expanded / compact;清除对应槽位图片,裁切
   * 参数复位默认,不透明度保留;返回 removed 列表供 LLM 回复
   */
  removeBackground(scope: 'both' | 'expanded' | 'compact'): Promise<{
    ok: true
    removed: Array<'expanded' | 'compact'>
    previous: { expandedImage: string | null; compactImage: string | null }
  }>
  /**
   * 音频库条目 → 音乐模式播放列表(2026-08-10,LLM 工具
   * add_audio_to_playlist):校验条目存在后派发 island:playlist-import
   * 事件,WidgetApp 监听 → addLibraryTracks(**autoPlay:false,仅入列表
   * 不自动播、不切音乐模式**——2026-08-11 用户要求"除非明确指定切到
   * 音乐模式播放,音频都在对话窗口播放";音频库 ≠ 播放列表,
   * import_audio_library 只进库,不加入播放列表是"LLM 说导入了却播不了"
   * 的根因)
   */
  addAudioLibraryToPlaylist(ids: string[]): Promise<{
    ok: true
    count: number
    names: string[]
  }>
  /**
   * 背景裁切参数(2026-08-11,LLM 工具 set_background_crop):展开态/
   * 紧凑态各自独立的取景(zoom 1-4 / posX 0-100 / posY 0-100),只改
   * 提供的字段;与背景编辑器取景框同款存储(readBackgroundParams +
   * saveBackgroundParams),返回 previous 供 LLM 回复原值
   */
  setBackgroundCrop(patches: {
    expanded?: { zoom?: number; posX?: number; posY?: number }
    compact?: { zoom?: number; posX?: number; posY?: number }
  }): Promise<{
    ok: true
    crop: { expanded: { zoom: number; posX: number; posY: number }; compact: { zoom: number; posX: number; posY: number } }
    previous: { expanded: { zoom: number; posX: number; posY: number }; compact: { zoom: number; posX: number; posY: number } }
  }>
  /**
   * 歌词 API 提供商(2026-08-11,LLM 工具 set_lyric_provider):写入
   * localStorage(widget-lyric-provider + widget-lyric-auto,与设置视图
   * 歌词 API 页同款存储)——**运行时歌词查询每次读 localStorage 即时
   * 生效**(useLyrics/ControlView 提示行每查询读取);设置视图显示状态
   * 在重进时刷新(挂载时读)
   */
  setLyricProvider(
    provider: { id: string; url?: string },
    auto: boolean,
  ): Promise<{
    ok: true
    id: string
    url?: string
    auto: boolean
    previous: { id: string; url?: string; auto: boolean }
  }>
  /** 字体粗细(2026-08-11,LLM 工具 set_font_weight):档位 300-900,
   * 与设置界面同款存储;返回 previous 供 LLM 回复原值 */
  setFontWeight(weight: number): Promise<{ ok: true; weight: number; previous: number }>
  /**
   * 音乐模式播放列表(2026-08-11,LLM 工具 list_playlist /
   * remove_playlist_item):播放列表持久化在 IndexedDB(island-uploads,
   * 与 addTracks/addTrackUrl 的本地文件持久化同源)——listPlaylist 读
   * 库返回全部条目(key + 名称 + 大小);removePlaylistItem 删库条目后
   * 派发 island:playlist-item-removed 事件,WidgetApp 监听 →
   * player.removeTrackByStorageKey(播放列表 state 同步,删当前播放曲目
   * 自动切相邻)
   */
  listPlaylist(): Promise<Array<{ key: string; name: string; size: number }>>
  removePlaylistItem(key: string): Promise<{ ok: true }>
  /** 删除字体库条目(巡检清理用;不暴露给 LLM 工具) */
  deleteFontItem(id: string): Promise<{ ok: true }>
  /** 删除图片库条目(巡检清理用;不暴露给 LLM 工具) */
  deleteLibraryImage(id: string): Promise<{ ok: true }>
}

/** 派发设置变更事件(桥写完存储后调用;UI 监听方按 scope 重读) */
export function emitSettingsChange(scopes: IslandSettingsScope[]): void {
  window.dispatchEvent(new CustomEvent(ISLAND_SETTINGS_EVENT, { detail: { scopes } }))
}

/** 多媒体库"播放指定视频"事件(2026-08-10,LLM 工具 play_library_video):
 * 桥校验条目存在后派发,WidgetApp 监听 → 展开多媒体库面板 + 把视频 id
 * 传给 MediaLibraryView 定位自动播放。与 island-settings-changed 分离:
 * 前者是"存储已变请重读",这里是"跳转并播放"的动作指令 */
export const MEDIA_LIBRARY_PLAY_EVENT = 'island:media-library-play'

/** 派发多媒体库播放请求(带视频条目 id) */
export function emitMediaLibraryPlay(id: string): void {
  window.dispatchEvent(new CustomEvent(MEDIA_LIBRARY_PLAY_EVENT, { detail: { id } }))
}

/** 订阅多媒体库播放请求(返回取消订阅函数) */
export function onMediaLibraryPlay(cb: (id: string) => void): () => void {
  const onEvent = (event: Event) => {
    const id = (event as CustomEvent<{ id?: unknown }>).detail?.id
    if (typeof id === 'string' && id) cb(id)
  }
  window.addEventListener(MEDIA_LIBRARY_PLAY_EVENT, onEvent)
  return () => window.removeEventListener(MEDIA_LIBRARY_PLAY_EVENT, onEvent)
}

/** 音频库 → 播放列表导入事件(2026-08-10,LLM 工具 add_audio_to_playlist):
 * 桥校验条目后派发,WidgetApp 监听 → player.addLibraryTracks(自动播
 * 首曲)+ setMode('music')。与 island:media-library-play 同款"动作指令"
 * 事件(桥不直接操作 React hook) */
export const PLAYLIST_IMPORT_EVENT = 'island:playlist-import'

/** 音频库条目(播放列表导入载荷) */
export interface PlaylistImportItem {
  name: string
  type: string
  data: ArrayBuffer
}

/** 派发播放列表导入请求(带音频条目;WidgetApp 消费) */
export function emitPlaylistImport(items: PlaylistImportItem[]): void {
  window.dispatchEvent(new CustomEvent(PLAYLIST_IMPORT_EVENT, { detail: { items } }))
}

/** 订阅播放列表导入请求(返回取消订阅函数) */
export function onPlaylistImport(cb: (items: PlaylistImportItem[]) => void): () => void {
  const onEvent = (event: Event) => {
    const items = (event as CustomEvent<{ items?: PlaylistImportItem[] }>).detail?.items
    if (Array.isArray(items) && items.length > 0) cb(items)
  }
  window.addEventListener(PLAYLIST_IMPORT_EVENT, onEvent)
  return () => window.removeEventListener(PLAYLIST_IMPORT_EVENT, onEvent)
}

/** 播放列表条目删除事件(2026-08-11,LLM 工具 remove_playlist_item):
 * 桥删 IndexedDB 后派发,WidgetApp 监听 → player.removeTrackByStorageKey
 * (播放列表 state 与持久化存储同步;删当前播放曲目自动切相邻) */
export const PLAYLIST_REMOVE_EVENT = 'island:playlist-item-removed'

/** 派发播放列表条目删除请求(带持久化 key) */
export function emitPlaylistItemRemoved(key: string): void {
  window.dispatchEvent(new CustomEvent(PLAYLIST_REMOVE_EVENT, { detail: { key } }))
}

/** 订阅播放列表条目删除(返回取消订阅函数) */
export function onPlaylistItemRemoved(cb: (key: string) => void): () => void {
  const onEvent = (event: Event) => {
    const key = (event as CustomEvent<{ key?: unknown }>).detail?.key
    if (typeof key === 'string' && key) cb(key)
  }
  window.addEventListener(PLAYLIST_REMOVE_EVENT, onEvent)
  return () => window.removeEventListener(PLAYLIST_REMOVE_EVENT, onEvent)
}

/**
 * 订阅设置变更(按 scope 过滤;返回取消订阅函数)。
 * 统一事件名/载荷类型/注销语义——调用方不再写裸字符串与强转
 * (2026-08-06 架构优化:消字面量漂移,见 tsconfig.electron 审计)
 */
export function onSettingsChange(
  scopes: IslandSettingsScope[],
  cb: (scopes: IslandSettingsScope[]) => void,
): () => void {
  const onEvent = (event: Event) => {
    const got = (event as CustomEvent<{ scopes?: IslandSettingsScope[] }>).detail?.scopes ?? []
    if (scopes.some((s) => got.includes(s))) cb(got)
  }
  window.addEventListener(ISLAND_SETTINGS_EVENT, onEvent)
  return () => window.removeEventListener(ISLAND_SETTINGS_EVENT, onEvent)
}

/** 通知 UI 重读对应状态域(桥内部用) */
function notify(scopes: IslandSettingsScope[]) {
  emitSettingsChange(scopes)
}

function hexColor(color: string): string {
  const t = String(color ?? '').trim()
  const hex = t.startsWith('#') ? t : `#${t}`
  return hex.toLowerCase()
}

/** 读取当前 Agent 界面缩放(localStorage;钳制 100-400,缺省 200)。
 * 设置桥(set_agent_scale 工具读现值)与 useAgentPanelLayout(缩放状态
 * 初始化)共用,收敛两处独立 clamp(审计 P2) */
export function readAgentScale(): number {
  try {
    const raw = localStorage.getItem(AGENT_SCALE_STORAGE_KEY)
    if (raw) {
      const n = Number(raw)
      if (Number.isFinite(n)) return Math.min(400, Math.max(100, Math.round(n)))
    }
  } catch {
    // 读取失败按默认
  }
  return 200
}

/** 读取媒体窗口默认宽(localStorage;钳制 160-800,缺省 320)。
 * 设置桥(set_media_window_size 工具读现值)/ WidgetApp / MediaFrame
 * 共用,与 readAgentScale 同款单一来源 */
export function readMediaWindowWidth(): number {
  try {
    const raw = localStorage.getItem(MEDIA_WINDOW_STORAGE_KEY)
    if (raw) {
      const n = Number(raw)
      if (Number.isFinite(n)) return Math.min(800, Math.max(160, Math.round(n)))
    }
  } catch {
    // 读取失败按默认
  }
  return 320
}

// ---- 音乐控制桥(2026-08-12,QQ 远程控制 / 后台对话:主进程经
// executeJavaScript 调 window.__islandMusicControl → 外部平台(SMTC)
// 优先,本地播放器兜底——与 WidgetApp 现有控制逻辑一致) ----
export interface IslandMusicControl {
  /** 播放控制:play / pause / next / previous(切歌) */
  control(action: 'play' | 'pause' | 'next' | 'previous'): Promise<{ ok: boolean; action: string }>
  /** 当前播放状态(LLM 回答"现在放什么"用) */
  status(): {
    external: boolean
    playing: boolean
    title: string | null
    artist: string | null
    position: number
    duration: number
  }
}

export function registerMusicControlBridge(deps: {
  getExternalActive(): boolean
  systemControl(action: 'play' | 'pause' | 'next' | 'previous'): Promise<boolean | undefined>
  /** 惰性读取(实时状态:phase/track/position 随播放变化,闭包捕获
   * 首次渲染值会读到旧状态) */
  getPlayer(): {
    phase: string
    track: { title: string; artist: string } | null
    position: number
    duration: number
    play(): void
    pause(): void
    next(): void
    previous(): void
  }
  getSystem(): {
    track: { title: string; artist: string } | null
    playing: boolean
    position: number
    duration: number
  }
}): void {
  if (window.__islandMusicControl) return
  const bridge: IslandMusicControl = {
    async control(action) {
      if (deps.getExternalActive()) {
        await deps.systemControl(action)
      } else {
        const p = deps.getPlayer()
        if (action === 'play') p.play()
        else if (action === 'pause') p.pause()
        else if (action === 'next') p.next()
        else if (action === 'previous') p.previous()
      }
      return { ok: true, action }
    },
    status() {
      const external = deps.getExternalActive()
      const src = external ? deps.getSystem() : deps.getPlayer()
      return {
        external,
        playing: external ? deps.getSystem().playing : deps.getPlayer().phase === 'playing',
        title: src.track?.title ?? null,
        artist: src.track?.artist ?? null,
        position: Math.round(src.position || 0),
        duration: Math.round(src.duration || 0),
      }
    },
  }
  window.__islandMusicControl = bridge
}

export function registerIslandSettingsBridge(): void {
  if (window.__islandSettings) return
  const bridge: IslandSettingsBridge = {
    // 设置快照:LLM 修改前先查(get_island_settings 工具);setter 也都带
    // previous 原值,回复可准确说「从 X 调整为 Y」
    async getSettings() {
      let themeColor: string | null = null
      try {
        themeColor = localStorage.getItem(THEME_STORAGE_KEY)
      } catch {
        // 读取失败按未设置
      }
      const font = loadFontSettings()
      const fontItems = await loadFontItems()
      const currentFont = fontItems.find((f) => f.id === font.currentFontId)
      return {
        themeColor,
        agentScale: readAgentScale(),
        fontColorMode: font.colorMode,
        fontColorValue: font.colorValue,
        currentFontId: font.currentFontId,
        currentFontName: currentFont?.name ?? null,
        // 与 WidgetApp 共用同一读取(含旧版单数值/单独键迁移,旧数据下
        // LLM 不会读到 0.4 默认值而 UI 显示真实值)
        backgroundOpacity: readBackgroundParams().opacity,
        mediaWindowWidth: readMediaWindowWidth(),
        video: {
          ...loadVideoPrefs(),
          fullscreen: Boolean(document.fullscreenElement),
        },
      }
    },
    // 主题色:写 localStorage,UI 经事件重读(WidgetApp setCustomTheme)
    async setThemeColor(color) {
      const hex = hexColor(color)
      let previous: string | null = null
      try {
        previous = localStorage.getItem(THEME_STORAGE_KEY)
      } catch {
        // 读取失败按未设置
      }
      try {
        localStorage.setItem(THEME_STORAGE_KEY, hex)
      } catch {
        // 存储失败(如隐私模式)仍按成功处理,UI 层重读不到就保持原样
      }
      notify(['theme'])
      return { ok: true, color: hex, previous }
    },
    // Agent 界面缩放:写 localStorage,UI 经事件重读(DynamicIsland agentScale)
    async setAgentScale(percent) {
      const scale = Math.min(400, Math.max(100, Math.round(Number(percent) || 100)))
      const previous = readAgentScale()
      try {
        localStorage.setItem(AGENT_SCALE_STORAGE_KEY, String(scale))
      } catch {
        // 同上
      }
      notify(['scale'])
      return { ok: true, scale, previous }
    },
    // 字体导入:入库并应用为当前字体(与设置界面字体上传一致)
    async importFont(dataUrl, name) {
      const item: FontLibraryItem = {
        id: genFontId(),
        name: String(name ?? '导入字体').slice(0, 50),
        dataUrl: String(dataUrl),
        createdAt: Date.now(),
      }
      await saveFontItem(item)
      const settings = loadFontSettings()
      saveFontSettings({ ...settings, currentFontId: item.id })
      notify(['font'])
      return { ok: true, id: item.id, name: item.name }
    },
    async listFonts() {
      const items = await loadFontItems()
      return items.map((f) => ({ id: f.id, name: f.name }))
    },
    async renameFont(id, name) {
      const items = await loadFontItems()
      const item = items.find((f) => f.id === id)
      if (!item) throw new Error(`字体不存在:${id}`)
      await saveFontItem({ ...item, name: String(name ?? '').slice(0, 50) })
      notify(['font'])
      return { ok: true, id, name: item.name }
    },
    // 背景导入:降采样(长边 ≤1024,与上传同款防卡顿)→ 展开/紧凑
    // 两槽位都应用(任意形态立即可见)→ 自动入库(名称按传入的)
    async importBackground(dataUrl, name) {
      const small = await downscaleBackgroundImage(String(dataUrl))
      await Promise.all([
        saveBackgroundImage(small, 'expanded'),
        saveBackgroundImage(small, 'compact'),
      ])
      const item: ImageLibraryItem = {
        id: genImageId(),
        name: String(name ?? '导入背景').slice(0, 50),
        dataUrl: small,
        createdAt: Date.now(),
      }
      await saveImageItem(item)
      notify(['background', 'imageLibrary'])
      return { ok: true, id: item.id, name: item.name }
    },
    async listLibraryImages() {
      const items = await loadImageItems()
      return items.map((img) => ({ id: img.id, name: img.name }))
    },
    async renameLibraryImage(id, name) {
      const items = await loadImageItems()
      const item = items.find((img) => img.id === id)
      if (!item) throw new Error(`图片不存在:${id}`)
      await saveImageItem({ ...item, name: String(name ?? '').slice(0, 50) })
      notify(['imageLibrary'])
      return { ok: true, id, name: item.name }
    },
    // 文字颜色:custom = 写入自定义 hex 并切自定义模式;auto = 恢复
    // 自动亮度(清掉自定义值);UI 经事件重读字体设置(含 colorMode/colorValue);
    // 返回 previous 原值供 LLM 回复
    async setFontColor(color, mode) {
      const settings = loadFontSettings()
      const previousMode = settings.colorMode
      const previousValue = settings.colorValue
      if (mode === 'custom') {
        settings.colorMode = 'custom'
        settings.colorValue = hexColor(color)
      } else {
        settings.colorMode = 'auto'
        settings.colorValue = null
      }
      saveFontSettings(settings)
      notify(['font'])
      return {
        ok: true,
        colorMode: settings.colorMode,
        colorValue: settings.colorValue,
        previousMode,
        previousValue,
      }
    },
    // 背景不透明度:读现有参数(含裁切)只改对应槽位后写回(与 WidgetApp
    // 共用 backgroundStore 的读写,旧数据迁移行为一致);UI 经事件重读;
    // 返回 previous 原值供 LLM 回复
    async setBackgroundOpacity(patches) {
      const previous = readBackgroundParams()
      const clamp01 = (v: unknown): number =>
        Math.min(1, Math.max(0, Math.round(Number(v) * 1000) / 1000))
      const opacity = {
        expanded:
          patches.expanded !== undefined ? clamp01(patches.expanded) : previous.opacity.expanded,
        compact:
          patches.compact !== undefined ? clamp01(patches.compact) : previous.opacity.compact,
      }
      saveBackgroundParams({ ...previous, opacity })
      notify(['background'])
      return { ok: true, opacity, previous: previous.opacity }
    },
    /* ---- 多媒体库(2026-08-08) ---- */
    async listAudioLibrary() {
      const items = await loadAudioLibrary()
      return items.map((it) => ({ id: it.id, name: it.name, size: it.data.byteLength }))
    },
    async importAudioLibrary(dataUrl, name) {
      const item = {
        id: genLibraryId('audio'),
        name: String(name ?? '导入音频').slice(0, 100),
        type: dataUrl.slice(5, dataUrl.indexOf(';')) || 'audio/mpeg',
        // data URL → ArrayBuffer(base64 解码;executeJavaScript 只能传 JSON)
        data: (() => {
          const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
          const bin = atob(base64)
          const buf = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
          return buf.buffer
        })(),
        createdAt: Date.now(),
      }
      await saveAudioItem(item)
      notify(['mediaLibrary'])
      return { ok: true, id: item.id, name: item.name }
    },
    async renameAudioLibrary(id, name) {
      const items = await loadAudioLibrary()
      const item = items.find((it) => it.id === id)
      if (!item) throw new Error(`音频不存在:${id}`)
      await saveAudioItem({ ...item, name: String(name ?? '').trim().slice(0, 100) })
      notify(['mediaLibrary'])
      return { ok: true, id, name: item.name }
    },
    async removeAudioLibrary(id) {
      await removeAudioItem(id)
      notify(['mediaLibrary'])
      return { ok: true }
    },
    async listVideoLibrary() {
      const items = await loadVideoLibrary()
      return items.map((it) => ({ id: it.id, name: it.name, size: it.size, path: it.path }))
    },
    async importVideoLibrary(path, name, size) {
      const item = {
        id: genLibraryId('video'),
        name: String(name ?? '导入视频').slice(0, 100),
        path: String(path),
        size: Number(size) || 0,
        createdAt: Date.now(),
      }
      await saveVideoItem(item)
      notify(['mediaLibrary'])
      return { ok: true, id: item.id, name: item.name }
    },
    async renameVideoLibrary(id, name) {
      const items = await loadVideoLibrary()
      const item = items.find((it) => it.id === id)
      if (!item) throw new Error(`视频不存在:${id}`)
      await saveVideoItem({ ...item, name: String(name ?? '').trim().slice(0, 100) })
      notify(['mediaLibrary'])
      return { ok: true, id, name: item.name }
    },
    async removeVideoLibrary(id) {
      await removeVideoItem(id)
      notify(['mediaLibrary'])
      return { ok: true }
    },
    // 跳转多媒体库播放指定视频(2026-08-10):校验条目存在(不存在抛错,
    // LLM 可自纠)后派发事件,UI 侧展开面板 + 定位播放
    async playLibraryVideo(id) {
      const items = await loadVideoLibrary()
      const item = items.find((it) => it.id === id)
      if (!item) throw new Error(`视频不存在:${id}(用 list_video_library 查 id)`)
      emitMediaLibraryPlay(id)
      return { ok: true, id: item.id, name: item.name }
    },
    // 视频播放设置(2026-08-10,LLM 工具 set_video_config):
    // 音量/速度/循环经 videoPrefs 共享模块写入 → island:video-prefs 事件
    // → 三处播放器(VideoPlayer/视频岛/多媒体库)订阅实时应用
    async getVideoPrefs() {
      const p = loadVideoPrefs()
      return {
        volume: p.volume,
        speed: p.speed,
        loop: p.loop,
        mediaWindowWidth: readMediaWindowWidth(),
        fullscreen: Boolean(document.fullscreenElement),
      }
    },
    async setVideoPrefs(patch) {
      const previous = loadVideoPrefs()
      saveVideoPrefs({
        volume: patch.volume !== undefined ? Number(patch.volume) : undefined,
        speed: patch.speed !== undefined ? Number(patch.speed) : undefined,
        loop: patch.loop !== undefined ? Boolean(patch.loop) : undefined,
      })
      const p = loadVideoPrefs()
      return { ok: true, volume: p.volume, speed: p.speed, loop: p.loop, previous }
    },
    // 按名字控制单个视频(2026-08-10 多视频独立控制):音量/倍速/循环
    // 写该视频个性化存储(key = data-media-name,与 VideoPlayer videoKey
    // 同源)→ island:video-prefs 事件(带 key)→ 匹配的播放器订阅应用,
    // 其它视频不受影响;playing 直接操作 video 元素(play/pause 触发
    // onPlay/onPause,组件播放状态自然同步)
    async setVideoState(input) {
      const frames = [...document.querySelectorAll<HTMLElement>('.island-media-frame')]
        .map((frame) => ({ frame, video: frame.querySelector<HTMLVideoElement>('video') }))
        .filter((x) => x.video)
      if (frames.length === 0) {
        throw new Error('对话窗口当前没有视频(用 list_conversation_media 查看)')
      }
      let target =
        input.name !== undefined
          ? frames.find((f) => (f.frame.getAttribute('data-media-name') ?? '') === input.name)
          : frames.find((f) => !f.video!.paused) ?? frames[frames.length - 1]
      if (!target) {
        throw new Error(`对话窗口没有名为「${input.name}」的视频(用 list_conversation_media 查看可用的名字)`)
      }
      const v = target.video!
      const key = target.frame.getAttribute('data-media-name') || undefined
      const prefsPatch: { volume?: number; speed?: number; loop?: boolean } = {}
      if (input.volume !== undefined) {
        const vol = Number(input.volume)
        if (!Number.isFinite(vol)) throw new Error('volume 需要是 0-1 的数字')
        prefsPatch.volume = Math.min(1, Math.max(0, vol))
      }
      if (input.speed !== undefined) {
        const spd = Number(input.speed)
        if (!Number.isFinite(spd)) throw new Error('speed 需要是 0.5-2 的数字')
        prefsPatch.speed = Math.min(2, Math.max(0.5, spd))
      }
      if (input.loop !== undefined) prefsPatch.loop = Boolean(input.loop)
      if (Object.keys(prefsPatch).length > 0) saveVideoPrefs(prefsPatch, key)
      if (input.playing === true) void v.play().catch(() => {})
      else if (input.playing === false) v.pause()
      return {
        ok: true,
        name: target.frame.getAttribute('data-media-name') || undefined,
        playing: !v.paused,
        volume: Math.round((v.volume || 0) * 100),
        speed: v.playbackRate || 1,
        loop: v.loop,
      }
    },
    // 按名字控制单条音频(2026-08-12,LLM 工具 set_audio_config):
    // 音量/循环写该音频个性化存储(audioPrefs,key = data-media-name,
    // 与 VoiceBubble 的 alt 同源)→ island:audio-prefs 事件(带 key)→
    // 匹配的语音气泡订阅应用,其它音频不受影响;playing 直接操作 audio
    // 元素(play/pause 触发 onPlay/onPause,组件播放状态自然同步)
    async setAudioState(input) {
      const voices = [...document.querySelectorAll<HTMLElement>('.island-agent-voice')]
        .map((voice) => ({ voice, audio: voice.querySelector<HTMLAudioElement>('audio') }))
        .filter((x) => x.audio)
      if (voices.length === 0) {
        throw new Error('对话窗口当前没有音频(用 list_conversation_media 查看)')
      }
      let target =
        input.name !== undefined
          ? voices.find((v) => (v.voice.getAttribute('data-media-name') ?? '') === input.name)
          : voices.find((v) => !v.audio!.paused) ?? voices[voices.length - 1]
      if (!target) {
        throw new Error(`对话窗口没有名为「${input.name}」的音频(用 list_conversation_media 查看可用的名字)`)
      }
      const a = target.audio!
      const key = target.voice.getAttribute('data-media-name') || undefined
      const prefsPatch: { volume?: number; loop?: boolean } = {}
      if (input.volume !== undefined) {
        const vol = Number(input.volume)
        if (!Number.isFinite(vol)) throw new Error('volume 需要是 0-1 的数字')
        prefsPatch.volume = Math.min(1, Math.max(0, vol))
      }
      if (input.loop !== undefined) prefsPatch.loop = Boolean(input.loop)
      if (Object.keys(prefsPatch).length > 0) setAudioPrefs(prefsPatch, key)
      if (input.playing === true) void a.play().catch(() => {})
      else if (input.playing === false) a.pause()
      return {
        ok: true,
        name: target.voice.getAttribute('data-media-name') || undefined,
        playing: !a.paused,
        volume: Math.round((a.volume || 0) * 100),
        loop: a.loop,
      }
    },
    // 全屏切换(2026-08-10):enter=true 把对话窗口内**正在播放**的视频
    // 容器全屏(优先非 paused,无播放中的取最后挂载的);false 退出全屏
    async setFullscreen(enter) {
      if (enter && !document.fullscreenElement) {
        const videos = [...document.querySelectorAll<HTMLVideoElement>('.island-media-frame video')]
        const v = videos.find((el) => !el.paused) ?? videos[videos.length - 1]
        const frame = v?.closest<HTMLElement>('.island-media-frame')
        if (frame) void frame.requestFullscreen().catch(() => {})
      } else if (!enter && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {})
      }
      return { ok: true, fullscreen: Boolean(document.fullscreenElement) }
    },
    // 对话窗口媒体清单(2026-08-10):遍历消息气泡 DOM(媒体附件都在
    // .island-media-frame 或 .island-agent-voice 内;视频岛/多媒体库的
    // 播放器不在这些容器里,不列入——语义 = 对话窗口内的附件)
    async getConversationMedia() {
      const items: Array<
        | { kind: 'img'; name?: string }
        | {
            kind: 'audio'
            name?: string
            playing: boolean
            volume: number
            loop: boolean
            position: number
            duration: number | null
          }
        | {
            kind: 'video'
            name?: string
            playing: boolean
            volume: number
            speed: number
            loop: boolean
            fullscreen: boolean
            position: number
            duration: number | null
          }
      > = []
      for (const frame of document.querySelectorAll<HTMLElement>('.island-media-frame')) {
        const video = frame.querySelector('video')
        const img = frame.querySelector('img')
        const name = frame.getAttribute('data-media-name') || undefined
        if (video) {
          items.push({
            kind: 'video',
            name,
            playing: !video.paused,
            volume: Math.round((video.volume || 0) * 100),
            speed: video.playbackRate || 1,
            loop: video.loop,
            fullscreen: Boolean(
              document.fullscreenElement === frame ||
                document.fullscreenElement?.contains(video),
            ),
            position: Math.round(video.currentTime || 0),
            duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
          })
        } else if (img) {
          items.push({ kind: 'img', name })
        }
      }
      for (const voice of document.querySelectorAll<HTMLElement>('.island-agent-voice')) {
        const audio = voice.querySelector('audio')
        // 2026-08-12:音频条目扩展音量/循环/进度(set_audio_config 调整前
        // 先查当前值;name 优先 data-media-name(= VoiceBubble 的 alt),
        // 回退旧 title 格式)
        items.push({
          kind: 'audio',
          name: voice.getAttribute('data-media-name') || voice.getAttribute('title')?.replace(/^语音:/, '') || undefined,
          playing: audio ? !audio.paused : false,
          volume: audio ? Math.round((audio.volume || 0) * 100) : 100,
          loop: audio ? audio.loop : false,
          position: audio ? Math.round(audio.currentTime || 0) : 0,
          duration: audio && Number.isFinite(audio.duration) ? Math.round(audio.duration) : null,
        })
      }
      return items
    },
    // 媒体窗口默认宽(2026-08-08):写 localStorage,UI 经事件重读;
    // 返回 previous 供 LLM 回复原值
    async setMediaWindowSize(width) {
      const n = Math.min(800, Math.max(160, Math.round(Number(width) || 320)))
      const previous = readMediaWindowWidth()
      try {
        localStorage.setItem(MEDIA_WINDOW_STORAGE_KEY, String(n))
      } catch {
        // 存储失败(隐私模式等)仍按成功处理,UI 层重读不到就保持原样
      }
      notify(['mediaWindow'])
      return { ok: true, width: n, previous }
    },
    // 背景裁切参数(2026-08-11,LLM 工具 set_background_crop):与背景
    // 编辑器取景框同款存储——读现有参数只改提供的字段后写回;
    // zoom 1-4 / posX,posY 0-100 钳制;返回 previous 供 LLM 回复
    async setBackgroundCrop(patches) {
      const previous = readBackgroundParams()
      const clamp01 = (v: unknown, max: number, min = 0): number =>
        Math.min(max, Math.max(min, Math.round(Number(v) * 100) / 100))
      const merge = (
        base: { zoom: number; posX: number; posY: number },
        patch: { zoom?: number; posX?: number; posY?: number } | undefined,
      ) => ({
        zoom: patch?.zoom !== undefined ? clamp01(patch.zoom, 4, 1) : base.zoom,
        posX: patch?.posX !== undefined ? clamp01(patch.posX, 100) : base.posX,
        posY: patch?.posY !== undefined ? clamp01(patch.posY, 100) : base.posY,
      })
      const crop = {
        expanded: merge(previous.expanded, patches?.expanded),
        compact: merge(previous.compact, patches?.compact),
      }
      saveBackgroundParams({ ...previous, ...crop })
      notify(['background'])
      return { ok: true, crop, previous: { expanded: previous.expanded, compact: previous.compact } }
    },
    // 歌词 API 提供商(2026-08-11,LLM 工具 set_lyric_provider):写
    // localStorage(与设置视图同款存储);运行时每查询读取,即时生效
    async setLyricProvider(provider, auto) {
      const prevProvider = loadLyricProvider()
      const prevAuto = loadLyricAuto()
      const p = {
        id: String(provider?.id ?? ''),
        name: '',
        type: '',
        url: typeof provider?.url === 'string' ? provider.url : undefined,
      }
      saveLyricProvider(p as LyricProvider)
      saveLyricAuto(Boolean(auto))
      notify(['lyric'])
      return { ok: true, id: p.id, url: p.url, auto: Boolean(auto), previous: { id: prevProvider.id, url: prevProvider.url, auto: prevAuto } }
    },
    // 字体粗细(2026-08-11,LLM 工具 set_font_weight):档位 300-900 校验
    // 后写字体设置(与设置界面字重按钮同款);返回 previous 供 LLM 回复
    async setFontWeight(weight) {
      const settings = loadFontSettings()
      const previous = settings.weight
      const w = Number(weight)
      if (!FONT_WEIGHTS.includes(w)) throw new Error(`字重仅支持:${FONT_WEIGHTS.join('/')}`)
      saveFontSettings({ ...settings, weight: w })
      notify(['font'])
      return { ok: true, weight: w, previous }
    },
    // 播放列表查看/删除(2026-08-11,LLM 工具 list_playlist /
    // remove_playlist_item):播放列表持久化在 IndexedDB(island-uploads,
    // addTracks 上传 / addTrackUrl 本地文件持久化同源)——list 读库;
    // remove 删库后派发事件,WidgetApp 经 player.removeTrackByStorageKey
    // 同步播放列表 state(删当前播放曲目自动切相邻)
    async listPlaylist() {
      const items = await loadUploads()
      return items.map((it) => ({ key: it.key, name: it.name, size: it.data.byteLength }))
    },
    async removePlaylistItem(key) {
      if (!key || typeof key !== 'string') throw new Error('key 不能为空')
      await removeUpload(key)
      emitPlaylistItemRemoved(key)
      return { ok: true }
    },
    // 移除背景(2026-08-10,LLM 工具 remove_background):清槽位图片 +
    // 裁切复位默认(与设置界面"移除背景"一致),不透明度保留;返回
    // removed 列表与 previous(LLM 回复「已移除展开态背景」)
    async removeBackground(scope) {
      const previous = {
        expandedImage: await loadBackgroundImage('expanded'),
        compactImage: await loadBackgroundImage('compact'),
      }
      const removed: Array<'expanded' | 'compact'> = []
      const slots = scope === 'both' ? (['expanded', 'compact'] as const) : [scope]
      for (const slot of slots) {
        if (slot === 'expanded' ? previous.expandedImage : previous.compactImage) {
          await clearBackgroundImage(slot)
          removed.push(slot)
        }
      }
      // 裁切复位(移除后保留不透明度,与 UI 移除行为一致)
      const params = readBackgroundParams()
      if (removed.includes('expanded')) params.expanded = { ...DEFAULT_BG_CROP }
      if (removed.includes('compact')) params.compact = { ...DEFAULT_BG_CROP }
      saveBackgroundParams(params)
      notify(['background'])
      return { ok: true, removed, previous }
    },
    // 音频库 → 播放列表(2026-08-10,LLM 工具 add_audio_to_playlist;
    // 2026-08-11 改语义:仅入列表不自动播不切模式,见接口注释):
    // 校验条目存在(不存在抛错,LLM 可自纠)后派发事件,WidgetApp 监听
    // 以 autoPlay:false 导入播放列表
    async addAudioLibraryToPlaylist(ids) {
      const items = await loadAudioLibrary()
      const picked = items.filter((it) => (ids ?? []).includes(it.id))
      if (picked.length === 0) {
        throw new Error(
          `音频库中没有这些条目:${(ids ?? []).join('、')}(用 list_audio_library 查可用 id)`,
        )
      }
      emitPlaylistImport(
        picked.map((it) => ({ name: it.name, type: it.type || 'audio/mpeg', data: it.data })),
      )
      return { ok: true, count: picked.length, names: picked.map((it) => it.name) }
    },
    // 删除(巡检清理用;LLM 工具不暴露,防误删用户数据)
    async deleteFontItem(id) {
      await deleteFontItemStore(id)
      notify(['font'])
      return { ok: true }
    },
    async deleteLibraryImage(id) {
      await deleteImageItem(id)
      notify(['imageLibrary'])
      return { ok: true }
    },
  }
  window.__islandSettings = bridge
}

declare global {
  interface Window {
    __islandSettings?: IslandSettingsBridge
    /** 音乐控制桥(2026-08-12:QQ 远程控制 / 后台对话经主进程调用) */
    __islandMusicControl?: IslandMusicControl
  }
}

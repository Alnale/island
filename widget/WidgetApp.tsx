import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { DynamicIsland } from '../src/components/DynamicIsland'
import type { IslandState, TrackInfo } from '../src/data/islandStates'
import { useLyrics } from '../src/hooks/useLyrics'
import { useSystemMedia, type SystemControlAction } from '../src/hooks/useSystemMedia'
import {
  clearBackgroundImage,
  DEFAULT_BG_CROP,
  downscaleBackgroundImage,
  loadBackgroundImage,
  migrateLegacyBackground,
  saveBackgroundImage,
  type BackgroundState,
} from '../src/media/backgroundStore'
import {
  deleteFontItem,
  loadFontItems,
  loadFontSettings,
  saveFontItem,
  saveFontSettings,
  type FontColorMode,
  type FontLibraryItem,
} from '../src/media/fontStore'
import {
  deleteImageItem,
  genImageId,
  loadImageItems,
  saveImageItem,
  type ImageLibraryItem,
} from '../src/media/backgroundStore'
import { PLAY_MODES, type PlaybackMode } from '../src/media/playbackModes'
import { useMediaPlayer } from '../src/media/useMediaPlayer'

const THEME_STORAGE_KEY = 'widget-theme-color'
/** 背景裁切/不透明度参数持久化键(图片本体在 IndexedDB) */
const BACKGROUND_KEY = 'widget-background'
/** 旧版单独存储的不透明度键(兼容读取) */
const BACKGROUND_OPACITY_KEY = 'widget-background-opacity'
/** 挂件窗口常规高度(与 electron/main.cjs 的 WINDOW_H 一致) */
const WINDOW_H = 280
/** 背景编辑器视图的窗口高度(岛体加高到 440 + 余量) */
const BG_VIEW_WINDOW_H = 480
/**
 * 视图 → 窗口高度映射(岛体高度 + 顶部 8px 定位余量 + 缓冲):
 * 背景编辑器 / 库页面用大面板(480);自定义颜色页 352px 岛体
 * (SV 取色面需要高度),非常规高度需在此登记
 */
const VIEW_WINDOW_H: Record<string, number> = {
  background: BG_VIEW_WINDOW_H,
  'font-library': BG_VIEW_WINDOW_H,
  'image-library': BG_VIEW_WINDOW_H,
  'font-color': 364,
  theme: 364,
}

/** 默认裁切(cover 居中,与 backgroundStore 一致) */
const DEFAULT_CROP = DEFAULT_BG_CROP

/**
 * 桌面挂件版灵动岛:
 * 只渲染灵动岛本体(无演示页面),数据源与完整版一致——
 * 系统媒体监听(SMTC)优先,本地播放器兜底。
 *
 * 鼠标穿透由 stage 容器(岛体 + 展开面板)的 mouseenter/leave 驱动,
 * 事件冒泡不受组件内部 hover 屏蔽影响:进入岛体才接收鼠标,离开立即穿透,
 * 展开面板期间移出也能可靠恢复(修复"面板收不回来"的卡死感)。
 * 移动挂件:右键长按(~0.4s)进入拖拽模式后拖动(主进程按屏幕工作区
 * 钳制,不会拖出桌面);快速右键点击/快速右键拖动不做任何事。
 */
export default function WidgetApp() {
  const player = useMediaPlayer()
  const system = useSystemMedia()
  // 操作结果提示(模式/跳转不被客户端接受时在岛内短暂显示:
  // 紧凑态 = 左侧文字区文字,展开态 = 播放键下方,均为岛体原生文本样式)
  const [hint, setHint] = useState<string | null>(null)
  const hintTimerRef = useRef(0)
  const showHint = useCallback((text: string) => {
    setHint(text)
    window.clearTimeout(hintTimerRef.current)
    hintTimerRef.current = window.setTimeout(() => setHint(null), 2600)
  }, [])
  // 卸载时清理提示计时器
  useEffect(() => () => window.clearTimeout(hintTimerRef.current), [])
  // 数据源开关:默认外部监听优先,点击灵动岛音乐图标在"本地播放器 ↔ 系统监听"间切换
  const [useExternalSource, setUseExternalSource] = useState(true)
  // useCallback:引用稳定,配合 DynamicIsland(React.memo)跳过无效渲染。
  // 依赖只列动态值(player.pause/system.control 等方法均为稳定引用,
  // player/system 对象本身每次渲染新建,列入会使回调失去稳定性)
  /* eslint-disable react-hooks/exhaustive-deps */
  const handleToggleSource = useCallback(() => {
    const next = !useExternalSource
    setUseExternalSource(next)
    // 双向互斥:切到监听模式暂停本地播放,切到本地模式暂停外部播放,
    // 避免双声齐响;切回时保持暂停状态,由用户手动继续
    if (next) {
      player.pause()
    } else {
      void system.control('pause')
    }
  }, [useExternalSource])
  /* eslint-enable react-hooks/exhaustive-deps */
  // 外部平台播放模式(前端跟踪,点击循环:顺序→单曲循环→随机→顺序)
  const [externalMode, setExternalMode] = useState<PlaybackMode>('sequence')
  // 自定义主题色(null = 跟随播放模式/状态色),持久化到 localStorage
  const [customTheme, setCustomTheme] = useState<string | null>(() => {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY)
    } catch {
      return null
    }
  })
  const applyCustomTheme = useCallback((color: string | null) => {
    setCustomTheme(color)
    try {
      if (color) localStorage.setItem(THEME_STORAGE_KEY, color)
      else localStorage.removeItem(THEME_STORAGE_KEY)
    } catch {
      // 忽略存储失败
    }
  }, [])
  // 自定义背景(托盘菜单"自定义背景"入口,岛内视图编辑):
  // 图片持久化到 IndexedDB,裁切/不透明度参数走 localStorage
  const [background, setBackground] = useState<BackgroundState>(() => {
    // 不透明度按形态独立(旧版单一数值自动迁移为双槽位)
    let opacity: { expanded: number; compact: number } = { expanded: 0.4, compact: 0.4 }
    const expanded = { ...DEFAULT_CROP }
    const compact = { ...DEFAULT_CROP }
    const readCrop = (
      c: Partial<{ zoom: number; posX: number; posY: number }> | null | undefined,
    ): { zoom: number; posX: number; posY: number } => ({
      zoom: typeof c?.zoom === 'number' && c.zoom >= 1 && c.zoom <= 4 ? c.zoom : DEFAULT_CROP.zoom,
      posX:
        typeof c?.posX === 'number' && c.posX >= 0 && c.posX <= 100 ? c.posX : DEFAULT_CROP.posX,
      posY:
        typeof c?.posY === 'number' && c.posY >= 0 && c.posY <= 100 ? c.posY : DEFAULT_CROP.posY,
    })
    try {
      const raw = localStorage.getItem(BACKGROUND_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as {
          opacity?: unknown
          expanded?: Partial<{ zoom: number; posX: number; posY: number }>
          compact?: Partial<{ zoom: number; posX: number; posY: number }>
          // 旧版单形态字段(迁移:旧裁切归展开态,紧凑态保持默认)
          zoom?: unknown
          posX?: unknown
          posY?: unknown
        }
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.opacity === 'number' && parsed.opacity >= 0 && parsed.opacity <= 1) {
            // 旧版单一数值:迁移为双槽位(两形态同值,保持旧外观)
            opacity = { expanded: parsed.opacity, compact: parsed.opacity }
          } else if (parsed.opacity && typeof parsed.opacity === 'object') {
            const o = parsed.opacity as { expanded?: unknown; compact?: unknown }
            opacity = {
              expanded:
                typeof o.expanded === 'number' && o.expanded >= 0 && o.expanded <= 1
                  ? o.expanded
                  : 0.4,
              compact:
                typeof o.compact === 'number' && o.compact >= 0 && o.compact <= 1
                  ? o.compact
                  : 0.4,
            }
          }
          if (parsed.expanded && typeof parsed.expanded === 'object') {
            Object.assign(expanded, readCrop(parsed.expanded))
          } else if (
            typeof parsed.zoom === 'number' ||
            typeof parsed.posX === 'number' ||
            typeof parsed.posY === 'number'
          ) {
            Object.assign(
              expanded,
              readCrop({
                zoom: typeof parsed.zoom === 'number' ? parsed.zoom : undefined,
                posX: typeof parsed.posX === 'number' ? parsed.posX : undefined,
                posY: typeof parsed.posY === 'number' ? parsed.posY : undefined,
              }),
            )
          }
          if (parsed.compact && typeof parsed.compact === 'object') {
            Object.assign(compact, readCrop(parsed.compact))
          }
        }
      } else {
        // 兼容旧版:单独存储的不透明度(迁移为双槽位)
        const old = Number(localStorage.getItem(BACKGROUND_OPACITY_KEY))
        if (Number.isFinite(old) && old >= 0 && old <= 1) {
          opacity = { expanded: old, compact: old }
        }
      }
    } catch {
      // 忽略存储失败
    }
    return { expandedImage: null, compactImage: null, opacity, expanded, compact }
  })
  // 托盘菜单请求打开设置:seq 递增触发岛内展开并切换视图
  // (背景 / 帮助手册 / 主题色从设置视图内部进入,无独立外部入口)
  const [settingsSeq, setSettingsSeq] = useState(0)
  useEffect(() => {
    window.desktop?.onOpenSettings?.(() => setSettingsSeq((s) => s + 1))
  }, [])
  useEffect(() => {
    // 旧版单图迁移后,恢复两个槽位的背景图(IndexedDB);
    // 旧版本可能存了未降采样的大图,降采样后再用并回存
    // (形变逐帧重栅格化大图是卡顿主因)
    void migrateLegacyBackground().then(() => {
      loadBackgroundImage('expanded').then((img) => {
        if (!img) return
        downscaleBackgroundImage(img).then((small) => {
          if (small !== img) saveBackgroundImage(small, 'expanded').catch(() => {})
          setBackground((prev) => ({ ...prev, expandedImage: small }))
        })
      })
      loadBackgroundImage('compact').then((img) => {
        if (!img) return
        downscaleBackgroundImage(img).then((small) => {
          if (small !== img) saveBackgroundImage(small, 'compact').catch(() => {})
          setBackground((prev) => ({ ...prev, compactImage: small }))
        })
      })
    })
  }, [])
  const handleBackgroundChange = useCallback((bg: BackgroundState) => {
    setBackground(bg)
    try {
      localStorage.setItem(
        BACKGROUND_KEY,
        JSON.stringify({ opacity: bg.opacity, expanded: bg.expanded, compact: bg.compact }),
      )
    } catch {
      // 忽略存储失败
    }
    if (bg.expandedImage) saveBackgroundImage(bg.expandedImage, 'expanded').catch(() => {})
    else clearBackgroundImage('expanded').catch(() => {})
    if (bg.compactImage) saveBackgroundImage(bg.compactImage, 'compact').catch(() => {})
    else clearBackgroundImage('compact').catch(() => {})
    // 自动入库:新出现的背景图(上传/图片库选择)加入图片库,同名同图不重复
    for (const dataUrl of [bg.expandedImage, bg.compactImage]) {
      if (!dataUrl) continue
      if (imageLibraryRef.current.some((img) => img.dataUrl === dataUrl)) continue
      const item: ImageLibraryItem = {
        id: genImageId(),
        name: `背景图 ${imageLibraryRef.current.length + 1}`,
        dataUrl,
        createdAt: Date.now(),
      }
      imageLibraryRef.current = [...imageLibraryRef.current, item]
      setImageLibrary(imageLibraryRef.current)
      void saveImageItem(item).catch(() => {})
    }
  }, [])
  // 高空间视图(背景编辑器 / 库页面 / 自定义颜色页)按映射同步调整
  // 窗口高度,离开回落常规高度
  const handlePanelViewChange = useCallback((view: string) => {
    window.desktop?.setWindowHeight(VIEW_WINDOW_H[view] ?? WINDOW_H)
  }, [])
  // 自定义字体库(设置视图"字体"入口):库条目 IndexedDB,当前字体 id 与颜色/粗细 localStorage
  const [font, setFont] = useState<{
    currentFontId: string | null
    colorMode: FontColorMode
    colorValue: string | null
    weight: number
  }>(() => {
    const s = loadFontSettings()
    return {
      currentFontId: s.currentFontId,
      colorMode: s.colorMode,
      colorValue: s.colorValue,
      weight: s.weight,
    }
  })
  const [fontLibrary, setFontLibrary] = useState<FontLibraryItem[]>([])
  const fontLibraryRef = useRef<FontLibraryItem[]>([])
  const fontRef = useRef(font)
  fontRef.current = font
  useEffect(() => {
    void loadFontItems().then((items) => {
      fontLibraryRef.current = items
      setFontLibrary(items)
    })
  }, [])
  // 全量同步字体库(增/删/改名):新数组逐条写入,不在新数组的旧条目删除;
  // 若当前应用字体被删,回退系统默认
  const handleFontLibraryChange = useCallback((items: FontLibraryItem[]) => {
    const newIds = new Set(items.map((f) => f.id))
    for (const item of items) void saveFontItem(item).catch(() => {})
    for (const item of fontLibraryRef.current) {
      if (!newIds.has(item.id)) void deleteFontItem(item.id).catch(() => {})
    }
    fontLibraryRef.current = items
    setFontLibrary(items)
    if (fontRef.current.currentFontId && !newIds.has(fontRef.current.currentFontId)) {
      setFont((prev) => ({ ...prev, currentFontId: null }))
      saveFontSettings({ ...fontRef.current, currentFontId: null })
    }
  }, [])
  const handleFontAdd = useCallback((item: FontLibraryItem) => {
    void saveFontItem(item).catch(() => {})
    fontLibraryRef.current = [...fontLibraryRef.current, item]
    setFontLibrary(fontLibraryRef.current)
    setFont((prev) => ({ ...prev, currentFontId: item.id }))
    saveFontSettings({ ...fontRef.current, currentFontId: item.id })
  }, [])
  const handleFontSelect = useCallback((id: string | null) => {
    setFont((prev) => ({ ...prev, currentFontId: id }))
    saveFontSettings({ ...fontRef.current, currentFontId: id })
  }, [])
  const handleFontColorChange = useCallback((colorMode: FontColorMode, colorValue: string | null) => {
    // auto 模式保留自定义色值(值为 null 时不覆盖),切回 custom 不丢失
    setFont((prev) => {
      const next = { ...prev, colorMode }
      if (colorValue !== null) next.colorValue = colorValue
      return next
    })
    saveFontSettings({
      ...fontRef.current,
      colorMode,
      colorValue: colorValue !== null ? colorValue : fontRef.current.colorValue,
    })
  }, [])
  const handleFontWeightChange = useCallback((weight: number) => {
    setFont((prev) => ({ ...prev, weight }))
    saveFontSettings({ ...fontRef.current, weight })
  }, [])
  // 图片库(背景视图"图片库"入口):条目 IndexedDB
  const [imageLibrary, setImageLibrary] = useState<ImageLibraryItem[]>([])
  const imageLibraryRef = useRef<ImageLibraryItem[]>([])
  useEffect(() => {
    void loadImageItems().then((items) => {
      imageLibraryRef.current = items
      setImageLibrary(items)
    })
  }, [])
  const handleImageLibraryChange = useCallback((items: ImageLibraryItem[]) => {
    const newIds = new Set(items.map((img) => img.id))
    for (const item of items) void saveImageItem(item).catch(() => {})
    for (const item of imageLibraryRef.current) {
      if (!newIds.has(item.id)) void deleteImageItem(item.id).catch(() => {})
    }
    imageLibraryRef.current = items
    setImageLibrary(items)
  }, [])
  // 实时系统状态引用(异步检测用)
  const systemRef = useRef(system)
  systemRef.current = system

  // memo 化对象型 props:每次渲染新建对象会使 DynamicIsland(React.memo)
  // 的浅比较永远失败,无法跳过无效渲染
  const backgroundCropProp = useMemo(
    () => ({ expanded: background.expanded, compact: background.compact }),
    [background.expanded, background.compact],
  )
  const fontColorProp = useMemo(
    () => ({ mode: font.colorMode, value: font.colorValue }),
    [font.colorMode, font.colorValue],
  )

  // 系统媒体监听激活(外部平台正在播放):数据与控制优先走系统,本地播放器让位
  const externalActive = system.active && system.track != null && useExternalSource
  // 歌词字幕:按当前曲目(外部平台或本地)自动查询,播放位置驱动高亮
  const lyricsData = useLyrics(
    externalActive ? system.track?.title ?? null : player.track?.title ?? null,
    externalActive ? system.track?.artist ?? null : player.track?.artist ?? null,
    externalActive ? system.position : player.position,
    true,
  )

  // memo 化外部曲目对象:曲目未变时保持引用稳定(DynamicIsland 已包 memo)
  const externalTrack: TrackInfo | null = useMemo<TrackInfo | null>(
    () =>
      externalActive
        ? {
            title: system.track?.title ?? '',
            artist: system.track?.artist ?? '',
            duration: system.duration,
            source: 'system',
          }
        : null,
    [externalActive, system.track?.title, system.track?.artist, system.duration],
  )

  // 灵动岛媒体数据源:外部平台优先,否则本地播放器
  const islandState: IslandState = externalActive
    ? system.isPlaying
      ? 'playing'
      : 'idle'
    : player.phase === 'loading'
      ? 'loading'
      : player.phase === 'playing'
        ? 'playing'
        : 'idle'
  const islandTrack = externalActive ? externalTrack : player.track
  const islandPosition = externalActive ? system.position : player.position
  const islandDuration = externalActive ? system.duration : player.duration
  // useCallback:引用稳定(配合 memo),内部按当前数据源分发。
  // 依赖只列动态值(同上:player/system 对象每次渲染新建,不列入)
  /* eslint-disable react-hooks/exhaustive-deps */
  const islandPrev = useCallback(() => {
    if (externalActive) void system.control('previous')
    else player.previous()
  }, [externalActive])
  const islandNext = useCallback(() => {
    if (externalActive) void system.control('next')
    else player.next()
  }, [externalActive])
  // 外部平台:播放/暂停按用户意图(isPlaying 为用户点击意图)发送明确
  // play/pause 指令——QQ音乐不支持 toggle,但支持 play/pause
  const islandToggle = useCallback(() => {
    if (externalActive) void system.control(system.isPlaying ? 'pause' : 'play')
    else player.toggle()
  }, [externalActive, system.isPlaying])
  /* eslint-enable react-hooks/exhaustive-deps */
  // 外部平台播放模式:以系统真实状态为数据源(轮询校准)。
  // 客户端写入 SMTC 时自动跟随;不写入时点击后回退到真实状态
  useEffect(() => {
    if (!externalActive) return
    setExternalMode((current) => {
      const real = systemRef.current.mode
      return real === current ? current : real
    })
  }, [system.mode, externalActive])

  // 播放模式循环:外部监听作用于外部平台(重复/随机,按客户端接受与否回退),
  // 本地作用于本地歌单
  const handleCycleMode = () => {
    if (externalActive) {
      const prev = externalMode
      const next =
        prev === 'sequence' ? 'repeat-one' : prev === 'repeat-one' ? 'shuffle' : 'sequence'
      setExternalMode(next)
      const action =
        next === 'repeat-one' ? 'repeat-one' : next === 'shuffle' ? 'shuffle' : 'repeat-all'
      void system.control(action as SystemControlAction).then((accepted) => {
        // 客户端拒绝(如部分客户端不支持 SMTC 模式控制):回退到原模式
        if (accepted === false) setExternalMode(prev)
      })
      // 1.2s 后检测系统真实状态是否跟随:没跟随说明客户端不写 SMTC,提示并回退
      window.setTimeout(() => {
        const real = systemRef.current.mode
        if (real !== next) {
          showHint('当前平台不支持播放模式同步')
          setExternalMode(real)
        }
      }, 1200)
    } else {
      player.cycleMode()
    }
  }
  // 外部平台进度条拖动:跳转系统媒体进度(需客户端支持 TryChangePlaybackPosition)。
  // seek 是否生效由 useSystemMedia 内部验证(对照系统真实位置,超时回退),
  // 返回 false 即平台不支持跳转,给出提示;useCallback 保持引用稳定(配合 memo)
  /* eslint-disable react-hooks/exhaustive-deps -- system.control 为稳定引用 */
  const islandSeek = useCallback(
    (seconds: number) => {
      if (!externalActive) return
      void system.control('seek', seconds).then((accepted) => {
        if (accepted === false) showHint('当前平台不支持进度跳转')
      })
    },
    [externalActive, showHint],
  )
  /* eslint-enable react-hooks/exhaustive-deps */

  // 主题色:自定义 > 播放模式色 > 状态色(组件内)
  const mediaTheme = externalActive
    ? PLAY_MODES[externalMode].color
    : islandState === 'playing' || islandState === 'idle'
      ? PLAY_MODES[player.mode].color
      : null
  const islandTheme = customTheme ?? mediaTheme

  // 鼠标穿透:stage(岛体+展开面板)内接收鼠标,离开立即穿透。
  // 用 stage 容器而非组件 onHoverChange:组件展开期间屏蔽自己的 hover 事件,
  // 但 mouseenter/leave 仍会冒泡到父容器,穿透状态不会粘滞
  const handleStageEnter = useCallback(() => {
    window.desktop?.pointer(true)
  }, [])
  const handleStageLeave = useCallback(() => {
    // 拖拽中不关闭穿透:鼠标可能已移出岛体(如窗口被屏幕边缘钳制),
    // 窗口仍需接收指针事件(依赖指针捕获持续送达)
    if (dragRef.current?.dragging) return
    window.desktop?.pointer(false)
  }, [])
  // 兜底:鼠标移出窗口(forward 模式下 leave 可能丢失)
  const handleRootMouseLeave = useCallback(() => {
    if (dragRef.current?.dragging) return
    window.desktop?.pointer(false)
  }, [])

  // 右键长按拖拽移动挂件:按住右键 400ms 内不移动(位移 < 阈值)
  // 进入拖拽模式,之后拖动窗口跟随鼠标——长按区分"快速右键拖动",
  // 那不做任何事。配合指针捕获,拖拽期间即使鼠标移出岛体/窗口
  // (屏幕边缘钳制场景)事件仍持续送达(OS 捕获 + 穿透保持接收),
  // 松手后按指针实际位置恢复穿透状态
  const DRAG_HOLD_MS = 400
  const DRAG_HOLD_SLOP_PX = 8
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    /** 拖拽激活基准:长按期间实时更新,激活时以最新位置为基准
     *  (避免"按下点与指针"的固定偏移——长按期间的手抖) */
    actX: number
    actY: number
    timer: number
    dragging: boolean
    lastX: number
    lastY: number
  } | null>(null)

  const handleDragPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 2) return
    // 自愈:若此前丢失 pointerup 残留拖拽状态,先清掉
    const prev = dragRef.current
    if (prev) window.clearTimeout(prev.timer)
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.screenX
    const startY = event.screenY
    // 起点坐标异常(合成/边缘事件)不进入长按,避免把 NaN 传给主进程
    if (!Number.isFinite(startX) || !Number.isFinite(startY)) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX,
      startY,
      actX: startX,
      actY: startY,
      timer: window.setTimeout(() => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        // 长按成立:进入拖拽模式,以长按期间的最新位置为基准
        drag.dragging = true
        window.desktop?.dragStart(drag.actX, drag.actY)
      }, DRAG_HOLD_MS),
      dragging: false,
      lastX: startX,
      lastY: startY,
    }
  }, [])

  const handleDragPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return
    if (!drag.dragging) {
      // 长按期间轻微移动(阈值内):更新激活基准,拖拽开始时以最新位置
      // 为准,消除"按下点与指针"的固定偏移
      drag.actX = event.screenX
      drag.actY = event.screenY
      // 长按成立前移动超阈值:取消(快速右键拖动不生效)
      if (
        Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) >
        DRAG_HOLD_SLOP_PX
      ) {
        window.clearTimeout(drag.timer)
        dragRef.current = null
      }
      return
    }
    // 窗口移动后 Chromium 合成坐标相同/亚像素差异的指针事件:
    // 与上次发送坐标偏差 < 0.5px 的一律丢弃,阻断自移动正反馈与抖动
    // (真实位移由主进程 Math.round 吸收,亚像素移动本就无效果)
    if (
      Math.abs(event.screenX - drag.lastX) < 0.5 &&
      Math.abs(event.screenY - drag.lastY) < 0.5
    ) {
      return
    }
    drag.lastX = event.screenX
    drag.lastY = event.screenY
    window.desktop?.dragMove(event.screenX, event.screenY)
  }, [])

  const handleDragPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    window.clearTimeout(drag.timer)
    dragRef.current = null
    if (!drag.dragging) return
    window.desktop?.dragEnd()
    // 拖拽期间穿透保持接收鼠标;结束后按指针实际位置恢复
    // (指针已移出岛体则立即恢复穿透,避免残留"接收"状态)
    const el = document.elementFromPoint(event.clientX, event.clientY)
    window.desktop?.pointer(el !== null && event.currentTarget.contains(el))
  }, [])

  // 卸载时清理右键长按计时器
  useEffect(
    () => () => {
      const drag = dragRef.current
      if (drag) window.clearTimeout(drag.timer)
    },
    [],
  )

  return (
    <div className="widget-root" onMouseLeave={handleRootMouseLeave}>
      <div
        className="widget-stage"
        onMouseEnter={handleStageEnter}
        onMouseLeave={handleStageLeave}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerEnd}
        onPointerCancel={handleDragPointerEnd}
      >
        <DynamicIsland
          state={islandState}
          track={islandTrack}
          position={islandPosition}
          duration={islandDuration}
          onSeek={externalActive ? islandSeek : player.seek}
          onSwipeLeft={islandPrev}
          onSwipeRight={islandNext}
          onTextDoubleClick={islandToggle}
          mode={externalActive ? externalMode : player.mode}
          onCycleMode={handleCycleMode}
          themeColor={islandTheme ?? undefined}
          systemActive={externalActive}
          systemPlatform={externalActive ? system.platform : undefined}
          onToggleSource={system.active && system.track ? handleToggleSource : undefined}
          modeSupported={system.modeSupported}
          lyrics={lyricsData}
          playlist={!externalActive ? player.tracks : undefined}
          playlistIndex={!externalActive ? player.index : undefined}
          onPlayTrack={!externalActive ? player.playIndex : undefined}
          onTogglePlay={externalActive ? islandToggle : player.toggle}
          onUploadTracks={!externalActive ? player.addTracks : undefined}
          onRemoveTrack={!externalActive ? player.removeTrack : undefined}
          theme={customTheme}
          onThemeChange={applyCustomTheme}
          hint={hint}
          backgroundExpandedImage={background.expandedImage}
          backgroundCompactImage={background.compactImage}
          backgroundOpacity={background.opacity}
          backgroundCrop={backgroundCropProp}
          onBackgroundChange={handleBackgroundChange}
          requestSettingsSeq={settingsSeq}
          onPanelViewChange={handlePanelViewChange}
          fontLibrary={fontLibrary}
          currentFontId={font.currentFontId}
          fontColor={fontColorProp}
          onFontAdd={handleFontAdd}
          onFontLibraryChange={handleFontLibraryChange}
          onFontSelect={handleFontSelect}
          onFontColorChange={handleFontColorChange}
          fontWeight={font.weight}
          onFontWeightChange={handleFontWeightChange}
          imageLibrary={imageLibrary}
          onImageLibraryChange={handleImageLibraryChange}
        />
      </div>
    </div>
  )
}

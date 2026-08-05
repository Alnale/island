import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  DynamicIsland,
  type DynamicIslandHandle,
  type IslandSnapshot,
} from './components/DynamicIsland'
import { ISLAND_STATES, type IslandState, type TrackInfo } from './data/islandStates'
import { useLyrics } from './hooks/useLyrics'
import { useSystemMedia, type SystemControlAction } from './hooks/useSystemMedia'
import {
  clearBackgroundImage,
  DEFAULT_BG_CROP,
  downscaleBackgroundImage,
  deleteImageItem,
  genImageId,
  loadBackgroundImage,
  loadImageItems,
  migrateLegacyBackground,
  saveBackgroundImage,
  saveImageItem,
  type BackgroundState,
  type ImageLibraryItem,
} from './media/backgroundStore'
import {
  deleteFontItem,
  loadFontItems,
  loadFontSettings,
  saveFontItem,
  saveFontSettings,
  type FontColorMode,
  type FontLibraryItem,
} from './media/fontStore'
import { MODE_ORDER, PLAY_MODES, type PlaybackMode } from './media/playbackModes'
import { SYSTEM_PLATFORMS } from './media/systemPlatforms'
import { useMediaPlayer } from './media/useMediaPlayer'
import { formatTime } from './utils/format'
import './App.css'

const FEATURES = [
  {
    index: '01',
    title: '无抖动切换',
    desc: '图标原地切换、文字上移淡入,岛体只在文字宽度变化时以回弹曲线伸缩。',
  },
  {
    index: '02',
    title: '媒体监听 API',
    desc: 'ref 暴露 isPlaying / getTrack / seekTo / subscribe,实时检测播放状态与歌曲信息。',
  },
  {
    index: '03',
    title: '状态色联动',
    desc: '页面氛围光与控件颜色跟随灵动岛状态,绿红琥珀实时呼应。',
  },
  {
    index: '04',
    title: '可操控进度条',
    desc: '播放/暂停/加载才有进度条;播放中点击或拖动即可控制歌曲进度,键盘方向键同样可用。',
  },
  {
    index: '05',
    title: '长按展开',
    desc: '长按灵动岛,胶囊形变为更大的圆角矩形控制面板,进度、曲目与播放一手掌控,像一座更完整的岛屿。',
  },
  {
    index: '06',
    title: '3D 压感',
    desc: '按下灵动岛以按压点为原点下沉倾斜,松手弹簧回弹;长按回弹展开,图标/歌名/歌手随形变位移。',
  },
  {
    index: '07',
    title: '播放模式',
    desc: '顺序/单曲循环/随机三种模式,进度条跑马灯样式与灵动岛主题色随之联动。',
  },
  {
    index: '08',
    title: '系统媒体监听',
    desc: '监听 QQ音乐/网易云/酷狗/酷我/汽水等系统媒体会话,灵动岛同步显示曲目并可控制上一首/播放/下一首。',
  },
]

/** 快照日志文案(只记录状态/歌曲变化,进度不刷屏) */
const describeSnapshot = (s: IslandSnapshot): string => {
  const playState =
    s.state === 'playing' ? '播放中' : s.state === 'idle' ? '已暂停' : '加载中'
  const track = s.track ? `${s.track.title} · ${s.track.artist}` : '无媒体'
  return `${playState} · ${track}`
}

export default function App() {
  const islandRef = useRef<DynamicIslandHandle>(null)
  // 灵动岛 API 实时快照(监控面板)
  const [snap, setSnap] = useState<IslandSnapshot | null>(null)
  const [snapLog, setSnapLog] = useState<Array<{ time: string; text: string }>>([])
  const player = useMediaPlayer()
  const system = useSystemMedia()
  // 数据源开关:默认外部监听优先,点击灵动岛音乐图标在"本地播放器 ↔ 系统监听"间切换;
  // 切换时双向暂停(切走的一方自动暂停,避免双声齐响)
  const [useExternalSource, setUseExternalSource] = useState(true)
  const handleToggleSource = () => {
    const next = !useExternalSource
    setUseExternalSource(next)
    if (next) player.pause()
    else void system.control('pause')
  }
  // 外部平台播放模式:以系统真实状态为数据源(轮询校准,与挂件一致)
  const [externalMode, setExternalMode] = useState<PlaybackMode>('sequence')
  // 自定义主题色(null = 跟随播放模式/状态色),localStorage 持久化(与挂件一致)
  const [customTheme, setCustomTheme] = useState<string | null>(() => {
    try {
      return localStorage.getItem('widget-theme-color')
    } catch {
      return null
    }
  })
  const applyCustomTheme = useCallback((color: string | null) => {
    setCustomTheme(color)
    try {
      if (color) localStorage.setItem('widget-theme-color', color)
      else localStorage.removeItem('widget-theme-color')
    } catch {
      // 忽略存储失败
    }
  }, [])
  // 操作不支持提示(模式/跳转被客户端拒绝时,与挂件一致):
  // 经 hint prop 在岛内显示(紧凑态 = 左侧文字区,展开态 = 播放键下方)
  const [hint, setHint] = useState<string | null>(null)
  const hintTimerRef = useRef(0)
  const showHint = useCallback((text: string) => {
    setHint(text)
    window.clearTimeout(hintTimerRef.current)
    hintTimerRef.current = window.setTimeout(() => setHint(null), 2600)
  }, [])
  // 自定义背景(与桌面挂件一致:双形态图片 + 裁切,持久化同键;
  // Web 演示入口 = 设置视图,桌面端 = 托盘"设置"菜单)
  const [background, setBackground] = useState<BackgroundState>(() => {
    // 不透明度按形态独立(旧版单一数值自动迁移为双槽位)
    let opacity: { expanded: number; compact: number } = { expanded: 0.4, compact: 0.4 }
    const expanded = { ...DEFAULT_BG_CROP }
    const compact = { ...DEFAULT_BG_CROP }
    const readCrop = (
      c: Partial<{ zoom: number; posX: number; posY: number }> | null | undefined,
    ): { zoom: number; posX: number; posY: number } => ({
      zoom: typeof c?.zoom === 'number' && c.zoom >= 1 && c.zoom <= 4 ? c.zoom : DEFAULT_BG_CROP.zoom,
      posX:
        typeof c?.posX === 'number' && c.posX >= 0 && c.posX <= 100 ? c.posX : DEFAULT_BG_CROP.posX,
      posY:
        typeof c?.posY === 'number' && c.posY >= 0 && c.posY <= 100 ? c.posY : DEFAULT_BG_CROP.posY,
    })
    try {
      const raw = localStorage.getItem('widget-background')
      if (raw) {
        const parsed = JSON.parse(raw) as {
          opacity?: unknown
          expanded?: Partial<{ zoom: number; posX: number; posY: number }>
          compact?: Partial<{ zoom: number; posX: number; posY: number }>
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
      }
    } catch {
      // 忽略存储失败
    }
    return { expandedImage: null, compactImage: null, opacity, expanded, compact }
  })
  useEffect(() => {
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
        'widget-background',
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
  // 自定义字体库(设置视图"字体"入口):库条目 IndexedDB,当前字体 id 与颜色 localStorage
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
  const handleFontColorChange = useCallback(
    (colorMode: FontColorMode, colorValue: string | null) => {
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
    },
    [],
  )
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
  // 系统媒体监听激活(外部平台正在播放):数据与控制优先走系统,本地播放器让位
  const externalActive = system.active && system.track != null && useExternalSource
  // 外部平台播放模式跟随系统真实状态(客户端写入 SMTC 时自动同步,与挂件一致)
  useEffect(() => {
    if (!externalActive) return
    setExternalMode((current) => {
      const real = system.mode
      return real === current ? current : real
    })
  }, [system.mode, externalActive])
  // 歌词字幕:按当前曲目(外部平台或本地)自动查询,播放位置驱动高亮。
  // 歌词用 lyricPosition(跟随平台上报,与歌词对齐);进度条仍用 position
  const lyricsData = useLyrics(
    externalActive ? system.track?.title ?? null : player.track?.title ?? null,
    externalActive ? system.track?.artist ?? null : player.track?.artist ?? null,
    externalActive ? system.lyricPosition : player.position,
    true,
  )

  const externalTrack: TrackInfo | null = externalActive
    ? {
        title: system.track?.title ?? '',
        artist: system.track?.artist ?? '',
        duration: system.duration,
        source: 'system',
      }
    : null

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
  const islandPrev = externalActive ? () => system.control('previous') : player.previous
  const islandNext = externalActive ? () => system.control('next') : player.next
  // 外部平台:播放/暂停按用户意图(isPlaying 为用户点击意图)发送明确
  // play/pause 指令——QQ音乐不支持 toggle,但支持 play/pause
  const islandToggle = externalActive
    ? () => system.control(system.isPlaying ? 'pause' : 'play')
    : player.toggle
  // 播放模式循环:外部监听作用于外部平台(重复/随机,按客户端接受与否回退),
  // 本地作用于本地歌单;外部操作 1.2s 后检测真实状态,未生效则提示并回退
  const handleCycleMode = () => {
    if (externalActive) {
      const prev = externalMode
      const next = prev === 'sequence' ? 'repeat-one' : prev === 'repeat-one' ? 'shuffle' : 'sequence'
      setExternalMode(next)
      const action =
        next === 'repeat-one' ? 'repeat-one' : next === 'shuffle' ? 'shuffle' : 'repeat-all'
      void system.control(action as SystemControlAction).then((accepted) => {
        // 客户端拒绝(如 QQ音乐不支持 SMTC 模式控制):回退到原模式
        if (accepted === false) setExternalMode(prev)
      })
      window.setTimeout(() => {
        if (system.mode !== next) {
          showHint('当前平台不支持播放模式同步')
          setExternalMode(system.mode)
        }
      }, 1200)
    } else {
      player.cycleMode()
    }
  }
  // 外部平台进度条拖动:跳转系统媒体进度(需客户端支持 TryChangePlaybackPosition)。
  // seek 是否生效由 useSystemMedia 内部验证(对照系统真实位置,超时回退),
  // 返回 false 即平台不支持跳转,给出提示
  const islandSeek = externalActive
    ? (seconds: number) => {
        void system.control('seek', seconds).then((accepted) => {
          if (accepted === false) showHint('当前平台不支持进度跳转')
        })
      }
    : undefined

  // 灵动岛 API 订阅快照,驱动监控面板(监听功能)
  useEffect(() => {
    const island = islandRef.current
    if (!island) return
    return island.subscribe((s) => {
      setSnap(s)
      setSnapLog((prev) => {
        const text = describeSnapshot(s)
        const last = prev[prev.length - 1]
        if (last && last.text === text) return prev
        return [
          ...prev.slice(-4),
          { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text },
        ]
      })
    })
  }, [])

  // 主题色:外部监听时跟随外部播放模式(顺序绿/单曲蓝/随机紫);
  // 本地播放/暂停态跟随本地播放模式;其余状态用状态色
  const mediaTheme = externalActive
    ? PLAY_MODES[externalMode].color
    : islandState === 'playing' || islandState === 'idle'
      ? PLAY_MODES[player.mode].color
      : null
  // 自定义主题色 > 播放模式色 > 状态色(组件内)
  const stateColor = (customTheme ?? mediaTheme) ?? ISLAND_STATES[islandState].color

  return (
    <div
      className="app"
      style={{ '--state-color': stateColor } as CSSProperties}
    >
      <header className="app-header reveal">
        <div className="brand">
          <span className="brand-dot" style={{ background: stateColor, boxShadow: `0 0 10px ${stateColor}` }} />
          <span className="brand-name">DYNAMIC&nbsp;ISLAND&nbsp;LAB</span>
        </div>
        <div className="header-clock" aria-hidden="true">
          {String(islandState).toUpperCase()} / MEDIA
        </div>
      </header>

      <main className="app-main">
        <section className="hero">
          <p className="hero-kicker reveal" style={{ '--d': '80ms' } as CSSProperties}>
            <span className="hero-kicker-index">01</span>
            <span className="hero-kicker-line" />
            状态实验室&nbsp;/&nbsp;STATE&nbsp;LAB
          </p>
          <h1 className="hero-title reveal" style={{ '--d': '150ms' } as CSSProperties}>
            灵动岛
          </h1>
          <p className="hero-sub reveal" style={{ '--d': '220ms' } as CSSProperties}>
            设备交互的微型舞台 —— 图标、文字与宽度的三重视觉编排
          </p>
        </section>

        <section
          className="stage reveal"
          style={{ '--d': '300ms' } as CSSProperties}
          aria-label="灵动岛预览"
        >
          <div
            className="stage-halo"
            style={{ '--state-color': stateColor } as CSSProperties}
          />
          <DynamicIsland
            ref={islandRef}
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
            themeColor={customTheme ?? mediaTheme ?? undefined}
            theme={customTheme}
            onThemeChange={applyCustomTheme}
            systemActive={externalActive}
            systemPlatform={externalActive ? system.platform : undefined}
            onToggleSource={
              system.active && system.track ? handleToggleSource : undefined
            }
            modeSupported={system.modeSupported}
            lyrics={lyricsData}
            playlist={!externalActive ? player.tracks : undefined}
            playlistIndex={!externalActive ? player.index : undefined}
            onPlayTrack={!externalActive ? player.playIndex : undefined}
            onTogglePlay={externalActive ? islandToggle : player.toggle}
            onUploadTracks={!externalActive ? player.addTracks : undefined}
            onRemoveTrack={!externalActive ? player.removeTrack : undefined}
            hint={hint}
            backgroundExpandedImage={background.expandedImage}
            backgroundCompactImage={background.compactImage}
            backgroundOpacity={background.opacity}
            backgroundCrop={{ expanded: background.expanded, compact: background.compact }}
            onBackgroundChange={handleBackgroundChange}
            settingsButton
            fontLibrary={fontLibrary}
            currentFontId={font.currentFontId}
            fontColor={{ mode: font.colorMode, value: font.colorValue }}
            onFontAdd={handleFontAdd}
            onFontLibraryChange={handleFontLibraryChange}
            onFontSelect={handleFontSelect}
            onFontColorChange={handleFontColorChange}
            fontWeight={font.weight}
            onFontWeightChange={handleFontWeightChange}
            imageLibrary={imageLibrary}
            onImageLibraryChange={handleImageLibraryChange}
          />
          <div className="stage-track" aria-hidden="true">
            <span
              className="stage-track-dot"
              style={{ '--state-color': stateColor } as CSSProperties}
            />
          </div>
        </section>

        <section className="panel reveal media-panel" style={{ '--d': '330ms' } as CSSProperties}>
          <div className="panel-head">
            <h2 className="panel-title">
              <span className="panel-title-index">02</span>
              媒体播放器&nbsp;/&nbsp;MEDIA
            </h2>
          </div>

          <div className={`media-now${player.phase === 'playing' ? ' media-playing' : ''}`}>
            <div className="media-art">
              <span className="media-art-note" aria-hidden="true">♪</span>
            </div>
            <div className="media-info">
              <span className="media-title">
                {player.track ? player.track.title : '正在合成曲目…'}
              </span>
              <span className="media-artist">{player.track?.artist ?? ''}</span>
            </div>
            <span className="media-time">
              {formatTime(player.position)} / {formatTime(player.duration)}
            </span>
          </div>

          <div className="media-controls">
            <button type="button" className="media-btn media-btn--primary" onClick={player.toggle}>
              {player.phase === 'playing' ? '⏸ 暂停' : '▶ 播放'}
            </button>
            <button type="button" className="media-btn" onClick={player.previous}>
              ⏮ 上一首
            </button>
            <button type="button" className="media-btn" onClick={player.next}>
              ⏭ 下一首
            </button>
            <p className="media-hint">测试曲目:体面 · 虚拟 · 我不曾忘记 · 系统媒体面板同样可控</p>
          </div>

          <div className="mode-group" role="group" aria-label="播放模式">
            {MODE_ORDER.map((m) => (
              <button
                key={m}
                type="button"
                className={`mode-btn${player.mode === m ? ' active' : ''}`}
                style={{ '--mode-color': PLAY_MODES[m].color } as CSSProperties}
                onClick={() => player.setMode(m)}
              >
                <span className="mode-btn-dot" />
                <span>{PLAY_MODES[m].label}</span>
              </button>
            ))}
            <p className="media-hint">模式切换后灵动岛主题色与进度条跑马灯随之变化</p>
          </div>

          <div className="api-monitor">
            <div className="api-monitor-head">
              <span className="api-monitor-title">灵动岛 API 实时监控</span>
              <span className="api-monitor-live">
                <span className="api-monitor-dot" aria-hidden="true" />
                LIVE
              </span>
            </div>
            <div className="api-rows">
              <div className="api-row">
                <code>isPlaying()</code>
                <span className={`api-val${snap?.isPlaying ? ' api-val--on' : ''}`}>
                  {snap?.isPlaying ? 'true · 正在播放' : 'false'}
                </span>
              </div>
              <div className="api-row">
                <code>getTrack()</code>
                <span className="api-val">
                  {snap?.track ? `${snap.track.title} — ${snap.track.artist}` : 'null'}
                </span>
              </div>
              <div className="api-row">
                <code>getPosition()</code>
                <span className="api-val">
                  {formatTime(snap?.position ?? 0)} / {formatTime(snap?.duration ?? 0)}
                </span>
              </div>
            </div>
            <ul className="api-log">
              {snapLog.length === 0 && <li className="api-log-empty">订阅中,等待事件…</li>}
              {snapLog.map((entry, i) => (
                <li key={`${entry.time}-${i}`}>
                  <span className="api-log-time">{entry.time}</span>
                  {entry.text}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="panel reveal system-panel" style={{ '--d': '360ms' } as CSSProperties}>
          <div className="panel-head">
            <h2 className="panel-title">
              <span className="panel-title-index">03</span>
              系统媒体监听&nbsp;/&nbsp;SYSTEM
            </h2>
            <span className={`sys-status${system.active ? ' on' : ''}`}>
              <span className="sys-status-dot" aria-hidden="true" />
              {system.active ? `监听中 · ${system.platform.label}` : '未连接'}
            </span>
          </div>
          {system.active && system.track && (
            <div className="sys-now">
              <div className="sys-track-row">
                <span
                  className="sys-platform"
                  style={{ '--platform-color': system.platform.color } as CSSProperties}
                >
                  {system.platform.label}
                </span>
                <span className="sys-track">
                  {system.track.title} — {system.track.artist}
                </span>
              </div>
              <div className="sys-controls">
                <button
                  type="button"
                  className="media-btn"
                  onClick={() => system.control('previous')}
                >
                  ⏮ 上一首
                </button>
                <button
                  type="button"
                  className="media-btn media-btn--primary"
                  onClick={() => system.control(system.isPlaying ? 'pause' : 'play')}
                >
                  {system.isPlaying ? '⏸ 暂停' : '▶ 播放'}
                </button>
                <button type="button" className="media-btn" onClick={() => system.control('next')}>
                  ⏭ 下一首
                </button>
              </div>
              <p className="sys-progress">
                {formatTime(system.position)} / {formatTime(system.duration)}
                <span className="sys-hint-inline">控制直达系统媒体会话,灵动岛同步显示</span>
              </p>
            </div>
          )}
          {!system.active && (
            <div className="sys-setup">
              <p className="sys-setup-title">监听未连接</p>
              <p className="sys-setup-desc">
                监听为常驻功能,随程序自动运行。启动本地桥接后即可监听系统音乐:
              </p>
              <code className="sys-setup-cmd">node scripts/system-media-bridge.ts</code>
            </div>
          )}
          <p className="sys-hint">
            支持平台:{' '}
            {SYSTEM_PLATFORMS.map((p) => p.label).join(' / ')}
            等,通过 Windows 系统媒体会话(SMTC)自动识别;进度实时同步,
            上一首/播放暂停/下一首直达平台,进度条拖动跳转视平台支持(QQ音乐不支持跳转);
            播放模式与播放列表仅对本地歌单有效
          </p>
        </section>

        <section className="features reveal" style={{ '--d': '460ms' } as CSSProperties}>
          {FEATURES.map((feature) => (
            <article key={feature.index} className="feature-card">
              <div className="feature-index">{feature.index}</div>
              <h3 className="feature-title">{feature.title}</h3>
              <p className="feature-desc">{feature.desc}</p>
            </article>
          ))}
        </section>
      </main>

      <footer className="app-footer reveal" style={{ '--d': '540ms' } as CSSProperties}>
        <span>DYNAMIC ISLAND LAB</span>
        <span className="app-footer-sep">·</span>
        <span>REACT 19 + VITE 8 + TS</span>
        <span className="app-footer-sep">·</span>
        <span>零抖动 · 弹簧回弹 · 媒体可操控</span>
      </footer>
    </div>
  )
}

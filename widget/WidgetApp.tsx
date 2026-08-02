import { useCallback, useEffect, useRef, useState } from 'react'
import { DynamicIsland } from '../src/components/DynamicIsland'
import type { IslandState, TrackInfo } from '../src/data/islandStates'
import { useLyrics } from '../src/hooks/useLyrics'
import { useSystemMedia, type SystemControlAction } from '../src/hooks/useSystemMedia'
import { PLAY_MODES, type PlaybackMode } from '../src/media/playbackModes'
import { useMediaPlayer } from '../src/media/useMediaPlayer'

const THEME_STORAGE_KEY = 'widget-theme-color'

/**
 * 桌面挂件版灵动岛:
 * 只渲染灵动岛本体(无演示页面),数据源与完整版一致——
 * 系统媒体监听(SMTC)优先,本地播放器兜底。
 *
 * 鼠标穿透由 stage 容器(包裹整个岛体与展开面板)的 mouseenter/leave 驱动,
 * 事件冒泡不受组件内部 hover 屏蔽影响:进入岛体才接收鼠标,离开立即穿透,
 * 展开面板期间移出也能可靠恢复(修复"面板收不回来"的卡死感)。
 */
export default function WidgetApp() {
  const player = useMediaPlayer()
  const system = useSystemMedia()
  // 操作结果提示(上传提醒/模式/跳转不被客户端接受时显示)
  const [hint, setHint] = useState<string | null>(null)
  const hintTimerRef = useRef(0)
  const showHint = useCallback((text: string) => {
    setHint(text)
    window.clearTimeout(hintTimerRef.current)
    hintTimerRef.current = window.setTimeout(() => setHint(null), 2600)
  }, [])
  // 数据源开关:默认外部监听优先,点击灵动岛音乐图标在"本地播放器 ↔ 系统监听"间切换
  const [useExternalSource, setUseExternalSource] = useState(true)
  const handleToggleSource = () => {
    const next = !useExternalSource
    setUseExternalSource(next)
    // 双向互斥:切到监听模式暂停本地播放,切到本地模式暂停外部播放,
    // 避免双声齐响;切回时保持暂停状态,由用户手动继续
    if (next) {
      player.pause()
    } else {
      void system.control('pause')
    }
  }
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
  // 实时系统状态引用(异步检测用)
  const systemRef = useRef(system)
  systemRef.current = system

  // 系统媒体监听激活(外部平台正在播放):数据与控制优先走系统,本地播放器让位
  const externalActive = system.active && system.track != null && useExternalSource
  // 歌词字幕:按当前曲目(外部平台或本地)自动查询,播放位置驱动高亮
  const lyricsData = useLyrics(
    externalActive ? system.track?.title ?? null : player.track?.title ?? null,
    externalActive ? system.track?.artist ?? null : player.track?.artist ?? null,
    externalActive ? system.position : player.position,
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
  // 外部平台进度条拖动:跳转系统媒体进度(需客户端支持 TryChangePlaybackPosition);
  // 1.2s 后检测进度是否真的跳了,没跳说明客户端不支持,给出提示
  const islandSeek = externalActive
    ? (seconds: number) => {
        void system.control('seek', seconds).then(() => {
          window.setTimeout(() => {
            const pos = systemRef.current.position
            if (Math.abs(pos - seconds) > 3) showHint('当前平台不支持进度跳转')
          }, 1200)
        })
      }
    : undefined

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
    window.desktop?.pointer(false)
  }, [])
  // 兜底:鼠标移出窗口(forward 模式下 leave 可能丢失)
  const handleRootMouseLeave = useCallback(() => {
    window.desktop?.pointer(false)
  }, [])

  // 右键拖拽移动挂件:按住右键拖动岛体/展开面板,窗口跟随移动。
  // 捕获阶段拦截(先于组件内部交互处理器),右键不触发长按展开/按压。
  // 过滤"坐标未变"的事件:窗口移动会让 Chromium 合成重复指针事件,
  // 丢弃它们可阻断自移动的正反馈
  const dragRef = useRef<{ pointerId: number; moved: boolean } | null>(null)
  const dragLastPosRef = useRef<{ x: number; y: number } | null>(null)
  const handlePointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 2) return
      event.stopPropagation()
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { pointerId: event.pointerId, moved: false }
      dragLastPosRef.current = { x: event.screenX, y: event.screenY }
      window.desktop?.dragStart(event.screenX, event.screenY)
    },
    [],
  )
  const handlePointerMoveCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      event.stopPropagation()
      // 坐标异常或与上次相同(合成事件):跳过,避免窗口自移动
      if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return
      const last = dragLastPosRef.current
      if (last && last.x === event.screenX && last.y === event.screenY) return
      dragLastPosRef.current = { x: event.screenX, y: event.screenY }
      drag.moved = true
      window.desktop?.dragMove(event.screenX, event.screenY)
    },
    [],
  )
  const handlePointerUpCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      event.stopPropagation()
      dragRef.current = null
      dragLastPosRef.current = null
      // 有位移才算拖拽(右键单击不移动,也不做任何事)
      if (drag.moved) window.desktop?.dragEnd()
    },
    [],
  )

  return (
    <div className="widget-root" onMouseLeave={handleRootMouseLeave}>
      {/* 操作结果提示(模式/跳转不被客户端支持时短暂显示) */}
      {hint && (
        <div className="widget-hint" role="status">
          {hint}
        </div>
      )}
      <div className="drag-handle" aria-hidden="true" />
      <div
        className="widget-stage"
        onMouseEnter={handleStageEnter}
        onMouseLeave={handleStageLeave}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerMoveCapture={handlePointerMoveCapture}
        onPointerUpCapture={handlePointerUpCapture}
        onPointerCancelCapture={handlePointerUpCapture}
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
          themeColor={islandTheme}
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
        />
      </div>
    </div>
  )
}

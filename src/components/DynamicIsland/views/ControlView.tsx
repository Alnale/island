import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { ISLAND_STATES, type IslandState, type TrackInfo } from '../../../data/islandStates'
import type { LyricsState } from '../../../hooks/useLyrics'
import { PLAY_MODES, type PlaybackMode } from '../../../media/playbackModes'
import { formatTime } from '../../../utils/format'
import { ModeIcon } from '../ModeIcon'
import { ParticleTime } from '../ParticleTime'
import type { PanelView } from '../layout'

export interface ControlViewProps {
  state: IslandState
  track?: TrackInfo | null
  /** 本地播放器模式且播放列表为空:面板整体显示上传引导 */
  showUploadPrompt: boolean
  /** 绑定曲目且处于媒体状态:显示播放控制;否则显示收起按钮 */
  panelHasControls: boolean
  showBar: boolean
  position: number
  duration: number
  displayRatio: number
  scrubbing: boolean
  scrubRatio: number | null
  /** 操作提示(模式/跳转不被接受时,播放键正下方) */
  hint?: string | null
  /** 粒子时间颜色(跟随状态色) */
  theme: string
  /** 播放列表入口显隐条件(仅本地播放器且可播放时显示) */
  playlist: TrackInfo[] | undefined
  systemActive: boolean
  systemPlatform?: { id: string; label: string; color: string }
  mode?: PlaybackMode
  prevMode: PlaybackMode | null
  modeSupported: boolean
  lyrics?: LyricsState
  lyricShown: boolean
  lyricFold: boolean
  onToggleLyric: () => void
  onToggleSource?: () => void
  onPlayTrack?: (index: number) => void
  onCycleMode?: () => void
  onPrev?: () => void
  onNext?: () => void
  onPlayPause?: () => void
  onChangeView: (view: PanelView) => void
  onCollapse: () => void
  /** Web 演示版控制区"设置"入口(桌面端入口在托盘菜单) */
  settingsButton?: boolean
  fileInputRef: RefObject<HTMLInputElement | null>
  panelBarRef: RefObject<HTMLDivElement | null>
  onBarPointerDown: (event: PointerEvent<HTMLDivElement>, bar: HTMLDivElement) => void
  onBarPointerMove: (event: PointerEvent<HTMLDivElement>, bar: HTMLDivElement) => void
  onBarPointerUp: (event: PointerEvent<HTMLDivElement>, bar: HTMLDivElement) => void
  onBarKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

/**
 * 媒体控制面板(panelView === 'control'):
 * 空播放列表时整个面板居中显示上传引导;否则头部(图标列 + 曲目信息 +
 * 内联粒子时间)+ 双行歌词 + 全宽进度条 + 播放控制键
 */
export function ControlView(props: ControlViewProps) {
  const {
    state,
    track,
    showUploadPrompt,
    panelHasControls,
    showBar,
    position,
    duration,
    displayRatio,
    scrubbing,
    scrubRatio,
    hint,
    theme,
    playlist,
    systemActive,
    systemPlatform,
    mode,
    prevMode,
    modeSupported,
    lyrics,
    lyricShown,
    lyricFold,
    onToggleLyric,
    onToggleSource,
    onPlayTrack,
    onCycleMode,
    onPrev,
    onNext,
    onPlayPause,
    onChangeView,
    onCollapse,
    settingsButton,
    fileInputRef,
    panelBarRef,
    onBarPointerDown,
    onBarPointerMove,
    onBarPointerUp,
    onBarKeyDown,
  } = props

  // 歌词开关"打开"提示:播放键下方短暂显示歌词来源(网易云 API),
  // 样式与宿主 hint("不支持进度跳转"等)同一通道,2.6s 自动消失
  const [lyricHint, setLyricHint] = useState<string | null>(null)
  const lyricHintTimerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(lyricHintTimerRef.current), [])
  const handleToggleLyric = () => {
    const next = !lyricShown
    onToggleLyric()
    if (next) {
      setLyricHint('接入网易云歌词API')
      window.clearTimeout(lyricHintTimerRef.current)
      lyricHintTimerRef.current = window.setTimeout(() => setLyricHint(null), 2600)
    }
  }

  if (showUploadPrompt) {
    /* 空播放列表:整个面板居中显示上传引导(提示下方是上传按钮) */
    return (
      <div className="island-panel-empty">
        <p className="island-panel-empty-text">本地暂无音乐,上传后即可播放</p>
        <button
          type="button"
          className="island-ctl island-ctl--upload"
          onClick={(event) => {
            event.stopPropagation()
            fileInputRef.current?.click()
          }}
        >
          <svg
            className="island-ctl-svg"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>上传音乐</span>
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="island-panel-head">
        {/* 图标列:音乐图标(点击切换本地播放器/系统监听数据源)+ 图标下方当前数据源标签 */}
        <div className="island-panel-icon-col">
          <button
            type="button"
            className="island-icon island-panel-icon island-panel-icon-btn"
            aria-label="切换本地播放/系统监听"
            title="切换本地播放/系统监听"
            onClick={(event) => {
              event.stopPropagation()
              onToggleSource?.()
            }}
          >
            {ISLAND_STATES[state].icon(`panel-${state}`)}
          </button>
          <span className="island-panel-icon-tag">
            {systemActive && systemPlatform ? systemPlatform.label : ISLAND_STATES[state].label}
          </span>
        </div>
        <div className="island-panel-meta">
          {/* 主行:歌名(可省略)+ 粒子时间(与歌名同行,flex 内嵌不重叠) */}
          <div className="island-panel-main-row">
            <span className="island-panel-title">
              {track
                ? track.title
                : ISLAND_STATES[state].text}
            </span>
            <ParticleTime
              seconds={scrubbing && scrubRatio !== null ? scrubRatio * duration : position}
              centerX={0}
              color={theme}
              inline
            />
          </div>
          {/* 歌手行始终占位(空内容也保留行高),避免进度条位置随曲目信息位移 */}
          <span className="island-panel-artist">{track?.artist ?? ''}</span>
        </div>
      </div>
      {/* 双行歌词:面板级绝对定位(水平居中、固定在歌手行下方),
          脱离文档流——歌词显隐不影响进度条/控制键位置 */}
      <div
        className={`island-panel-lyric-inline${lyricFold ? ' lyric-hidden' : ''}`}
        key={lyrics?.currentIndex ?? -1}
      >
        <p
          className={`island-lyric-line${lyricShown && lyrics && lyrics.lines.length > 0 ? ' active' : ''}`}
        >
          {lyricShown && lyrics && lyrics.lines.length > 0
            ? lyrics.lines[lyrics.currentIndex >= 0 ? lyrics.currentIndex : 0]?.text ?? ''
            : ''}
        </p>
        <p className="island-lyric-line">
          {lyricShown && lyrics && lyrics.lines.length > 0
            ? lyrics.lines[lyrics.currentIndex + 1]?.text ?? ''
            : ''}
        </p>
      </div>

      {showBar && duration > 0 && (
        <div className="island-panel-progress-row">
          <span className="island-panel-time">0:00</span>
          <div
            ref={panelBarRef}
            className="island-panel-progress"
            role="slider"
            tabIndex={0}
            aria-label="播放进度"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={scrubbing && scrubRatio !== null ? scrubRatio * duration : position}
            aria-valuetext={`${formatTime(position)} / ${formatTime(duration)}`}
            style={{ '--progress-ratio': displayRatio } as CSSProperties}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation()
              onBarKeyDown(event)
            }}
            onPointerDown={(event) =>
              panelBarRef.current && onBarPointerDown(event, panelBarRef.current)
            }
            onPointerMove={(event) =>
              panelBarRef.current && onBarPointerMove(event, panelBarRef.current)
            }
            onPointerUp={(event) =>
              panelBarRef.current && onBarPointerUp(event, panelBarRef.current)
            }
            onPointerCancel={(event) =>
              panelBarRef.current && onBarPointerUp(event, panelBarRef.current)
            }
          >
            <div className="island-panel-progress-fill" />
          </div>
          <span className="island-panel-time">{formatTime(duration)}</span>
        </div>
      )}
      {showBar && duration <= 0 && (
        <div className="island-panel-progress-row">
          <div className="island-panel-progress" aria-hidden="true">
            <div className="island-panel-progress-fill" />
          </div>
        </div>
      )}

      {/* 媒体状态:播放控制;通知状态:收起按钮 */}
      {panelHasControls ? (
        <div className="island-panel-controls">
          {/* 歌词开关:左下角(与播放列表并排) */}
          {lyrics && (
            <button
              type="button"
              className={`island-ctl island-ctl--lyric${lyricShown ? ' on' : ''}`}
              aria-label={lyricShown ? '隐藏歌词' : '显示歌词'}
              aria-pressed={lyricShown}
              title={lyricShown ? '隐藏歌词' : '显示歌词'}
              onClick={(event) => {
                event.stopPropagation()
                handleToggleLyric()
              }}
            >
              <svg
                className="island-ctl-svg"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </button>
          )}
          {/* 播放列表入口:切换到列表视图(上传音乐/查看曲目);外部平台时隐藏 */}
          {!systemActive && playlist && onPlayTrack && (
            <button
              type="button"
              className="island-ctl island-ctl--list"
              aria-label="播放列表"
              title="播放列表"
              onClick={(event) => {
                event.stopPropagation()
                onChangeView('list')
              }}
            >
              <svg
                className="island-ctl-svg"
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          )}
          {/* 设置入口(仅 Web 演示显示;桌面端入口在托盘菜单):
              切换到设置视图(自定义背景 / 帮助手册 / 主题色) */}
          {settingsButton && (
            <button
              type="button"
              className="island-ctl island-ctl--settings"
              aria-label="设置"
              title="设置"
              onClick={(event) => {
                event.stopPropagation()
                onChangeView('settings')
              }}
            >
              <svg
                className="island-ctl-svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
          {mode && onCycleMode && (
            <button
              type="button"
              className="island-ctl island-ctl--mode"
              aria-label={`播放模式:${PLAY_MODES[mode].label}`}
              title={
                systemActive && !modeSupported
                  ? '当前平台不支持播放模式控制'
                  : PLAY_MODES[mode].label
              }
              disabled={systemActive && !modeSupported}
              onClick={(event) => {
                event.stopPropagation()
                onCycleMode()
              }}
            >
              {/* 图标切换动画:旧图标线条擦除 + 新图标线条画出的"重组" */}
              <span className="island-mode-icons" aria-hidden="true">
                {prevMode && prevMode !== mode && (
                  <ModeIcon
                    key={`leave-${prevMode}`}
                    mode={prevMode}
                    className="island-mode-svg island-mode-svg--leave"
                  />
                )}
                <ModeIcon
                  key={`enter-${mode}`}
                  mode={mode}
                  className="island-mode-svg island-mode-svg--enter"
                />
              </span>
            </button>
          )}
          <button
            type="button"
            className="island-ctl island-ctl--prev"
            aria-label="上一首"
            onClick={(event) => {
              event.stopPropagation()
              onPrev?.()
            }}
          >
            <svg
              className="island-ctl-svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="19 20 9 12 19 4" />
              <line x1="5" y1="19" x2="5" y2="5" />
            </svg>
          </button>
          <button
            type="button"
            className="island-ctl island-ctl--primary"
            aria-label={state === 'playing' ? '暂停' : '播放'}
            onClick={(event) => {
              event.stopPropagation()
              onPlayPause?.()
            }}
          >
            {state === 'playing' ? (
              /* 暂停:两条短粗圆角竖条(宽度 3.6、高 14、圆头),舒展不紧凑 */
              <svg
                className="island-ctl-svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <rect x="6.8" y="5" width="3.6" height="14" rx="1.8" />
                <rect x="13.6" y="5" width="3.6" height="14" rx="1.8" />
              </svg>
            ) : (
              /* 播放:饱满圆角三角形(粗描边圆角连接) */
              <svg
                className="island-ctl-svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7.5 4.8v14.4L19.5 12z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="island-ctl island-ctl--next"
            aria-label="下一首"
            onClick={(event) => {
              event.stopPropagation()
              onNext?.()
            }}
          >
            <svg
              className="island-ctl-svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="5 4 15 12 5 20" />
              <line x1="19" y1="5" x2="19" y2="19" />
            </svg>
          </button>
          {/* 操作提示:播放键正下方(纯文本,与面板次级文字同款,无气泡;
              面板控制区始终贴底,提示固定落在按钮下方 16px 内边距区)。
              歌词来源提示激活时优先显示(短暂覆盖宿主 hint) */}
          {(hint || lyricHint) && (
            <div className="island-hint-play" role="status">
              {lyricHint ?? hint}
            </div>
          )}
        </div>
      ) : (
        <div className="island-panel-dismiss">
          <button
            type="button"
            className="island-ctl"
            aria-label="收起"
            onClick={(event) => {
              event.stopPropagation()
              onCollapse()
            }}
          >
            <svg
              className="island-ctl-svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      )}
    </>
  )
}

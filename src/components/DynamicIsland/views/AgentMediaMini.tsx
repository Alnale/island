import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { dispatchAgentMedia, resolveMediaSrc, type AgentMediaReport } from './Markdown'
import { VideoExtras } from './Markdown'
import { loadVideoPrefs } from '../../../media/videoPrefs'

/**
 * 对话媒体小窗(2026-08-09 用户要求"灵动岛包裹的小窗"):收起 Agent
 * 面板后岛体变形成媒体小窗——
 * - **视频 = 迷你播放器**:原面板播放中 → 挂载自动续播(用户此前已点过
 *   播放,同页手势放行;被自动播放策略拦截则回退显示播放键);点击
 *   播放/暂停;**底部进度条 + 时间(2026-08-09 用户要求"视频岛没有
 *   进度条"**:可拖拽 seek,与消息气泡播放器同款 4px 圆角条 + 强调色
 *   填充 + 白圆点 thumb);**右下角全屏按钮**(2026-08-09 用户要求,
 *   容器级 requestFullscreen,与消息气泡全屏同款);
 * - **图片 = 缩略图**:点击展开回对话面板;
 * - **音频不在此**(收起自动切音乐模式并续播,见 DynamicIsland
 *   doCollapse + onAgentAudioHandoff)。
 * UI = 灵动岛风格:**胶囊一体化(2026-08-09 二轮设计,用户选定:无
 * 黑边)**——媒体 contain 铺满岛体,边缘由岛体 22px 圆角 + overflow
 * hidden 裁剪,**无 ✕ 关闭键**(退出 = 长按展开回面板)。
 */

/** 时间格式 m:ss(与消息气泡播放器同款) */
function fmtMiniTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
export function AgentMediaMini({
  media,
  onExpand,
}: {
  media: AgentMediaReport
  onExpand: () => void
}) {
  const src = resolveMediaSrc(media.src)
  const [playing, setPlaying] = useState(Boolean(media.playing))
  const [fullscreen, setFullscreen] = useState(false)
  // 进度条(2026-08-09 用户要求):当前/总时长 + 拖拽 seek;
  // current 改 DOM 直写(2026-08-11 性能:原每 ~250ms timeupdate
  // setCurrent 重渲染整个视频岛——小窗播放是常驻重活,见 renderProgress)
  const [duration, setDuration] = useState(0)
  const scrubbingRef = useRef(false)
  // 退出全屏缩回动画(2026-08-09 全屏 ↔ 小窗过渡):播完移除 class
  const [leavingFs, setLeavingFs] = useState(false)
  const fsLeaveTimerRef = useRef(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  // 应用播放偏好(2026-08-10 双向同步:音量/倍速/循环与对话播放器/
  // 多媒体库共享;**2026-08-10 二轮:key = 媒体名——与对话窗口同名的
  // 播放器共享同一份个性化设置**,挂载时读当前值应用到 video)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const p = loadVideoPrefs(media.name)
    v.volume = p.volume
    v.muted = p.volume === 0
    v.playbackRate = p.speed
    v.loop = p.loop
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时应用一次偏好
  }, [])
  // 原面板播放中 → 小窗挂载自动续播(仅挂载时一次)。
  // **先 seek 到面板内的最近进度再 play(2026-08-09 修复"收起变多媒体
  // 岛从头播放")**:position 由 MediaFrame 节流上报 → agentPlaying →
  // 收起快照;currentTime 需元数据就绪(readyState >= 1)才可设置,
  // 未就绪等 loadedmetadata(仅监听一次)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const start = () => {
      if (media.position && Number.isFinite(media.position) && media.position > 0) {
        try {
          v.currentTime = media.position
        } catch {
          // seek 失败忽略(继续播放兜底)
        }
      }
      if (playing) {
        const p = v.play()
        if (p) void p.catch(() => setPlaying(false))
      }
    }
    if (v.readyState >= 1) start()
    else v.addEventListener('loadedmetadata', start, { once: true })
    return () => v.removeEventListener('loadedmetadata', start)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载续播
  }, [])
  // 全屏状态跟踪(与消息气泡 VideoPlayer 同款:容器级全屏,控件随容器);
  // 退出全屏播缩回动画(agent-mini-fs-out,3D 压感回弹 0.32s)后移除
  // class——计时与动画时长对齐(0.32s + 余量)
  useEffect(() => {
    const onChange = () => {
      const fs = document.fullscreenElement === wrapRef.current
      setFullscreen(fs)
      if (!fs) {
        setLeavingFs(true)
        window.clearTimeout(fsLeaveTimerRef.current)
        fsLeaveTimerRef.current = window.setTimeout(() => setLeavingFs(false), 340)
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      window.clearTimeout(fsLeaveTimerRef.current)
    }
  }, [])
  const toggle = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }
  const toggleFullscreen = (event: MouseEvent) => {
    event.stopPropagation()
    const wrap = wrapRef.current
    if (!wrap) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void wrap.requestFullscreen().catch(() => {})
  }
  // 进度条拖拽 seek(2026-08-09 用户要求):与消息气泡播放器同款——
  // pointer capture,按下即 seek,拖动连续更新;时长未知(流式/未加载)
  // 时禁用。
  // **只认 track 内点击(2026-08-09 修复"点右下角/进度条外把进度拉到
  // 尽头")**:事件绑在 .island-agent-mini-bar 容器上(含渐变区 + 44px
  // 全屏键预留角位),点击容器但不在 track 内时 clientX 在 track rect
  // 之外,ratio 被 clamp 成 0/1 = 进度跳头/跳尾——按下点不在 track
  // 内直接忽略
  const seekFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bar = barRef.current
    const v = videoRef.current
    if (!bar || !v || !(duration > 0) || !Number.isFinite(duration)) return
    const rect = bar.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    v.currentTime = ratio * duration
    renderProgress()
    // 双向同步(2026-08-09):seek 立即上报,展开回面板时同 src 续播
    dispatchAgentMedia('play', { kind: 'video', src: media.src, playing: !v.paused, position: v.currentTime })
  }
  // 播放进度 DOM 直写(2026-08-11 性能):timeupdate 每 ~250ms 触发,
  // 原 setCurrent → 每次重渲染整个视频岛(控制条/时间/VideoExtras)——
  // 小窗常驻播放,是软件渲染下最重的场景;进度条/时间改直写 DOM,
  // 播放期间零 React 重渲染;组件重渲染后由下方 effect 同步真实进度
  // (JSX 静态初始值,重渲染不覆盖直写值)
  const renderProgress = (reset = false) => {
    const v = videoRef.current
    const track = barRef.current
    if (!track) return
    const dur = v ? v.duration || 0 : 0
    const cur = reset ? 0 : v ? v.currentTime || 0 : 0
    const pct = dur > 0 && Number.isFinite(dur) ? Math.min(100, (cur / dur) * 100) : 0
    const fill = track.querySelector('.island-agent-mini-fill') as HTMLElement | null
    const thumb = track.querySelector('.island-agent-mini-thumb') as HTMLElement | null
    if (fill) fill.style.width = `${pct}%`
    if (thumb) thumb.style.left = `${pct}%`
    const timeEl = track.parentElement?.querySelector('.island-agent-mini-time')
    if (timeEl) timeEl.textContent = `${fmtMiniTime(cur)} / ${fmtMiniTime(dur)}`
  }
  // 每次渲染提交后同步一次真实进度(JSX 静态,重渲染不覆盖直写值)
  useEffect(() => {
    renderProgress()
  })
  // 小窗播放进度上报(2026-08-09 双向同步):timeupdate 经 dispatch
  // 更新位置缓存与 agentPlaying——展开回面板时 MediaFrame 从该位置
  // 续播(节流 ~1Hz,与 MediaFrame onProgress 同款)。
  // **2026-08-10 尺寸透传**:小窗尺寸 = 媒体元素尺寸(快照携带),播放
  // 上报带 width/aspect 回写缓存——切回面板时 MediaFrame 读回同尺寸
  const lastReportRef = useRef(-1)
  const reportPosition = (position: number) => {
    if (Math.round(position) !== lastReportRef.current) {
      lastReportRef.current = Math.round(position)
      dispatchAgentMedia('play', {
        kind: 'video',
        src: media.src,
        playing: true,
        position,
        width: media.width,
        aspect: media.aspect,
      })
    }
  }
  // 进度条自动隐藏(2026-08-10 用户要求"鼠标移开视频岛后过几秒自动
  // 隐藏"):**空闲计时驱动**(2026-08-10 二轮,与对话播放器同款修复——
  // 原实现只靠 mouseleave 计时,挂载时鼠标已在岛上则 leave 永不触发):
  // 播放中任何交互(移入/移动/移出/拖进度)重启 2.5s 计时,超时进度条
  // 行淡出(纯视频画面);暂停保持显示(要看进度条/时间)
  const [barHidden, setBarHidden] = useState(false)
  const barHideTimerRef = useRef(0)
  const playingRef = useRef(playing)
  playingRef.current = playing
  useEffect(() => () => window.clearTimeout(barHideTimerRef.current), [])
  const restartBarTimer = () => {
    window.clearTimeout(barHideTimerRef.current)
    if (playingRef.current && !scrubbingRef.current) {
      barHideTimerRef.current = window.setTimeout(() => setBarHidden(true), 2500)
    }
  }
  const showBar = () => {
    setBarHidden(false)
    restartBarTimer()
  }
  useEffect(() => {
    if (playing) restartBarTimer()
    else {
      setBarHidden(false)
      window.clearTimeout(barHideTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 播放状态变化驱动
  }, [playing])
  return (
    <div
      ref={wrapRef}
      className={`island-agent-mini${fullscreen ? ' fullscreen' : ''}${leavingFs ? ' leaving-fullscreen' : ''}`}
      onMouseEnter={showBar}
      onMouseLeave={restartBarTimer}
      onMouseMove={showBar}
    >
      {media.kind === 'img' ? (
        <>
          <img
            src={src}
            alt={media.name ?? ''}
            draggable={false}
            onClick={(event) => {
              event.stopPropagation()
              onExpand()
            }}
          />
          {/* 全屏按钮(2026-08-09):图片岛同样可全屏(双键缩放适用场景) */}
          <button
            type="button"
            className="island-agent-mini-fs"
            aria-label={fullscreen ? '退出全屏' : '全屏'}
            onClick={toggleFullscreen}
          >
            {fullscreen ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            )}
          </button>
        </>
      ) : (
        <>
          <video
            ref={videoRef}
            src={src}
            onClick={(event) => {
              event.stopPropagation()
              toggle()
            }}
            onLoadedMetadata={(event) => {
              const d = event.currentTarget.duration
              setDuration(Number.isFinite(d) ? d : 0)
            }}
            onDurationChange={(event) => {
              const d = event.currentTarget.duration
              setDuration(Number.isFinite(d) ? d : 0)
            }}
            onTimeUpdate={(event) => {
              // 进度 DOM 直写(2026-08-11 性能,见 renderProgress 注释)
              renderProgress()
              reportPosition(event.currentTarget.currentTime)
            }}
            onEnded={() => {
              setPlaying(false)
              // ended 后 currentTime 停在时长,显式归零
              renderProgress(true)
              // 播完清除播放状态同步(切回面板不自动重播)
              dispatchAgentMedia('play', { kind: 'video', src: media.src, playing: false })
            }}
            onPlay={() => {
              setPlaying(true)
              // 立即上报播放状态同步(不等到 1Hz timeupdate:暂停后
              // 重新播放立即切回面板的场景,lastPlayingVideoSrc 需即时恢复)
              const v = videoRef.current
              dispatchAgentMedia('play', {
                kind: 'video',
                src: media.src,
                playing: true,
                position: v ? v.currentTime : undefined,
              })
            }}
            onPause={() => {
              setPlaying(false)
              // 暂停清除播放状态同步(2026-08-10:小窗暂停后切回面板
              // 不应自动播放——面板挂载续播按 lastPlayingVideoSrc 判定)
              dispatchAgentMedia('play', { kind: 'video', src: media.src, playing: false })
            }}
          />
          {!playing && (
            <button
              type="button"
              className="island-agent-mini-play"
              aria-label="播放"
              onClick={(event) => {
                event.stopPropagation()
                toggle()
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M7 4.5v15l13-7.5z" />
              </svg>
            </button>
          )}
          {/* 进度条 + 时间(2026-08-09 用户要求):底部渐变遮罩条,
              padding-right 预留全屏按钮角位(参照消息气泡控件层);
              鼠标移开自动隐藏,见 barHidden 逻辑 */}
          <div
            className={`island-agent-mini-bar${barHidden ? ' ui-hidden' : ''}`}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              event.stopPropagation()
              scrubbingRef.current = true
              event.currentTarget.setPointerCapture(event.pointerId)
              seekFromPointer(event)
            }}
            onPointerMove={(event) => {
              if (scrubbingRef.current) seekFromPointer(event)
            }}
            onPointerUp={() => {
              scrubbingRef.current = false
              restartBarTimer() // 拖拽结束重启空闲计时(2.5s 无操作再隐藏)
            }}
            onPointerCancel={() => {
              scrubbingRef.current = false
              restartBarTimer()
            }}
          >
            {/* 进度由 renderProgress 直写(JSX 静态,重渲染不覆盖) */}
            <div ref={barRef} className="island-agent-mini-track" aria-hidden="true">
              <div className="island-agent-mini-fill" />
              <span className="island-agent-mini-thumb" />
            </div>
            <span className="island-agent-mini-time">0:00 / 0:00</span>
            {/* 音量 + 更多(2026-08-10 用户要求:定制 UI,与对话播放器/
                多媒体库双向同步) */}
            <VideoExtras videoRef={videoRef} videoKey={media.name} />
            {/* 全屏按钮(2026-08-10 用户要求:缩小对齐音量/更多键,放在
                ⋯ 键右边,同排同高;容器级全屏,进度条行内 flex 流) */}
            <button
              type="button"
              className="island-agent-mini-fs"
              aria-label={fullscreen ? '退出全屏' : '全屏'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                toggleFullscreen(event)
              }}
            >
              {fullscreen ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

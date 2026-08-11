/**
 * 消息气泡 Markdown 渲染组件(配合 markdownParser.ts 使用)
 *
 * - `Markdown`:块级渲染(段落/标题/列表/引用/代码块/表格/分隔线),
 *   行内渲染(粗体/斜体/删除线/行内代码/链接)。全部文本经 React 转义,
 *   无 HTML 注入面;
 * - `MermaidBlock`:```mermaid 代码块 → 图表。mermaid 懒加载(dynamic
 *   import,构建按需分包,首次遇到图表才下载)+ 模块级渲染缓存(流式
 *   增量重解析时同代码直接复用 SVG,不重复渲染);securityLevel 'strict'
 *   由 mermaid 自身转义 HTML 标签,插入 SVG 前无外部数据;
 * - 链接:http(s) 渲染为可点击锚点,点击经 `window.desktop.openExternal`
 *   (挂件)用系统浏览器打开,Web 演示版回退 window.open;
 * - `CopyButton`:从 AgentView 迁出(消息气泡与代码块头部共用)。
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { parseMarkdown, type MdBlock, type MdInline } from './markdownParser'
import {
  loadVideoPrefs,
  onVideoPrefsChange,
  setVideoPrefs,
} from '../../../media/videoPrefs'
// 媒体窗口默认宽:键与读取定义在 settingsBridge(单一来源,与
// readAgentScale 同款;LLM 设置工具与设置界面共用)
import { readMediaWindowWidth } from '../../../settingsBridge'

/** 写入剪贴板:Clipboard API 优先,失败(非安全上下文等)回退 execCommand */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** 复制按钮:点击把文本写入剪贴板,短暂显示 ✓ 反馈。
 * 拦截左键 pointerdown —— 消息区内交互元素,长按不触发岛体收回 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={`island-agent-copy${copied ? ' copied' : ''}`}
      title="复制"
      aria-label="复制"
      onPointerDown={(event) => {
        if (event.button === 0) event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        void copyToClipboard(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 900)
        })
      }}
    >
      {copied ? (
        '✓'
      ) : (
        <svg
          className="island-ctl-svg"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

/** 挂件(desktop.preload)里用系统浏览器打开;Web 演示版回退新标签页
 * (desktop.d.ts 已补 openExternal,2026-08-07 审计 P1-2 删局部类型 hack) */
function openExternalUrl(url: string) {
  if (window.desktop?.openExternal) {
    window.desktop.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * 消息内嵌图片(2026-08-07,工具二维码等 data URL):
 * **按比例展示** —— 显示宽度 = 原图宽 × 界面缩放系数(--agent-s,
 * 岛体根变量,100% = 1) × **1/4**(2026-08-07 用户实测二维码仍太大,
 * 缩小为四分之一),面板放大时图片等比放大;超宽图由 CSS
 * max-width: 100% 兜底压缩(保持比例 height: auto)。
 * 缩放变化会触发窗口 resize → 监听重算;原图尺寸加载后读 naturalWidth
 */
export function AgentImage({ src, alt }: { src: string; alt?: string }) {
  const [natural, setNatural] = useState<number | null>(null)
  const [, force] = useState(0)
  useEffect(() => {
    const img = new Image()
    img.onload = () => setNatural(img.naturalWidth || null)
    img.src = src
    return () => {
      img.onload = null
    }
  }, [src])
  // 缩放变化 → 窗口 resize → 重渲染重读 --agent-s
  useEffect(() => {
    const read = () => force((v) => v + 1)
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])
  const root = document.querySelector('.island-demo.expanded')
  const raw = root ? getComputedStyle(root).getPropertyValue('--agent-s') : ''
  const scale = Number.parseFloat(raw)
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const width = natural != null && natural > 0 ? Math.round(natural * s * 0.25) : undefined
  return (
    <img
      src={src}
      alt={alt ?? ''}
      className="island-agent-md-img"
      style={width ? { width, height: 'auto' } : undefined}
      onPointerDown={(event) => {
        if (event.button === 0) event.stopPropagation()
      }}
    />
  )
}

/** 媒体窗口拖拽钳制范围 */
const MEDIA_MIN_W = 120
const MEDIA_MAX_W = 640

/** 岛内播放失败 → 系统默认播放器打开(降级;远程 URL 走系统浏览器) */
function openMediaExternally(url: string) {
  if (/^https?:\/\//i.test(url)) {
    openExternalUrl(url)
    return
  }
  window.desktop?.openMediaExternal?.(url)
}

/**
 * 媒体播放失败提示 + 降级打开按钮(外部播放器仅为降级选择,
 * 正常播放全在窗口内)。
 * 2026-08-08 按 video.error.code 区分原因:
 * code 4(SRC_NOT_SUPPORTED)= 格式不支持——Chromium 窗口内只支持
 * H.264 的 mp4 / webm(vp8/vp9)/ ogg,HEVC/H.265、mkv、avi、flv 等
 * 无法解码(硬限制),明确告知 + 系统播放器一键降级。
 * 2026-08-09 修复"格式正确却报无法播放(实测)":Chromium 对**加载
 * 失败**(404 文件不存在 / 413 过大 / 500 读取失败)也报 code 4——
 * 同一错误码无法区分"资源没拿到"与"资源格式不支持"。code 4 且
 * 本地协议时回查协议状态(HEAD Range 0-0):404/413/500 显示真实
 * 加载原因(路径错误/过大/读取失败),仅 200/206(资源可读)才判为
 * 真格式问题。远程 https/data:/blob: 无法回查,维持原判 */
function MediaError({ src, kind, code }: { src: string; kind: 'img' | 'video' | 'audio'; code?: number | null }) {
  // 回查结论:null = 未回查/非 code 4;'notfound'|'toolarge'|'readfail'
  // = 加载失败(协议状态);'ok' = 资源可读 → 真格式问题
  const [probe, setProbe] = useState<'notfound' | 'toolarge' | 'readfail' | 'ok' | null>(null)
  useEffect(() => {
    if (kind !== 'video' || code !== 4) return
    // 仅本地协议可回查(远程 URL fetch 会跨源/不可达,维持原判)
    if (!/^island-media:\/\//i.test(src)) return
    let alive = true
    // Range 0-0 极小请求:只取响应头与状态码,不下载内容
    fetch(src, { headers: { Range: 'bytes=0-0' } })
      .then((res) => {
        if (!alive) return
        if (res.status === 404) setProbe('notfound')
        else if (res.status === 413) setProbe('toolarge')
        else if (res.status >= 500) setProbe('readfail')
        else setProbe('ok') // 200/206 = 资源可读,格式问题成立
      })
      .catch(() => {
        // 回查失败(网络层):维持原判,不误报加载原因
      })
    return () => {
      alive = false
    }
  }, [src, kind, code])
  const reason =
    kind === 'video' && code === 4
      ? probe === 'notfound'
        ? '找不到该视频文件(路径可能有误或文件已被移动)'
        : probe === 'toolarge'
          ? '视频文件过大,超过窗口内播放上限(10GB)'
          : probe === 'readfail'
            ? '视频文件读取失败(可能被占用、已损坏或不可访问)'
            : '该视频格式无法在窗口内播放(窗口内支持 mp4(H.264)/webm/ogg)'
      : kind === 'video' && code === 9
        ? '该视频为 HEVC(H.265)等特殊编码,窗口内无法解码(挂件禁用硬件加速)——可用系统播放器打开,或让助手用 bili 工具转码(convert)为 H.264 后窗口内直接播放'
        : '无法播放该文件(可能已移动、过大或格式不支持)'
  return (
    <div className="island-agent-media-err">
      <span>{reason}</span>
      <button
        type="button"
        className="island-agent-media-external"
        title="用系统默认播放器打开"
        onClick={(event) => {
          event.stopPropagation()
          openMediaExternally(src)
        }}
        onPointerDown={(event) => {
          if (event.button === 0) event.stopPropagation()
        }}
      >
        用系统播放器打开
      </button>
    </div>
  )
}

/**
 * 语音消息气泡(2026-08-08,参考 QQ/微信语音气泡):胶囊横条 +
 * 圆形播放键(播放中变暂停)+ **动态声波**(播放时逐条跳动)+
 * 进度条 + 时长(秒/分'秒);点击整条切换播放/暂停;
 * 音频不参与拖拽缩放(不需要)。播放失败降级外部播放器打开。
 */
function VoiceBubble({
  src,
  alt,
  autoPlay = false,
}: {
  src: string
  alt?: string
  /** 2026-08-10 用户要求"LLM 播放音频,加载出媒体元素后自动播放":
   * 就绪后自动播放;被自动播放策略拦截静默回退(点一下播放即可,
   * 不误报错误) */
  autoPlay?: boolean
}) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const progressRef = useRef<HTMLSpanElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState<number | null>(null)
  const [err, setErr] = useState(false)
  const scrubbingRef = useRef(false)
  // 循环播放(2026-08-11 用户要求"音频条支持切换播放模式(循环)"):
  // 按钮切换 audio.loop;移交音乐模式时经上报的 loop 同步为单曲循环
  const [looping, setLooping] = useState(false)
  const loopingRef = useRef(false)
  loopingRef.current = looping
  // 播放状态/进度上报(2026-08-11 音频移交同步进度):timeupdate 节流
  // ~1Hz(与视频一致)——doCollapse 移交时带 position,音乐模式从该
  // 位置续播,不从头
  const lastPosReportRef = useRef(-1)
  const reportAudio = (a: HTMLAudioElement, force = false) => {
    const pos = Math.round(a.currentTime)
    if (!force && pos === lastPosReportRef.current) return
    lastPosReportRef.current = pos
    dispatchAgentMedia('play', {
      kind: 'audio',
      src,
      name: alt,
      playing: !a.paused,
      position: pos,
      loop: loopingRef.current,
    })
  }
  // 自动播放(2026-08-10 修复"找歌来听没自动播放"):**挂载时一次性捕获
  // autoPlay(useRef)——消息落定渲染(autoPlay=true)后消费标记使 prop 变
  // false,若 effect 依赖 [autoPlay] 会重跑:cleanup 移除 loadedmetadata
  // 监听,加载慢的媒体(本地协议流式)永远等不到 play()(实测音频静默
  // 失败)。挂载时捕获后,后续重渲染不影响已挂载实例;重挂载(历史恢复)
  // 时新实例读到 false 不播。**readyState >= 1(元数据就绪)即 play**——
  // play() 会触发继续加载;原实现等 canplay,但 audio preload="metadata"
  // 时浏览器不预载数据,canplay 可能**永不触发**;loadedmetadata 必然
  // 触发兜底。被自动播放策略拦截静默回退(不 setErr,点一下播放即可)
  const autoPlayOnceRef = useRef(autoPlay)
  useEffect(() => {
    if (!autoPlayOnceRef.current) return
    const a = audioRef.current
    if (!a) return
    const start = () => void a.play().catch(() => {})
    if (a.readyState >= 1) start()
    else a.addEventListener('loadedmetadata', start, { once: true })
    return () => a.removeEventListener('loadedmetadata', start)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载一次
  }, [])
  // 2026-08-09:挂载上报已移除(分批挂载顺序不可靠,见 MediaFrame);
  // 播放上报保留(音频移交后小窗续播标记;收起切换由数据快照驱动)
  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (playing) a.pause()
    else void a.play().catch(() => setErr(true))
  }
  // 循环按钮:切换 audio.loop(即时生效,播完自动重播);上报循环状态
  // (移交音乐模式时同步为单曲循环)
  const toggleLoop = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const a = audioRef.current
    if (!a) return
    const next = !looping
    setLooping(next)
    a.loop = next
    if (!next) lastPosReportRef.current = -1
    reportAudio(a, true)
  }
  // 进度条拖拽 seek(2026-08-08 用户要求"音频播放气泡支持拖拽进度"):
  // 点击/拖动进度条跳转播放位置;拦截左键(防整条气泡 toggle 与岛体
  // 长按收回)
  const seekFromPointer = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const bar = progressRef.current
    const a = audioRef.current
    if (!bar || !a || !duration || duration <= 0) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    a.currentTime = ratio * duration
    setProgress(a.currentTime / duration)
  }
  if (err) return <MediaError src={src} kind="audio" code={null} />
  const dur = duration != null && Number.isFinite(duration) ? Math.round(duration) : 0
  // 歌名(2026-08-11 用户要求"音频条显示歌名"):alt(media part 的 name)
  // 优先,回退文件名(截扩展名);超长省略
  const voiceTitle = (alt ?? '').replace(/\.[^.]+$/, '') || '语音消息'
  return (
    <div
      className={`island-agent-voice${playing ? ' playing' : ''}${looping ? ' looping' : ''}`}
      role="button"
      tabIndex={0}
      title={alt ? `语音:${alt}` : '语音消息'}
      onClick={(event) => {
        event.stopPropagation()
        toggle()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          toggle()
        }
      }}
      onPointerDown={(event) => {
        if (event.button === 0) event.stopPropagation()
      }}
    >
      <button
        type="button"
        className="island-agent-voice-play"
        aria-label={playing ? '暂停' : '播放'}
        onClick={(event) => {
          event.stopPropagation()
          toggle()
        }}
      >
        {playing ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1.5" />
            <rect x="14" y="5" width="4" height="14" rx="1.5" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 4.5v15l13-7.5z" />
          </svg>
        )}
      </button>
      <span className="island-agent-voice-body">
        {/* 歌名行(2026-08-11 用户要求"音频条显示歌名"):声波在歌名
            左侧,播放时跳动;超长省略号 */}
        <span className="island-agent-voice-title-row">
          <span className="island-agent-voice-wave" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ '--i': i } as CSSProperties} />
            ))}
          </span>
          <span className="island-agent-voice-title" title={voiceTitle}>
            {voiceTitle}
          </span>
        </span>
        <span
          ref={progressRef}
          className="island-agent-voice-progress"
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={dur}
          aria-valuenow={Math.round(progress * dur)}
          onClick={(event) => event.stopPropagation()}
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
            const a = audioRef.current
            if (a) reportAudio(a, true)
          }}
          onPointerCancel={() => {
            scrubbingRef.current = false
          }}
        >
          <span className="island-agent-voice-fill" style={{ width: `${progress * 100}%` }} />
          <span className="island-agent-voice-thumb" style={{ left: `${progress * 100}%` }} aria-hidden="true" />
        </span>
      </span>
      <span className="island-agent-voice-dur">
        {dur >= 60 ? `${Math.floor(dur / 60)}'${String(dur % 60).padStart(2, '0')}″` : `${dur}″`}
      </span>
      {/* 循环按钮(2026-08-11 用户要求"支持切换播放模式(循环)"):切换
          audio.loop(播完自动重播),激活态强调色高亮;与音乐模式单曲
          循环语义对应,移交时经上报的 loop 同步 */}
      <button
        type="button"
        className="island-agent-voice-loop"
        aria-label={looping ? '关闭循环' : '循环播放'}
        aria-pressed={looping}
        title={looping ? '循环播放(点击关闭)' : '循环播放(点击开启)'}
        onClick={toggleLoop}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="17 2 21 6 17 10" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <polyline points="7 22 3 18 7 14" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
      </button>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onError={() => setErr(true)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => {
          const a = event.currentTarget
          setProgress(a.duration > 0 ? a.currentTime / a.duration : 0)
          // 播放进度节流上报(~1Hz;移交音乐模式时从该位置续播,不从头)
          reportAudio(a)
        }}
        onEnded={() => {
          setPlaying(false)
          setProgress(0)
          lastPosReportRef.current = -1
          dispatchAgentMedia('play', { kind: 'audio', src, name: alt, playing: false, loop: loopingRef.current })
        }}
        onPlay={() => {
          setPlaying(true)
          const a = audioRef.current
          if (a) reportAudio(a, true)
          else dispatchAgentMedia('play', { kind: 'audio', src, name: alt, playing: true, loop: loopingRef.current })
        }}
        onPause={() => {
          setPlaying(false)
          lastPosReportRef.current = -1
          dispatchAgentMedia('play', { kind: 'audio', src, name: alt, playing: false, loop: loopingRef.current })
        }}
      />
    </div>
  )
}

/** 拖拽缩放时媒体保持在可视区内(2026-08-08 用户要求"拖多大自动往下
 * 滚多少"):图片/视频拖大后底部超出消息列表可视区 → 自动往下滚到媒体
 * 底部对齐;拖小后顶部超出 → 滚回。每帧随拖拽执行。
 * 2026-08-09 修复"拖大不自动滚(实测图片气泡)":原实现只查 video——
 * 图片 frame 里没有 video 元素,守卫提前返回,图片拖大从不滚动;
 * 改为 video/img 任一存在即跟随,rect 量 frame 本身(img/video 都
 * 100% 填满 frame,等价且更稳) */
function followMediaInView(frame: HTMLElement | null) {
  const media = frame?.querySelector('video, img')
  const scroller = frame?.closest('.island-agent-messages') as HTMLElement | null
  if (!frame || !media || !scroller) return
  const vr = frame.getBoundingClientRect()
  const cr = scroller.getBoundingClientRect()
  if (vr.bottom > cr.bottom) scroller.scrollTop += vr.bottom - cr.bottom
  else if (vr.top < cr.top) scroller.scrollTop -= cr.top - vr.top
}

/**
 * 定制视频播放器(2026-08-08 用户要求"不要原生控件"):自定义控件层
 * (底部渐变遮罩 + 播放/暂停 + 可拖动进度条 + 时间 + 全屏按钮);
 * 全屏 = 整个播放器容器 requestFullscreen(控件随容器进入全屏层,
 * 原生 video 全屏层无法带自定义控件);全屏进入/退出有过渡动画。
 * 控件事件全部拦截左键(消息区内交互,防岛体长按收回)
 */
function VideoPlayer({
  src,
  cacheKey,
  videoKey,
  autoPlay = false,
  onAspect,
  onError,
  onPlayingChange,
  onProgress,
}: {
  src: string
  /** 进度缓存 key = 消息里原始路径(2026-08-09 双向同步;src 是
   * resolved 协议 URL,与缓存 key 不一致) */
  cacheKey?: string
  /** 每视频个性化 key(2026-08-10 多视频独立音量/播放模式;= 媒体的
   * alt,与 data-media-name / 桥 getConversationMedia 的 name 一致;
   * 缺省 = 共享偏好,仅响应全局设置) */
  videoKey?: string
  /** 2026-08-10 用户要求"LLM 播放视频,加载出媒体元素后自动播放" */
  autoPlay?: boolean
  onAspect: (aspect: number) => void
  onError: (code: number | null) => void
  /** 播放状态变化(2026-08-09 媒体小窗上报用) */
  onPlayingChange?: (playing: boolean) => void
  /** 播放进度上报(2026-08-09 小窗续播用;timeupdate 每 ~250ms,
   * 由调用方节流) */
  onProgress?: (position: number) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [current, setCurrent] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  // 退出全屏缩回动画(播完移除 class)
  const [leavingFs, setLeavingFs] = useState(false)
  const fsLeaveTimerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(fsLeaveTimerRef.current), [])
  // 自动播放标记(2026-08-11 从下方 effect 提前:封面抓帧 effect 需要
  // 在挂载时判断"是否将自动播放"——自动播放的视频**不抓封面**,否则
  // 抓帧的 seek(0.05) 会打断同时进行的 play()(AbortError 被静默吞掉,
  // 视频停在暂停,实测 data URL 快媒体 chat-media 巡检 AUTOPLAY 失败;
  // 本地协议慢媒体 play 先成功侥幸通过)——自动播放意味着马上要放,
  // 封面没有意义,播完暂停显示真实帧)
  const autoPlayOnceRef = useRef(autoPlay)
  // 视频封面(2026-08-10 用户要求"默认展示视频第一帧作为封面,不然
  // 黑色的也不清楚"):未播放时黑色画面难辨认——加载完成后暂停态
  // seek 到小偏移用 canvas 抓第一帧转 dataURL 作封面;**仅从未播放
  // 过时显示**(播放过/暂停显示真实帧,不遮挡)
  const [poster, setPoster] = useState<string | null>(null)
  const posterTriedRef = useRef(false)
  const everPlayedRef = useRef(false)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    // 自动播放的视频跳过封面抓帧(2026-08-11,见上方 autoPlayOnceRef 注释)
    if (autoPlayOnceRef.current) return
    // 续播媒体跳过封面抓帧(2026-08-10 修复"视频岛切回面板进度没同步"):
    // 缓存位置 > 0 = 续播场景——抓帧 seek(0.05) 与续播 seek(缓存位置)
    // 竞态,抓帧 seeked 回调的 restore 会把进度重置回 0(实测);续播
    // seek 后显示的即是真实画面,不需要封面
    const pos = cacheKey ? readAgentMediaPosition(cacheKey) : undefined
    if (pos && pos > 0) return
    const capture = () => {
      if (posterTriedRef.current || v.readyState < 2 || !v.paused) return
      posterTriedRef.current = true
      const restore = v.currentTime
      const onSeeked = () => {
        v.removeEventListener('seeked', onSeeked)
        try {
          // 长边缩到 640(气泡显示约 320 宽,足够清晰且 dataURL 小)
          const scale = Math.min(1, 640 / Math.max(v.videoWidth || 1, v.videoHeight || 1))
          const c = document.createElement('canvas')
          c.width = Math.max(1, Math.round((v.videoWidth || 1) * scale))
          c.height = Math.max(1, Math.round((v.videoHeight || 1) * scale))
          c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
          const url = c.toDataURL('image/jpeg', 0.72)
          if (url && url.length > 200) setPoster(url)
        } catch {
          // 抓帧失败忽略(保持黑色,可播放)
        }
        try {
          v.currentTime = restore
        } catch {
          // 恢复位置失败忽略
        }
      }
      v.addEventListener('seeked', onSeeked)
      try {
        // 小偏移防首帧黑(部分编码首帧黑场)
        v.currentTime = 0.05
      } catch {
        v.removeEventListener('seeked', onSeeked)
      }
    }
    const tryCapture = () => {
      if (v.readyState >= 2) capture()
    }
    v.addEventListener('loadeddata', tryCapture)
    v.addEventListener('loadedmetadata', tryCapture)
    if (v.readyState >= 2) capture()
    return () => {
      v.removeEventListener('loadeddata', tryCapture)
      v.removeEventListener('loadedmetadata', tryCapture)
    }
  }, [])
  // 挂载续播(2026-08-09 双向同步):小窗播放/seek 的进度经
  // readAgentMediaPosition 读回,面板重新挂载(收起后再展开)时从该
  // 位置继续,不再从头;仅同 src、仅挂载时一次。
  // **播放状态同步(2026-08-10 用户要求"从视频岛切换回对话窗口,如果
  // 是播放状态,应该要同步的;和初次加载自动播放的逻辑分开")**:
  // lastPlayingVideoSrc === cacheKey = 另一端(视频岛)播放中——seek 到
  // 缓存位置后**继续播放**。**与初次加载自动播放(mediaAutoPlay 标记,
  // 当次对话首次流式落定只播一次)分开**:本机制按当前真实播放状态恢复,
  // 每次重挂载都生效;视频岛暂停/播完(dispatch playing:false)则清除,
  // 切回面板不自动播
  useEffect(() => {
    const v = videoRef.current
    const pos = cacheKey ? readAgentMediaPosition(cacheKey) : undefined
    if (!v || !pos || pos <= 0) return
    const resume = lastPlayingVideoSrc === cacheKey
    const start = () => {
      try {
        v.currentTime = pos
      } catch {
        // seek 失败忽略
      }
      if (resume) void v.play().catch(() => {})
    }
    if (v.readyState >= 1) start()
    else v.addEventListener('loadedmetadata', start, { once: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载续播
  }, [])
  // 黑屏检测(2026-08-11 修复"bili 下载的 HEVC 视频在对话窗口播放全黑"):
  // HEVC 在禁用硬件加速(透明窗口 alpha 稳定需要)下,Media Foundation
  // 解码器**零帧呈现**——表现 = 时间轴/音频正常、无 error 事件,但
  // videoWidth 恒为 0(实测真实应用 fr=0/vw=0)。元数据加载 2.5s 后
  // 仍无视频尺寸 → 按解码失败处理(code 9 自定义),展示明确错误文案 +
  // 系统播放器打开,不再静默全黑
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    let timer = 0
    const check = () => {
      if (v.error) return // 已有错误事件:走原生错误路径(code 4 等)
      if (v.paused) return // 未播放:解码器未启动,vw=0 是正常状态
      if (v.videoWidth > 0 || v.videoHeight > 0) return
      onError(9)
    }
    // 仅播放中才计时(暂停时 vw=0 正常;play 事件重武装——暂停后再播
    // 也检;meta 加载时已在播则立即计时)
    const arm = () => {
      if (v.paused) return
      window.clearTimeout(timer)
      timer = window.setTimeout(check, 2500)
    }
    v.addEventListener('loadedmetadata', arm)
    v.addEventListener('play', arm)
    if (v.readyState >= 1 && !v.paused) arm()
    return () => {
      v.removeEventListener('loadedmetadata', arm)
      v.removeEventListener('play', arm)
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载一次
  }, [])
  // 应用播放偏好(2026-08-10 双向同步:音量/倍速/循环与视频岛/多媒体
  // 库共享;2026-08-10 二轮:videoKey 指定时读**该视频个性化**,缺省
  // 回退共享——挂载时读当前值应用到 video)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const p = loadVideoPrefs(videoKey)
    v.volume = p.volume
    v.muted = p.volume === 0
    v.playbackRate = p.speed
    v.loop = p.loop
  }, [])
  // 自动播放(2026-08-10 用户要求"LLM 播放视频,加载出媒体元素后自动
  // 播放";三轮修复):**挂载时一次性捕获 autoPlay(useRef,声明已提前到
  // 封面抓帧 effect 之前,2026-08-11)**——消费标记使 prop 变 false 时
  // effect 不重跑(cleanup 移除 loadedmetadata 监听会让慢加载媒体永远
  // 等不到 play,2026-08-10 音频实测根因);**readyState >= 1 即 play**
  // (play() 触发继续加载;原等 canplay 在 preload=metadata 下可能永不
  // 触发,短媒体播完/未播静默失败实测)。被策略拦截静默回退封面+播放键
  // (不误报);与挂载续播并存:面板重挂载场景先从缓存位置 seek,再自动
  // 播放续上;重挂载新实例读 false 不播
  useEffect(() => {
    if (!autoPlayOnceRef.current) return
    const v = videoRef.current
    if (!v) return
    const start = () => void v.play().catch(() => {})
    if (v.readyState >= 1) start()
    else v.addEventListener('loadedmetadata', start, { once: true })
    return () => v.removeEventListener('loadedmetadata', start)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载一次
  }, [])
  // 全屏状态跟踪 + 退出动画
  // **监听挂 document(2026-08-10 修复"全屏后按钮无 UI 变化")**:
  // fullscreenchange 事件派发在**全屏元素**(playerRef 容器,requestFullscreen
  // 的调用对象)上并冒泡到 document——原监听挂在 video 上,video 是容器
  // 的子元素,不在冒泡路径上,永远收不到事件(实测:全屏后按钮图标不变、
  // 容器 .fullscreen 类不加);与视频岛(AgentMediaMini)/图片全屏同款
  // document 级监听
  useEffect(() => {
    const onChange = () => {
      const fs = document.fullscreenElement === playerRef.current
      setFullscreen(fs)
      if (!fs) {
        // 退出全屏:播缩回动画(scale + 淡出 0.2s)后移除
        setLeavingFs(true)
        window.clearTimeout(fsLeaveTimerRef.current)
        fsLeaveTimerRef.current = window.setTimeout(() => setLeavingFs(false), 220)
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const scrubbingRef = useRef(false)
  const toggle = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }
  // 控件自动隐藏(2026-08-10 用户要求"鼠标移开播放器后过几秒自动
  // 隐藏"):**空闲计时驱动**(2026-08-10 二轮修复"从视频岛切回对话窗口
  // 控件不自动隐藏":原实现只靠 mouseleave 计时——切回时鼠标已停在
  // 播放器上(mouseenter 不触发、leave 永不触发),控件一直显示,要
  // 交互一下才开始计时)——播放中任何交互(移入/移动/移出/拖进度)
  // 都会**重启 2.5s 空闲计时**,超时控件淡出(纯视频画面,CSS opacity +
  // pointer-events none);暂停保持显示(用户要看进度条/状态)
  const [uiHidden, setUiHidden] = useState(false)
  const uiHideTimerRef = useRef(0)
  const playingRef = useRef(playing)
  playingRef.current = playing
  useEffect(() => () => window.clearTimeout(uiHideTimerRef.current), [])
  // 重启空闲隐藏计时(播放中才进入;暂停/拖拽进度中不计时)
  const restartHideTimer = () => {
    window.clearTimeout(uiHideTimerRef.current)
    if (playingRef.current && !scrubbingRef.current) {
      uiHideTimerRef.current = window.setTimeout(() => setUiHidden(true), 2500)
    }
  }
  const showUi = () => {
    setUiHidden(false)
    restartHideTimer()
  }
  // 播放开始(含挂载续播:切回面板时鼠标已在播放器上,交互事件不触发
  // ——playing effect 启动计时兜底)计时;暂停清除并保持显示
  useEffect(() => {
    if (playing) restartHideTimer()
    else {
      setUiHidden(false)
      window.clearTimeout(uiHideTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 播放状态变化驱动
  }, [playing])
  const seekFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bar = barRef.current
    const v = videoRef.current
    if (!bar || !v || duration <= 0) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    v.currentTime = ratio * duration
    setCurrent(v.currentTime)
  }
  const toggleFullscreen = () => {
    const p = playerRef.current
    if (!p) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void p.requestFullscreen().catch(() => {})
  }
  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0
  return (
    <div
      ref={playerRef}
      className={`island-video-player${fullscreen ? ' fullscreen' : ''}${leavingFs ? ' leaving-fullscreen' : ''}`}
      onPointerDown={(event) => {
        if (event.button === 0) event.stopPropagation()
      }}
      onMouseEnter={showUi}
      onMouseLeave={restartHideTimer}
      onMouseMove={showUi}
    >
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        // 本地协议视频 CORS 加载(2026-08-10 封面抓帧修复):island-media
        // 协议已返回 Access-Control-Allow-Origin: *,不加 crossorigin 时
        // video 按 no-cors 加载,drawImage 到 canvas 被判 Tainted 无法
        // toDataURL(实测);远程 https(可能无 CORS 头)不加,避免破坏
        // 现有播放
        crossOrigin={src.startsWith('island-media:') ? 'anonymous' : undefined}
        onClick={(event) => {
          event.stopPropagation()
          toggle()
        }}
        onError={(event) => onError(event.currentTarget.error?.code ?? null)}
        onLoadedMetadata={(event) => {
          const v = event.currentTarget
          setDuration(v.duration || 0)
          if (v.videoWidth > 0 && v.videoHeight > 0) onAspect(v.videoWidth / v.videoHeight)
        }}
        onTimeUpdate={(event) => {
          setCurrent(event.currentTarget.currentTime)
          onProgress?.(event.currentTarget.currentTime)
        }}
        onEnded={() => {
          setPlaying(false)
          setCurrent(0)
          onProgress?.(0)
          onPlayingChange?.(false)
        }}
        onPlay={() => {
          everPlayedRef.current = true
          setPlaying(true)
          onPlayingChange?.(true)
        }}
        onPause={() => {
          setPlaying(false)
          onPlayingChange?.(false)
        }}
      />
      {/* 封面(2026-08-10 用户要求):未播放过时显示第一帧(黑色画面
          难辨认);播放过/暂停后显示真实帧不遮挡;pointer-events none
          点击穿透到 video(点击播放/暂停照常) */}
      {poster && !playing && !everPlayedRef.current ? (
        <img
          src={poster}
          alt=""
          draggable={false}
          className="island-video-poster"
          aria-hidden="true"
        />
      ) : null}
      {/* 自定义控件层(底部渐变遮罩;全屏时随容器进入全屏层;
          鼠标移开自动隐藏,见 uiHidden 逻辑) */}
      <div
        className={`island-video-controls${uiHidden ? ' ui-hidden' : ''}`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="island-video-play"
          aria-label={playing ? '暂停' : '播放'}
          onClick={(event) => {
            event.stopPropagation()
            toggle()
          }}
        >
          {playing ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" rx="1.5" />
              <rect x="14" y="5" width="4" height="14" rx="1.5" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 4.5v15l13-7.5z" />
            </svg>
          )}
        </button>
        <div
          ref={barRef}
          className="island-video-bar"
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
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
            restartHideTimer() // 拖拽结束重启空闲计时(2.5s 无操作再隐藏)
          }}
          onPointerCancel={() => {
            scrubbingRef.current = false
            restartHideTimer()
          }}
        >
          <div className="island-video-bar-fill" style={{ width: `${pct}%` }} />
          <span className="island-video-bar-thumb" style={{ left: `${pct}%` }} aria-hidden="true" />
        </div>
        <span className="island-video-time">
          {fmtMediaTime(current)} / {fmtMediaTime(duration)}
        </span>
        {/* 音量 + 更多(2026-08-10 用户要求:定制 UI,与视频岛/多媒体库
            双向同步) */}
        <VideoExtras videoRef={videoRef} videoKey={videoKey} />
        {/* 全屏按钮(2026-08-10 用户要求:缩小对齐音量/更多键,放在
            ⋯ 键右边,同排同高;控件层内 flex 流,全屏随容器进入全屏层) */}
        <button
          type="button"
          className="island-video-fs"
          aria-label={fullscreen ? '退出全屏' : '全屏'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            toggleFullscreen()
          }}
        >
          {fullscreen ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}

/** 媒体时间格式 m:ss */
function fmtMediaTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 播放速度档位(⋯ 菜单) */
const VIDEO_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

/**
 * 定制视频扩展控件(2026-08-10 用户要求,多媒体库原生 controls 的
 * 音量/更多选项改定制 UI,对话播放器与视频岛共用):
 * - **音量**:喇叭按钮(点击静音切换)+ 悬停滑杆(0-100%);
 * - **更多(⋯)菜单**:播放速度档位 + 循环开关,点外关闭;
 * - **双向同步**:偏好经 videoPrefs 共享(volume/speed/loop 写
 *   localStorage + 派发事件),三处播放器(对话/视频岛/多媒体库)
 *   任一改动,其余订阅即时同步。
 */
export function VideoExtras({
  videoRef,
  videoKey,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 每视频个性化 key(2026-08-10 多视频独立音量/播放模式;缺省 =
   * 共享偏好,响应全局设置) */
  videoKey?: string
}) {
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(() => loadVideoPrefs(videoKey).volume)
  const [speed, setSpeed] = useState(() => loadVideoPrefs(videoKey).speed)
  const [loop, setLoop] = useState(() => loadVideoPrefs(videoKey).loop)
  const [moreOpen, setMoreOpen] = useState(false)
  const [moreLeaving, setMoreLeaving] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const moreLeaveTimerRef = useRef(0)
  // 音量条(2026-08-10 用户要求"从音量键延伸的 UI"):自绘竖直条,
  // pointer 拖拽计算比例
  const volPopRef = useRef<HTMLSpanElement>(null)
  const volDraggingRef = useRef(false)
  useEffect(() => () => window.clearTimeout(moreLeaveTimerRef.current), [])
  // 双向同步:外部(prefs 事件)改动 → 本地状态 + video 生效。
  // **按 key 过滤(2026-08-10 多视频独立控制)**:个性化事件(key)只对
  // 匹配的视频生效;共享事件(无 key)只影响不带 videoKey 的播放器
  // (多媒体库等)——调一个视频不影响其它视频的独立设置
  useEffect(
    () =>
      onVideoPrefsChange((p) => {
        if (p.key && p.key !== videoKey) return
        if (!p.key && videoKey) return
        setVolume(p.volume)
        setSpeed(p.speed)
        setLoop(p.loop)
        const v = videoRef.current
        if (v) {
          v.volume = p.volume
          v.playbackRate = p.speed
          v.loop = p.loop
        }
      }),
    [videoRef, videoKey],
  )
  // 点外关闭 ⋯ 菜单(播离场动画后卸载;逻辑内联避免闭包依赖)
  useEffect(() => {
    if (!moreOpen) return
    const onDoc = (e: PointerEvent) => {
      const el = moreRef.current
      if (el && !el.contains(e.target as Node)) {
        setMoreLeaving(true)
        window.clearTimeout(moreLeaveTimerRef.current)
        moreLeaveTimerRef.current = window.setTimeout(() => {
          setMoreOpen(false)
          setMoreLeaving(false)
        }, 160)
      }
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [moreOpen])
  const closeMore = () => {
    if (!moreOpen) return
    setMoreLeaving(true)
    window.clearTimeout(moreLeaveTimerRef.current)
    moreLeaveTimerRef.current = window.setTimeout(() => {
      setMoreOpen(false)
      setMoreLeaving(false)
    }, 160)
  }
  const setVolFromPointer = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const pop = volPopRef.current
    if (!pop) return
    const rect = pop.getBoundingClientRect()
    if (rect.height <= 0) return
    const ratio = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    changeVolume(ratio)
  }
  const changeVolume = (next: number) => {
    const v = Math.min(1, Math.max(0, next))
    setVolume(v)
    setMuted(v === 0)
    const el = videoRef.current
    if (el) {
      el.volume = v
      el.muted = v === 0
    }
    setVideoPrefs({ volume: v }, videoKey)
  }
  const toggleMute = () => {
    const nextMuted = !muted
    setMuted(nextMuted)
    const el = videoRef.current
    if (el) el.muted = nextMuted
    // 取消静音时恢复音量滑杆值(音量 0 视为静音,点击恢复默认 0.8)
    if (!nextMuted) {
      const target = volume > 0 ? volume : 0.8
      setVolume(target)
      if (el) el.volume = target
      setVideoPrefs({ volume: target }, videoKey)
    }
  }
  const changeSpeed = (next: number) => {
    setSpeed(next)
    const el = videoRef.current
    if (el) el.playbackRate = next
    setVideoPrefs({ speed: next }, videoKey)
  }
  const toggleLoop = () => {
    const next = !loop
    setLoop(next)
    const el = videoRef.current
    if (el) el.loop = next
    setVideoPrefs({ loop: next }, videoKey)
  }
  return (
    // 拦截 pointerdown 冒泡(2026-08-10:视频岛进度条行 onPointerDown
    // 是 seek,点音量/更多按钮会误触发进度跳转)
    <span
      className="island-video-extras"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* 音量:喇叭按钮 + 从按钮向上延伸的自绘竖直条(2026-08-10
          用户要求"完全在音量键上方,从音量键延伸的 UI";悬停/拖拽
          显示,scaleY 从按钮顶生长动画) */}
      <span className="island-video-vol">
        <button
          type="button"
          className="island-video-vol-btn"
          aria-label={muted ? '取消静音' : '静音'}
          title={muted ? '取消静音' : '静音'}
          onClick={(event) => {
            event.stopPropagation()
            toggleMute()
          }}
        >
          {muted || volume === 0 ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
          ) : volume < 0.5 ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.5 8.5a5 5 0 0 1 0 7" />
              <path d="M19 5a10 10 0 0 1 0 14" />
            </svg>
          )}
        </button>
        <span
          ref={volPopRef}
          className="island-video-vol-pop"
          aria-hidden="true"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            volDraggingRef.current = true
            event.currentTarget.setPointerCapture(event.pointerId)
            setVolFromPointer(event)
          }}
          onPointerMove={(event) => {
            if (volDraggingRef.current) setVolFromPointer(event)
          }}
          onPointerUp={() => {
            volDraggingRef.current = false
          }}
          onPointerCancel={() => {
            volDraggingRef.current = false
          }}
        >
          {/* 背景槽(2026-08-10 用户要求"加入背景 UI" + 修复"还没移动
              到音量条上就消失":18px 宽深色圆角槽 = 大命中区(原 4px
              窄条鼠标稍偏即丢 hover),槽是 vol 子元素、hover 保持在
              槽上;槽底贴按钮顶(无间隙,鼠标从按钮移向条路径连续) */}
          <span className="island-video-vol-pop-track">
            <span className="island-video-vol-pop-fill" style={{ height: `${Math.round(volume * 100)}%` }} />
          </span>
        </span>
      </span>
      {/* 更多(⋯):倍速 + 循环 */}
      <span className="island-video-more" ref={moreRef}>
        <button
          type="button"
          className="island-video-more-btn"
          aria-label="更多选项"
          title="更多选项"
          onClick={(event) => {
            event.stopPropagation()
            if (moreOpen) closeMore()
            else {
              setMoreLeaving(false)
              setMoreOpen(true)
            }
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
          </svg>
        </button>
        {moreOpen ? (
          // 呼出 = island-ui-in 回弹淡入;消失 = moreLeaving 播
          // island-ui-out 上移淡出后卸载(2026-08-10 用户要求动画)
          <div
            className={`island-video-more-menu${moreLeaving ? ' leaving' : ''}`}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="island-video-more-label">播放速度</span>
            <div className="island-video-more-speeds">
              {VIDEO_SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`island-video-more-item${speed === s ? ' on' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    changeSpeed(s)
                  }}
                >
                  {s}x
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`island-video-more-item island-video-more-loop${loop ? ' on' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                toggleLoop()
              }}
            >
              循环播放
            </button>
          </div>
        ) : null}
      </span>
    </span>
  )
}

/** 媒体源解析(2026-08-09):本地路径 → island-media 协议(主进程流式
 * 播放),远程 https/data:/blob: 原样;消息气泡与媒体小窗共用 */
export function resolveMediaSrc(src: string): string {
  return /^(https?:|data:|blob:)/i.test(src) ? src : `island-media://local/${encodeURIComponent(src)}`
}

/** 对话媒体小窗上报(2026-08-09):MediaFrame/VoiceBubble 挂载/播放/
 * 卸载时经 DOM 事件上报"最近媒体"——收起 Agent 面板时灵动岛据其
 * 变形成小窗(视频/图片)或自动切音乐模式(音频)。事件绕开多层
 * prop 传递,与设置桥 island-settings-changed 同款解耦模式。
 * position = 播放进度(2026-08-09 修复"收起变多媒体岛从头播放":
 * 小窗挂载时 seek 到该位置续播,不从头播) */
export const AGENT_MEDIA_EVENT = 'island:agent-media'
export interface AgentMediaReport {
  kind: 'video' | 'img' | 'audio'
  src: string
  name?: string
  playing?: boolean
  /** 播放进度秒(视频与音频节流 ~1Hz 上报) */
  position?: number
  /** 循环播放(2026-08-11 音频条循环按钮;移交音乐模式时同步为单曲循环) */
  loop?: boolean
  /** 媒体元素当前显示宽度 px(2026-08-10 小窗尺寸同步:收起为多媒体岛
   * 时小窗 = 对话窗口里媒体元素的尺寸,切回面板保持相同尺寸) */
  width?: number
  /** 宽高比(视频 = 真实比例,未知 16/9;图片 = 自然比) */
  aspect?: number
}
// 媒体播放位置缓存(2026-08-09 双向同步):小窗/面板任一端的播放进度
// 经 dispatchAgentMedia('play') 写入;另一端挂载时按 src 读回续播——
// 面板 ↔ 小窗双向同步,不依赖 React 状态传递
const agentMediaPositions = new Map<string, number>()
export function readAgentMediaPosition(src: string): number | undefined {
  return agentMediaPositions.get(src)
}
// 媒体元素尺寸缓存(2026-08-10 小窗尺寸同步):面板 ↔ 小窗任一端的
// 当前显示尺寸(宽 + 宽高比)经 dispatch('play') 写入;另一端挂载时
// 按 src 读回——收起为多媒体岛时小窗 = 面板里媒体元素的尺寸,切回
// 面板保持相同尺寸(用户要求"做成一模一样的小窗")
const agentMediaSizes = new Map<string, { width: number; aspect: number }>()
export function readAgentMediaSize(src: string): { width: number; aspect: number } | undefined {
  return agentMediaSizes.get(src)
}
// 最后播放中的视频 src(2026-08-10 **播放状态同步**,与初次加载自动播放
// 分开的独立机制):dispatch('play' playing:true) 记录、playing:false
// (仅同 src)清除——另一端(视频岛 ↔ 对话窗口)挂载时若该媒体处于播放
// 状态,seek 到缓存位置后**继续播放**。区别于 mediaAutoPlay(当次对话
// 首次流式落定只自动播一次、消费后清):播放状态同步每次重挂载都按
// 当前真实播放状态恢复(视频岛在播 → 切回面板继续播;面板手动暂停 →
// playing:false 清除 → 重挂载不播)
let lastPlayingVideoSrc: string | null = null

/**
 * 清除"最后播放中的视频"续播标记(2026-08-11 用户要求"从别的窗口/模式
 * 切换回 Agent 对话,不是第一次加载不需要自动播放;除非从视频岛正在
 * 播放的视频切换回来"):
 * - 面板/视频岛**卸载且播放停止**的场景(收起为灵动岛、模式切换、清
 *   数据)调用——重挂载不再"诈尸续播";
 * - **视频岛在播 → 展开面板的路径不清**(展开不是模式切换/收起,小窗
 *   卸载后播放状态由面板接管,续播保留);
 * - 视频岛暂停/播完本就经 dispatch playing:false 清除(本函数兜底
 *   非事件路径)
 */
export function clearAgentVideoResume(): void {
  lastPlayingVideoSrc = null
}
export function dispatchAgentMedia(type: 'mount' | 'play' | 'unmount', media: AgentMediaReport) {
  if (type === 'play' && Number.isFinite(media.position)) {
    agentMediaPositions.set(media.src, media.position as number)
  }
  if (type === 'play' && media.kind === 'video') {
    if (media.playing) lastPlayingVideoSrc = media.src
    else if (lastPlayingVideoSrc === media.src) lastPlayingVideoSrc = null
    if (typeof media.width === 'number' && Number.isFinite(media.width) && media.width > 0) {
      agentMediaSizes.set(media.src, {
        width: Math.round(media.width),
        aspect: typeof media.aspect === 'number' && media.aspect > 0 ? media.aspect : 16 / 9,
      })
    }
  }
  document.dispatchEvent(new CustomEvent(AGENT_MEDIA_EVENT, { detail: { type, media } }))
}

/**
 * 对话媒体窗口(2026-08-08):![alt](url) 按扩展名分派的图片/视频/音频;
 * 也供引擎 media part(open_file 媒体拦截)渲染。
 * - **图片/视频 = 气泡 UI 包裹**(圆角卡片 + 描边 + 阴影),**右下角
 *   单手柄拖拽等比例缩放**(2026-08-08 用户要求"四周改回右下角触发":
 *   宽 = 自然比例换算,钳制 120-640,手柄为简约斜纹 grip,悬浮浮现);
 * - **拖拽时岛体底部自动跟随**(拖多大自动往下滚多少:视频/图片底部
 *   超出消息列表可视区即滚动对齐,拖小回滚);
 * - **视频 = 定制播放器**(VideoPlayer:自定义控件层播放/暂停/进度/
 *   时间/全屏,全屏容器级带动画,原生控件弃用);
 * - **音频 = QQ/微信风格语音气泡**(见 VoiceBubble);
 * - 远程(https/data:/blob:)直接加载;CSP 已放行 img/media 的 https:;
 * - **本地路径/file: 链接映射为 `island-media://local/<编码路径>` 协议
 *   URL**——主进程按扩展名校验 + 按类型大小上限(视频 10GB/音频 1GB/
 *   图片 10GB)流式返回,Chromium 媒体栈边下边播,大文件不整体进内存;
 * - 播放失败 → MediaError 降级「用系统播放器打开」(外部播放器仅为
 *   降级选择);
 * - 初始宽 = 媒体窗口默认设置(localStorage widget-media-window);
 * - **图片初始宽 = 原图宽(2026-08-11 用户要求"对话窗口内自定义图片被
 *   压缩,改成原图;音乐模式不变"):图片不再按媒体窗口默认宽(320px)
 *   显示——大图按原图 naturalWidth 显示(超出消息列表由 CSS max-width:
 *   100% 兜底压缩保持比例),拖拽缩放/小窗尺寸缓存优先(用户调整过的
 *   尺寸保留);视频无"原图"概念,仍用媒体窗口默认宽。
 */
export function MediaFrame({
  kind,
  src,
  alt,
  autoPlay = false,
}: {
  kind: 'img' | 'video' | 'audio'
  src: string
  alt?: string
  /** 2026-08-10 用户要求"LLM 播放视频/音频,加载出媒体元素后自动播放"——
   * 工具拦截产生的媒体附件(open_file / exec_command start)传 true,
   * 媒体就绪后自动播放;markdown ![url] 图片/视频保持被动(默认 false) */
  autoPlay?: boolean
}) {
  // 本地路径(非 https/data:/blob:)→ island-media 协议 URL(流式播放)
  const resolved = resolveMediaSrc(src)
  const [err, setErr] = useState<{ code: number | null } | null>(null)
  // 2026-08-09:挂载/卸载上报已移除——消息列表分批挂载(visibleCount)
  // 时上报顺序 ≠ 消息顺序,最后上报的可能是中间批次的旧媒体(实测
  // 移交错取旧音频);小窗/移交候选改由 AgentView 从消息**数据**计算
  // (onMediaSnapshot),播放状态仍经事件上报(小窗续播标记)
  // 拖拽尺寸:width null = 用默认设置;拖拽后按比例缩放。
  // **2026-08-10 小窗尺寸同步:初始宽优先该媒体上次的显示尺寸**
  // (小窗 → 面板切换保持相同尺寸,见 agentMediaSizes 缓存;无记录
  // 才用媒体窗口默认设置)
  const [width, setWidth] = useState<number | null>(() => {
    const cached = src ? readAgentMediaSize(src) : undefined
    return cached ? Math.round(cached.width) : null
  })
  const [aspect, setAspect] = useState<number | null>(null)
  // 图片原图宽(2026-08-11 用户要求"对话窗口内自定义图片改成原图"):
  // onLoad 读 naturalWidth——图片初始宽 = 原图宽(非媒体窗口默认 320,
  // 那是视频的默认;大图按原图显示,超出面板由 CSS 兜底);拖拽缩放/
  // 小窗尺寸缓存(width 非 null)优先于原图(用户调整过的尺寸保留)
  const [naturalW, setNaturalW] = useState<number | null>(null)
  // 图片全屏状态(2026-08-10 用户要求:全屏图标切换;容器级全屏,
  // 范围 = Agent 对话窗口)
  const [imgFullscreen, setImgFullscreen] = useState(false)
  useEffect(() => {
    if (kind !== 'img') return
    const onChange = () => setImgFullscreen(document.fullscreenElement === frameRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [kind])
  // 拖拽中(resizing = 手柄保持可见)
  const [resizing, setResizing] = useState(false)
  const frameRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; w: number; aspect: number } | null>(null)
  // 播放进度节流上报(2026-08-09 小窗续播):每秒至多一次 dispatch,
  // 存最近整秒位置供 onPlayingChange(暂停/切状态)携带
  const lastPosRef = useRef(-1)
  // 右下角拖拽缩放(pointer capture;消息区内交互,拦截左键防长按收回):
  // 等比例宽度变化(dw = dx + dy×aspect,右下角锚点),钳制 [120, 640];
  // 拖拽中跟随滚动(岛体底部自动对齐,见 followMediaInView)
  const onResizeDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      w: width ?? readMediaWindowWidth(),
      aspect: aspect ?? 1,
    }
    setResizing(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onResizeMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = event.clientX - d.x
    // **纯水平 1:1 跟手(2026-08-08 用户要求"鼠标动一点缩放就很大不
    // 跟手")**:原 dw = dx + dy×aspect 中垂直分量对 16:9 视频放大
    // 1.78 倍、斜向拖动双轴叠加——鼠标移 1px 视频宽变近 2px。
    // 等比例缩放由宽度决定大小(高度自动按宽高比),水平移 1px = 宽
    // 1px 完全跟手;垂直位移不再缩放
    setWidth(Math.round(Math.min(MEDIA_MAX_W, Math.max(MEDIA_MIN_W, d.w + dx))))
    // 滚动跟随在下方 useEffect([width]) 里做:setWidth 是异步 React
    // 更新,pointermove 时布局还是旧尺寸,立即滚动读不到新高度
  }
  const onResizeEnd = () => {
    dragRef.current = null
    setResizing(false)
  }
  // 拖拽缩放后岛体底部自动跟随(2026-08-08 用户要求"拖多大自动往下
  // 滚多少"):width 每次变化(React 提交后布局已更新)把媒体底部滚入
  // 消息列表可视区;拖小回滚顶部
  useEffect(() => {
    if (width === null) return
    followMediaInView(frameRef.current)
  }, [width])
  // 尺寸上报(2026-08-10 小窗尺寸同步):面板当前显示尺寸(宽 + 宽高比)
  // 经 dispatch 写入 agentMediaSizes 缓存——收起为多媒体岛时小窗按此
  // 尺寸生成,切回面板保持相同尺寸。宽度变化(拖拽缩放)在 React 提交
  // 后布局已更新时上报(offsetWidth = 新宽,与 followMediaInView 同款
  // 时序);播放进度上报(onProgress)顺带带尺寸
  useEffect(() => {
    if (kind !== 'video' || width === null) return
    const v = frameRef.current?.querySelector('video')
    dispatchAgentMedia('play', {
      kind: 'video',
      src,
      name: alt,
      playing: v ? !v.paused : false,
      position: lastPosRef.current,
      width,
      aspect: aspect ?? 16 / 9,
    })
  }, [width, kind, src, alt, aspect])
  if (err) return <MediaError src={resolved} kind={kind} code={err.code} />
  // 音频 = 语音气泡(不参与拖拽缩放;LLM 播放的音频自动播放)
  if (kind === 'audio') return <VoiceBubble src={resolved} alt={alt} autoPlay={autoPlay} />
  // 图片原图优先(2026-08-11):width(拖拽/小窗缓存) → 图片原图宽 →
  // 媒体窗口默认宽;视频保持默认宽(无"原图"概念,元数据加载后按
  // 真实比例,16/9 兜底)
  const w = width ?? (kind === 'img' ? (naturalW ?? readMediaWindowWidth()) : readMediaWindowWidth())
  // 图片/视频:气泡容器固定宽 + 按自然比例的高,内容 100% 填充(无留白)。
  // 外层 wrap 承载拖拽手柄(2026-08-08 用户要求"手柄移到气泡外面"——
  // 与全屏按键重叠):frame 有 overflow:hidden 裁剪内容圆角,手柄放
  // frame 内会被裁;wrap 相对定位,手柄凸出在气泡右下角外侧
  return (
    <div className={`island-media-wrap${resizing ? ' resizing' : ''}`}>
      <div
        ref={frameRef}
        className="island-media-frame"
        // 媒体名(2026-08-10,get_conversation_media 工具读取:LLM 查对话
        // 窗口有哪些媒体附件、哪个在播放)
        data-media-name={alt ?? ''}
        // aspect 未知(视频元数据未加载)时 16/9 兜底:video 元素没有
        // 内在尺寸,容器无高度 = 高度 0 = **视频不可见**(2026-08-08
        // 修复"播放视频看不到");元数据加载后按真实比例修正
        style={{ width: w, aspectRatio: aspect != null ? String(aspect) : '16 / 9' }}
      >
        {kind === 'img' ? (
          <>
            <img
              src={resolved}
              alt={alt ?? ''}
              draggable={false}
              onError={() => setErr({ code: null })}
              onLoad={(event) => {
                const n = event.currentTarget
                if (n.naturalWidth > 0 && n.naturalHeight > 0) {
                  setAspect(n.naturalWidth / n.naturalHeight)
                  // 原图宽记录(2026-08-11:图片初始显示 = 原图,不压缩)
                  setNaturalW(n.naturalWidth)
                }
              }}
            />
            {/* 图片全屏(2026-08-10 用户要求):容器级全屏,与视频同款
                右下角按钮——全屏范围 = Agent 对话窗口(island-agent-mini
                之外,主进程不放大窗口) */}
            <button
              type="button"
              className="island-video-fs"
              aria-label={imgFullscreen ? '退出全屏' : '全屏'}
              onClick={(event) => {
                event.stopPropagation()
                const f = frameRef.current
                if (!f) return
                if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
                else void f.requestFullscreen().catch(() => {})
              }}
            >
              {imgFullscreen ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              )}
            </button>
          </>
        ) : (
          <VideoPlayer
            src={resolved}
            cacheKey={src}
            videoKey={alt}
            autoPlay={autoPlay}
            onAspect={setAspect}
            onError={(code) => setErr({ code })}
            onPlayingChange={(playing) =>
              dispatchAgentMedia('play', {
                kind: 'video',
                src,
                name: alt,
                playing,
                position: lastPosRef.current,
                // 尺寸同步(2026-08-10 小窗尺寸):width state 就是显示宽
                // (style width),上报 1Hz 节流——原 offsetWidth 实时读是
                // 强制 reflow(视频播放期间每上报一次全列表布局校验,
                // 2026-08-11 性能);aspect state 闭包取当前值
                width: width ?? readMediaWindowWidth(),
                aspect: aspect ?? 16 / 9,
              })
            }
            onProgress={(position) => {
              // 节流 ~1Hz:timeupdate 每 ~250ms 触发,1s 粒度足够小窗
              // 续播定位(2026-08-11:播放上报已不触发渲染,见
              // DynamicIsland agentPlaying 改 ref)
              if (Math.round(position) !== lastPosRef.current) {
                lastPosRef.current = Math.round(position)
                dispatchAgentMedia('play', {
                  kind: 'video',
                  src,
                  name: alt,
                  playing: true,
                  position,
                  width: width ?? readMediaWindowWidth(),
                  aspect: aspect ?? 16 / 9,
                })
              }
            }}
          />
        )}
      </div>
      {/* 右下角拖拽手柄:凸出在气泡外,中心贴气泡角点;简约 grip 图标
          (斜线箭头 + 深色圆底),悬浮浮现,拖拽中保持(2026-08-08 修复
          "拖拽功能丢失":原纯透明命中区无可见手柄) */}
      <span
        className="island-media-resize"
        aria-label="拖拽缩放媒体窗口"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true">
          <path d="M21 15v6h-6" />
          <path d="M21 9l-12 12" />
          <path d="M15 21H9" />
          <path d="M21 3l-6 6" />
        </svg>
      </span>
    </div>
  )
}

/** 链接:仅 http(s) 渲染为可点击锚点,其余原样文本(防协议注入) */
function LinkNode({ h, c }: { h: string; c: MdInline[] }) {
  const href = h
  if (!/^https?:\/\//i.test(href)) return <>{renderInlines(c)}</>
  return (
    <a
      href={href}
      className="island-agent-md-link"
      title={href}
      onPointerDown={(event) => {
        if (event.button === 0) event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openExternalUrl(href)
      }}
    >
      {renderInlines(c)}
    </a>
  )
}

/**
 * markdown 内嵌媒体自动播权(2026-08-10 三轮修复"LLM 找歌来听没自动
 * 播放"):LLM 常在回复里用 ![歌名](路径) 内嵌音频/视频(而非工具拦截的
 * media part)——Markdown 组件 mediaAutoPlay 时,**该组件遇到的第一个
 * 音频/视频**获自动播权(图片不占权,无声音),其余保持被动。
 * 模块级布尔:React 渲染同步单线程,组件体渲染前赋值、renderInlines
 * 期间消费,顺序确定;StrictMode 双渲染第二次重新赋值,不泄漏
 */
let mdAutoPlayRemaining = false

function takeMdAutoPlay(): boolean {
  if (mdAutoPlayRemaining) {
    mdAutoPlayRemaining = false
    return true
  }
  return false
}

/** 行内节点 → React 元素(文本全部经 React 转义) */
function renderInlines(inl: MdInline[]): ReactNode[] {
  return inl.map((node, i) => {
    switch (node.t) {
      case 'text':
        return node.s
      case 'br':
        return <br key={i} />
      case 'b':
        return <strong key={i}>{renderInlines(node.c)}</strong>
      case 'i':
        return <em key={i}>{renderInlines(node.c)}</em>
      case 's':
        return <del key={i}>{renderInlines(node.c)}</del>
      case 'code':
        return <code key={i}>{node.s}</code>
      case 'a':
        return <LinkNode key={i} h={node.h} c={node.c} />
      case 'img':
        // 媒体窗口(2026-08-08):Markdown 图片(远程 https / data: / 本地路径)
        return <MediaFrame key={i} kind="img" src={node.s} alt={node.a} />
      case 'video':
        return <MediaFrame key={i} kind="video" src={node.s} alt={node.a} autoPlay={takeMdAutoPlay()} />
      case 'audio':
        return <MediaFrame key={i} kind="audio" src={node.s} alt={node.a} autoPlay={takeMdAutoPlay()} />
    }
  })
}

/** 表格对齐 → 单元格 style */
function alignStyle(a: 'l' | 'c' | 'r' | undefined) {
  if (a === 'c') return { textAlign: 'center' as const }
  if (a === 'r') return { textAlign: 'right' as const }
  return undefined
}

/** 围栏代码块:头部(语言标签 + 复制按钮)+ 代码(超出滚动) */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const label = lang.replace(/[^\w+#-]/g, '').slice(0, 24)
  return (
    <div className="island-agent-code">
      <div className="island-agent-code-head">
        {label && <span className="island-agent-code-lang">{label}</span>}
        <CopyButton text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

/* ============================== Mermaid ============================== */

/** mermaid API 最小类型(避免依赖其完整 d.ts 的形状演进) */
type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

/** 模块级懒加载单例:首次遇到 mermaid 块才下载图表引擎(构建分包) */
let mermaidPromise: Promise<MermaidApi> | null = null
/** 已渲染 SVG 缓存:流式重解析 / 视图来回切换同代码不重复渲染 */
const mermaidSvgCache = new Map<string, string>()
/** 渲染失败的代码:不再重试(避免每次挂载都白跑一次) */
const mermaidFailCache = new Set<string>()
let mermaidSeq = 0

/** 懒加载 mermaid 并做一次性初始化(深色主题匹配岛体) */
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then(async (mod) => {
        const m = mod.default as unknown as MermaidApi
        // 主题色/字体从岛体实时计算样式读取(自定义主题色与字体跟随)
        const island = document.querySelector<HTMLElement>('.island-demo')
        const styles = island ? getComputedStyle(island) : null
        const accent =
          styles?.getPropertyValue('--state-color').trim() || '#4d6bfe'
        m.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: {
            background: 'transparent',
            primaryColor: '#1d2742',
            primaryTextColor: '#e9edf5',
            primaryBorderColor: accent,
            lineColor: '#55607a',
            secondaryColor: '#232c41',
            tertiaryColor: '#161d2e',
            clusterBkg: '#131a28',
            clusterBorder: '#2c3650',
            edgeLabelBackground: '#131a28',
            fontFamily: styles?.fontFamily || `'Segoe UI', system-ui, sans-serif`,
            fontSize: '13px',
          },
        })
        return m
      })
      .catch((err) => {
        mermaidPromise = null // 加载失败可重试
        throw err
      })
  }
  return mermaidPromise
}

/** mermaid 块:懒加载渲染图表,失败回退源码代码块 */
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(() => mermaidSvgCache.get(code) ?? null)
  const [failed, setFailed] = useState(() => mermaidFailCache.has(code))
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    if (failed) return
    const cached = mermaidSvgCache.get(code)
    if (cached) {
      setSvg(cached)
      return
    }
    let cancelled = false
    const id = `md-mermaid-${++mermaidSeq}`
    loadMermaid()
      .then((m) => m.render(id, code))
      .then(({ svg: out }) => {
        if (cancelled || !mountedRef.current) return
        mermaidSvgCache.set(code, out)
        setSvg(out)
      })
      .catch(() => {
        if (cancelled) return
        mermaidFailCache.add(code)
        setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [code, failed])

  useEffect(() => () => void (mountedRef.current = false), [])

  if (failed) {
    return (
      <>
        <div className="island-agent-mermaid-err">图表渲染失败,已显示源码</div>
        <CodeBlock lang="mermaid" code={code} />
      </>
    )
  }
  if (!svg) {
    return <div className="island-agent-mermaid-loading">正在渲染图表…</div>
  }
  return (
    <div
      className="island-agent-mermaid"
      aria-label="Mermaid 图表"
      // mermaid 自身在 securityLevel 'strict' 下已转义标签,产物可信
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/* ============================== 块级渲染 ============================== */

/**
 * 渲染块。trailing:流式光标等尾随节点——块是段落时插到段内行内末尾
 * (光标贴住正在流的文字),其他块型则忽略(光标只属于文本流)
 */
function renderBlock(b: MdBlock, key: number, plainMermaid: boolean, trailing?: ReactNode): ReactNode {
  switch (b.t) {
    case 'p':
      return (
        <p key={key}>
          {renderInlines(b.c)}
          {trailing}
        </p>
      )
    case 'h': {
      const Tag = `h${Math.min(6, Math.max(1, b.l))}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return <Tag key={key}>{renderInlines(b.c)}</Tag>
    }
    case 'ul':
      return (
        <ul key={key}>
          {b.items.map((item, i) => (
            <li key={i}>
              {renderInlines(item.c)}
              {item.sub.length > 0 && <>{item.sub.map((s, j) => renderBlock(s, j, plainMermaid))}</>}
            </li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol key={key} start={b.start}>
          {b.items.map((item, i) => (
            <li key={i}>
              {renderInlines(item.c)}
              {item.sub.length > 0 && <>{item.sub.map((s, j) => renderBlock(s, j, plainMermaid))}</>}
            </li>
          ))}
        </ol>
      )
    case 'q':
      return (
        <blockquote key={key}>
          {b.c.map((s, i) => renderBlock(s, i, plainMermaid))}
        </blockquote>
      )
    case 'code':
      // ```mermaid 渲染图表;plainMermaid(用户气泡)按普通代码块显示
      return b.lang.toLowerCase() === 'mermaid' && !plainMermaid ? (
        <MermaidBlock key={key} code={b.s} />
      ) : (
        <CodeBlock key={key} lang={b.lang} code={b.s} />
      )
    case 'table':
      return (
        <div className="island-agent-table-wrap" key={key}>
          <table>
            <thead>
              <tr>
                {b.header.map((c, i) => (
                  <th key={i} style={alignStyle(b.align[i])}>
                    {renderInlines(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={alignStyle(b.align[ci])}>
                      {renderInlines(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'hr':
      return <hr key={key} />
  }
}

/**
 * Markdown 渲染入口。
 * @param plainMermaid 用户气泡:```mermaid 按普通代码块显示(图表是深色
 *   主题,塞进浅色用户气泡里不可读)
 * @param caret 流式光标:附加在最后一个段落文本末尾(贴住正在流的文字)
 */
export function Markdown({
  text,
  plainMermaid = false,
  caret = false,
  mediaAutoPlay = false,
}: {
  text: string
  plainMermaid?: boolean
  caret?: boolean
  /** 2026-08-10 自动播权:该文本段内第一个音频/视频媒体自动播放
   * (markdown 内嵌 ![歌名](路径) 场景;由 AssistantBlock 分派,只限
   * 当次对话流式落定消息) */
  mediaAutoPlay?: boolean
}) {
  // 渲染前设置模块级播权(组件体同步执行;useMemo 缓存不影响赋值)
  mdAutoPlayRemaining = mediaAutoPlay
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="island-agent-md">
      {blocks.map((b, i) =>
        renderBlock(
          b,
          i,
          plainMermaid,
          caret && i === blocks.length - 1 ? (
            <span className="island-agent-caret" aria-hidden="true" />
          ) : undefined,
        ),
      )}
    </div>
  )
}

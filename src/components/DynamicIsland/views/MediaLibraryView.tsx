import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  genImageId,
  type ImageLibraryItem,
} from '../../../media/backgroundStore'
import {
  genLibraryId,
  type AudioLibraryItem,
  type VideoLibraryItem,
} from '../../../media/libraryStore'
import { inferAudioType } from '../../../media/uploadStore'
import { loadVideoPrefs } from '../../../media/videoPrefs'
import { PanelHead } from './shared'
import { QuickMenu } from './QuickMenu'
import { VideoExtras } from './Markdown'

/** 音频文件大小上限(200MB,与 libraryStore 一致;导入时校验) */
const MAX_AUDIO_BYTES = 200 * 1024 * 1024

/** 音频扩展名(导入文件过滤;File.type 可能为空,扩展名兜底) */
const AUDIO_EXT_RE = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|webm)$/i

/** 音频试听 blob URL 缓存(2026-08-08 修复"导入音频点击播放无响应"):
 * 原实现每次渲染都 URL.createObjectURL 新建 URL → 父组件任何 state
 * 变化(勾选/搜索/试听切换)都让 audio src 换新、播放被中断/重置——
 * 点击播放无响应。按条目 id 缓存,条目移除时 revoke */
const audioBlobUrls = new Map<string, string>()

function blobUrlForAudio(it: AudioLibraryItem): string {
  let url = audioBlobUrls.get(it.id)
  if (!url) {
    url = URL.createObjectURL(new Blob([it.data], { type: it.type }))
    audioBlobUrls.set(it.id, url)
  }
  return url
}

function revokeAudioBlob(id: string): void {
  const url = audioBlobUrls.get(id)
  if (url) {
    audioBlobUrls.delete(id)
    URL.revokeObjectURL(url)
  }
}

/** 库 tab(2026-08-08 复用 QuickMenu 切换,与 Agent 设置菜单同款) */
type MediaLibTab = 'image' | 'audio' | 'video'
const LIB_TABS: MediaLibTab[] = ['image', 'audio', 'video']
const LIB_TAB_LABELS: Record<MediaLibTab, string> = {
  image: '图片',
  audio: '音频',
  video: '视频',
}

/** 库内时间格式 m:ss */
function fmtLibTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 多媒体库视频预览播放器(2026-08-10 用户要求"UI 不要原生要定制,
 * 多媒体库的也要改进"):原 `<video controls>` 原生控件(Chromium 自带
 * 音量/更多)改定制——播放/暂停 + 可拖拽进度条 + 时间 + **音量/更多
 * (VideoExtras,与对话播放器/视频岛双向同步)**;挂载即自动播放
 * (展开点击手势链内);收起暂停由外层 data-preview-id 定位 video
 * (选择器不变)。
 */
function MediaLibVideoPlayer({ path }: { path: string }) {
  const vRef = useRef<HTMLVideoElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(true)
  // current 改 DOM 直写(2026-08-11 性能:原每 ~250ms timeupdate
  // setCurrent 重渲染整个预览播放器,见 renderProgress 注释)
  const [duration, setDuration] = useState(0)
  const scrubbingRef = useRef(false)
  // 应用共享偏好(2026-08-10 双向同步)
  useEffect(() => {
    const v = vRef.current
    if (!v) return
    const p = loadVideoPrefs()
    v.volume = p.volume
    v.muted = p.volume === 0
    v.playbackRate = p.speed
    v.loop = p.loop
    // 挂载即播:展开点击在用户手势链内;LLM play_library_video 跳转路径
    // 无新手势——被自动播放策略拦截时回退播放键态(图标不误显暂停),
    // 2026-08-10
    void v.play().catch(() => setPlaying(false))
  }, [])
  const toggle = () => {
    const v = vRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }
  const seekFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bar = barRef.current
    const v = vRef.current
    if (!bar || !v || !(duration > 0) || !Number.isFinite(duration)) return
    const rect = bar.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    v.currentTime = ratio * duration
    renderProgress()
  }
  // 播放进度 DOM 直写(2026-08-11 性能,与对话播放器/视频岛同款:
  // timeupdate 每 ~250ms,原 setCurrent 每次重渲染整个预览播放器;
  // 直写后播放期间零 React 重渲染,组件重渲染后由下方 effect 同步)
  const renderProgress = (reset = false) => {
    const v = vRef.current
    const bar = barRef.current
    if (!bar) return
    const dur = v ? v.duration || 0 : 0
    const cur = reset ? 0 : v ? v.currentTime || 0 : 0
    const pct = dur > 0 && Number.isFinite(dur) ? Math.min(100, (cur / dur) * 100) : 0
    const fill = bar.querySelector('.island-media-lib-bar-fill') as HTMLElement | null
    const thumb = bar.querySelector('.island-media-lib-bar-thumb') as HTMLElement | null
    if (fill) fill.style.width = `${pct}%`
    if (thumb) thumb.style.left = `${pct}%`
    const timeEl = bar.parentElement?.querySelector('.island-media-lib-time')
    if (timeEl) timeEl.textContent = `${fmtLibTime(cur)} / ${fmtLibTime(dur)}`
    bar.setAttribute('aria-valuenow', String(Math.round(cur)))
  }
  // 每次渲染提交后同步一次真实进度(JSX 静态,重渲染不覆盖直写值)
  useEffect(() => {
    renderProgress()
  })
  return (
    <div className="island-media-lib-player">
      <video
        ref={vRef}
        autoPlay
        src={`island-media://local/${encodeURIComponent(path)}`}
        className="island-media-lib-preview"
        onClick={(event) => {
          event.stopPropagation()
          toggle()
        }}
        onLoadedMetadata={(event) => {
          const d = event.currentTarget.duration
          setDuration(Number.isFinite(d) ? d : 0)
        }}
        onTimeUpdate={() => {
          // 进度 DOM 直写(2026-08-11 性能,见 renderProgress 注释)
          renderProgress()
        }}
        onEnded={() => {
          setPlaying(false)
          // ended 后 currentTime 停在时长,显式归零
          renderProgress(true)
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {/* 定制控件条(替代原生 controls) */}
      <div className="island-media-lib-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className={`island-media-lib-play${playing ? ' is-playing' : ''}`}
          aria-label={playing ? '暂停' : '播放'}
          onClick={(event) => {
            event.stopPropagation()
            toggle()
          }}
        >
          <PlayPauseSwitch />
        </button>
        <div
          ref={barRef}
          className="island-media-lib-bar"
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={0}
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
          }}
          onPointerCancel={() => {
            scrubbingRef.current = false
          }}
        >
          {/* 进度由 renderProgress 直写(JSX 静态,重渲染不覆盖) */}
          <div className="island-media-lib-bar-fill" />
          <span className="island-media-lib-bar-thumb" />
        </div>
        <span className="island-media-lib-time">0:00 / 0:00</span>
        <VideoExtras videoRef={vRef} />
      </div>
    </div>
  )
}

/* ============ 简约 SVG 图标(2026-08-08 用户要求,替代文本符号) ============ */
const ICON = {
  width: 12,
  height: 12,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** 播放三角(实心) */
function PlayIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  )
}

/** 暂停双杠(实心) */
function PauseIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1.5" />
      <rect x="14" y="5" width="4" height="14" rx="1.5" />
    </svg>
  )
}

/**
 * 播放/暂停双态图标(2026-08-09 用户要求"暂停动画像顿挫"):三角与
 * 双杠叠放在按钮内,父元素挂 is-playing 类驱动**同向旋转交叉淡入
 * 淡出**(0.3s 回弹)——点击瞬间图标与内容退场一体联动,替代原
 * 条件渲染硬切。播放条按钮与行内试听/播放按钮共用。
 */
function PlayPauseSwitch() {
  return (
    <>
      <PlayIcon className="island-playpause island-playpause--play" />
      <PauseIcon className="island-playpause island-playpause--pause" />
    </>
  )
}

/** 导入播放列表(列表 + 加号) */
function ListPlusIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <line x1="3" y1="6" x2="15" y2="6" />
      <line x1="3" y1="12" x2="15" y2="12" />
      <line x1="3" y1="18" x2="11" y2="18" />
      <path d="M18 14v6M15 17h6" />
    </svg>
  )
}

/** 编辑名称(铅笔) */
function EditIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}

/** 删除(垃圾桶) */
function TrashIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14h10l1-14" />
    </svg>
  )
}

/** 时间格式 mm:ss */
function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 定制音频播放条(2026-08-08 用户要求"播放条太丑",替代原生 audio
 * controls):圆形播放/暂停键 + 可点击/拖动 seek 的进度条 + 时间。
 * 多媒体库音频试听用;对话内音频已改语音气泡(VoiceBubble)。
 * autoPlay = 挂载即播(2026-08-08 用户要求"点击播放键应该立即播放",
 * 不需要再手动点播放条;展开手势链内 autoplay 允许)
 */
function AudioPlayBar({ src, autoPlay = false }: { src: string; autoPlay?: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  // current 改 DOM 直写(2026-08-11 性能:原每 ~250ms timeupdate
  // setCurrent 重渲染整个播放条,见 renderProgress 注释)
  const [err, setErr] = useState(false)
  const scrubbingRef = useRef(false)
  // 挂载即播(展开手势链内;失败保留错误提示——播放失败会显示)
  useEffect(() => {
    if (!autoPlay) return
    const a = audioRef.current
    if (a) void a.play().catch(() => setErr(true))
  }, [autoPlay])
  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (playing) a.pause()
    else void a.play().catch(() => setErr(true))
  }
  const seekFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bar = trackRef.current
    const a = audioRef.current
    if (!bar || !a || duration <= 0) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    a.currentTime = ratio * duration
    renderProgress()
  }
  // 播放进度 DOM 直写(2026-08-11 性能,与视频播放器同款:
  // timeupdate 每 ~250ms,原 setCurrent 每次重渲染整个播放条)
  const renderProgress = (reset = false) => {
    const a = audioRef.current
    const track = trackRef.current
    if (!track) return
    const dur = a ? a.duration || 0 : 0
    const cur = reset ? 0 : a ? a.currentTime || 0 : 0
    const pct = dur > 0 && Number.isFinite(dur) ? Math.min(100, (cur / dur) * 100) : 0
    const fill = track.querySelector('.island-media-playbar-fill') as HTMLElement | null
    const thumb = track.querySelector('.island-media-playbar-thumb') as HTMLElement | null
    if (fill) fill.style.width = `${pct}%`
    if (thumb) thumb.style.left = `${pct}%`
    const timeEl = track.parentElement?.querySelector('.island-media-playbar-time')
    if (timeEl) timeEl.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`
    track.setAttribute('aria-valuenow', String(Math.round(cur)))
  }
  // 每次渲染提交后同步一次真实进度(JSX 静态,重渲染不覆盖直写值)
  useEffect(() => {
    renderProgress()
  })
  if (err) return <div className="island-agent-media-err">无法播放该音频</div>
  return (
    <div className="island-media-playbar">
      <button
        type="button"
        className={`island-media-playbar-btn${playing ? ' is-playing' : ''}`}
        aria-label={playing ? '暂停' : '播放'}
        onClick={(event) => {
          event.stopPropagation()
          toggle()
        }}
      >
        <PlayPauseSwitch />
      </button>
      <div
        ref={trackRef}
        className="island-media-playbar-track"
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={0}
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
        }}
        onPointerCancel={() => {
          scrubbingRef.current = false
        }}
      >
        {/* 进度由 renderProgress 直写(JSX 静态,重渲染不覆盖) */}
        <div className="island-media-playbar-fill" />
        <span className="island-media-playbar-thumb" aria-hidden="true" />
      </div>
      <span className="island-media-playbar-time">0:00 / 0:00</span>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onError={() => setErr(true)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={() => {
          // 进度 DOM 直写(2026-08-11 性能,见 renderProgress 注释)
          renderProgress()
        }}
        onEnded={() => {
          setPlaying(false)
          // ended 后 currentTime 停在时长,显式归零
          renderProgress(true)
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
    </div>
  )
}

/** 图片右键菜单(2026-08-08 用户要求):应用到紧凑态/展开态背景,
 *  点击直接导入对应背景槽位并跳转背景编辑器(省略导入步骤)。
 *  menuRef:点外关闭判定(菜单内部点击不关——document pointerdown
 *  close 若先清掉 ctxMenu,按钮 click 时读到 null,应用不生效,
 *  2026-08-08 修复"点击应用后没有跳转")。
 *  **absolute 定位在面板内(2026-08-08 修复"菜单看不见")**:原 fixed
 *  定位在岛体带 transform(悬停上浮 translateY)时包含块变成岛体,
 *  视口坐标被当相对岛体坐标 → 菜单错位到岛体边缘,overflow:hidden
 *  裁剪 = 右键"没反应"(元素存在但不可见,巡检 menu:true 是假阳性)。
 *  坐标 = 卡片相对面板的偏移(随岛体移动,永不被裁剪) */
function ImageCtxMenu({
  x,
  y,
  onPick,
  menuRef,
}: {
  x: number
  y: number
  onPick: (target: 'expanded' | 'compact') => void
  menuRef: RefObject<HTMLDivElement | null>
}) {
  // 钳制在面板内(菜单约 150×90;防溢出右侧/底部)
  const left = Math.min(x, (menuRef.current?.offsetParent?.clientWidth ?? 400) - 170)
  const top = Math.min(y, (menuRef.current?.offsetParent?.clientHeight ?? 540) - 100)
  return (
    <div ref={menuRef} className="island-ctx-menu" style={{ left, top } as CSSProperties}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onPick('expanded')
        }}
      >
        应用到展开态背景
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onPick('compact')
        }}
      >
        应用到紧凑态背景
      </button>
      <span className="island-ctx-menu-hint">导入后自动跳转背景编辑器调整</span>
    </div>
  )
}

/** 多媒体库面板(2026-08-08,独立菜单:托盘/Agent 菜单呼出,设置入口
 * 已移除——不属设置范畴,Agent 设置面板大小):
 * 图片(复用 island-background 库,右键可应用到背景)/ 音频(ArrayBuffer
 * 全量 + 定制播放条)/ 视频(路径引用 + 展开播放动画);增删改查;
 * 音频可单个/批量导入播放列表。大面板(540px) */
export function MediaLibraryView({
  imageLibrary,
  onImageLibraryChange,
  audioLibrary,
  onAudioLibraryChange,
  videoLibrary,
  onVideoLibraryChange,
  onAddToPlaylist,
  onVideoImport,
  /** 图片右键"应用到背景":导入对应槽位后跳转背景编辑器
   * (宿主组装背景参数并切视图;省略手动导入步骤) */
  onApplyImageToBackground,
  onBack,
  autoPlayVideoId,
  onAutoPlayConsumed,
}: {
  imageLibrary?: ImageLibraryItem[]
  onImageLibraryChange?: (items: ImageLibraryItem[]) => void
  audioLibrary: AudioLibraryItem[]
  onAudioLibraryChange: (items: AudioLibraryItem[]) => void
  videoLibrary: VideoLibraryItem[]
  onVideoLibraryChange: (items: VideoLibraryItem[]) => void
  /** 把音频库条目加入播放列表(单个/批量;自动播放第一首) */
  onAddToPlaylist: (items: AudioLibraryItem[]) => void
  /** 视频导入(宿主弹系统对话框选文件 → 记录路径入库;浏览器 File
   * 无绝对路径,视频库是路径引用,必须走宿主) */
  onVideoImport?: () => void
  onApplyImageToBackground?: (target: 'expanded' | 'compact', dataUrl: string) => void
  onBack: () => void
  /** LLM 工具 play_library_video(2026-08-10):定位播放指定视频 id——
   * 切到视频 tab 并自动展开播放该行 */
  autoPlayVideoId?: string | null
  /** 播放请求已消费(宿主把 id 清回 null,下次打开面板不重复触发) */
  onAutoPlayConsumed?: () => void
}) {
  const [tab, setTab] = useState<MediaLibTab>('audio')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // 音频试听(行内展开播放条)/ 视频播放(行内展开 video,island-media 流式)
  const [previewId, setPreviewId] = useState<string | null>(null)
  // 收起延迟卸载(2026-08-08 用户要求"视频收起动画"):收起时若内容
  // 立即卸载,grid-rows 1fr→0fr 过渡没有内容可缩 → 高度瞬变无动画。
  // closingId 期间保留内容播完 0.32s 过渡再真正卸载(展开/收起对称)
  const [closingId, setClosingId] = useState<string | null>(null)
  const previewTimerRef = useRef(0)
  const showPreview = (id: string) => previewId === id || closingId === id
  // 展开高度(px,2026-08-09 三轮修复"收起还是瞬间关闭"):收起瞬间
  // previewId 置 null 但 closingId 保留内容播动画——此前 `.open` 类
  // 由 showPreview 判定(closing 期间仍 true)→ 类始终不移除 → grid
  // 行高恒 1fr 纹丝不动,closing 结束内容卸载才瞬间归零(实测帧采样
  // h 恒 154 → 800ms 跳 0)。修复:类与高度都由 previewId(真正展开)
  // 判定,closing 期间内容保留但高度已过渡到 0;高度改**显式 px**
  // 过渡(浏览器必支持,替代 grid-template-rows),ResizeObserver
  // 跟随内容(视频元数据到达后高度变化也平滑跟随)
  const [previewHeights, setPreviewHeights] = useState<Record<string, number>>({})
  const previewInnerRefs = useRef(new Map<string, HTMLDivElement>())
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLDivElement
        const id = el.dataset.pid
        if (!id) continue
        const h = el.scrollHeight
        setPreviewHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }))
      }
    })
    const refs = previewInnerRefs.current
    for (const el of refs.values()) ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 展开行变化时重跑(refs 是渲染期注册的 map)
  }, [previewId, closingId])
  const togglePreview = (id: string) => {
    window.clearTimeout(previewTimerRef.current)
    if (previewId === id || closingId === id) {
      // 收起:先暂停播放(声音立即停),**video 立即卸载**(不再保留
      // 画面播收缩动画——video 参与 grid 动画时软件渲染每帧重绘
      // 大视频帧,收起卡顿,2026-08-08 重新设计;行容器保留 closing
      // 状态播 0.32s 轻量高度收缩);音频元素轻,保留延迟卸载
      const row = panelRef.current?.querySelector<HTMLElement>(`[data-preview-id="${id}"]`)
      const v = row?.querySelector('video')
      if (v) v.pause()
      const a = row?.querySelector('audio')
      if (a) a.pause()
      setPreviewId(null)
      setClosingId(id)
      // 卸载延时 = 再次放慢后的收起动画时长(0.7s + 余量,2026-08-08
      // 用户两轮反馈"动画速率太快"后同步)
      previewTimerRef.current = window.setTimeout(() => {
        setClosingId(null)
      }, 730)
    } else {
      setClosingId(null)
      setPreviewId(id)
      // 收起动画期间(closingId 窗口)内容仍在 DOM——直接恢复播放,
      // 不依赖重挂载 autoPlay(初次展开 DOM 未更新查不到,autoPlay
      // 兜底)。2026-08-09 随"video 保留淡出"加入:此前 video 收起
      // 立即卸载,重开 = 重挂载自动播;现在画面保留,必须手动续播
      const row = panelRef.current?.querySelector<HTMLElement>(`[data-preview-id="${id}"]`)
      const media = row?.querySelector<HTMLMediaElement>('video, audio')
      if (media) void media.play().catch(() => {})
    }
  }
  // LLM 工具 play_library_video(2026-08-10):定位播放指定视频——切到
  // 视频 tab + 清搜索(该行被过滤掉会找不到),内容挂载后展开该行并
  // 自动播放;消费后通知宿主清回 null(下次打开面板不重复触发)。
  // setTimeout 等 tab 内容 commit 后 togglePreview 才能查到行
  useEffect(() => {
    if (!autoPlayVideoId) return
    setTab('video')
    setSearch('')
    const t = window.setTimeout(() => {
      togglePreview(autoPlayVideoId)
      onAutoPlayConsumed?.()
    }, 120)
    return () => {
      window.clearTimeout(t)
      // 面板在 120ms 前被收起/切走:播放请求作废,消费掉 id——
      // 否则下次打开多媒体库(托盘)会意外触发该视频播放
      onAutoPlayConsumed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 autoPlayVideoId 变化时触发
  }, [autoPlayVideoId])
  // 音频批量勾选导入播放列表
  const [selectedAudio, setSelectedAudio] = useState<Set<string>>(new Set())
  const audioInputRef = useRef<HTMLInputElement>(null)
  // 图片右键菜单(2026-08-08:应用到展开态/紧凑态背景)。
  // 坐标 = 相对面板(absolute 定位,随岛体移动不被裁剪——fixed 会
  // 被岛体 transform 祖先错位,见 ImageCtxMenu 注释)
  const [ctxMenu, setCtxMenu] = useState<{ img: ImageLibraryItem; x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // 编辑保存反馈:保存完成的条目短暂显示绿色对勾(600ms 后消失)
  const [savedId, setSavedId] = useState<string | null>(null)
  const savedTimerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(savedTimerRef.current), [])
  // 卸载清理收起延迟定时器(收起动画未完成即卸载不残留)
  useEffect(() => () => window.clearTimeout(previewTimerRef.current), [])

  const q = search.trim().toLowerCase()
  const filter = <T extends { name: string }>(items: T[]): T[] =>
    q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items
  const filteredImages = filter(imageLibrary ?? [])
  const filteredAudio = filter(audioLibrary)
  const filteredVideo = filter(videoLibrary)

  // 右键菜单点外关闭(面板滚动/点击任何位置);**菜单内部点击不关**
  // ——document pointerdown close 若先清掉 ctxMenu,按钮 click 读不到
  // 状态,应用不生效(2026-08-08 修复"点击应用后没有跳转")
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ctxMenu) return
    const close = (event: globalThis.PointerEvent) => {
      if (ctxMenuRef.current && ctxMenuRef.current.contains(event.target as Node)) return
      setCtxMenu(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [ctxMenu])

  const startRename = (id: string, name: string) => {
    setEditingId(id)
    setRenameDraft(name)
  }
  /** 提交改名:显示 ✓ 反馈(回弹浮出,600ms 后消失),名称行恢复 */
  const commitRename = () => {
    const id = editingId
    const name = renameDraft.trim()
    setEditingId(null)
    if (!id || !name) return
    if (tab === 'image' && onImageLibraryChange) {
      onImageLibraryChange((imageLibrary ?? []).map((img) => (img.id === id ? { ...img, name } : img)))
    } else if (tab === 'audio') {
      onAudioLibraryChange(audioLibrary.map((it) => (it.id === id ? { ...it, name } : it)))
    } else {
      onVideoLibraryChange(videoLibrary.map((it) => (it.id === id ? { ...it, name } : it)))
    }
    setSavedId(id)
    window.clearTimeout(savedTimerRef.current)
    savedTimerRef.current = window.setTimeout(() => setSavedId(null), 600)
  }
  const removeItem = (id: string) => {
    if (tab === 'image' && onImageLibraryChange) {
      onImageLibraryChange((imageLibrary ?? []).filter((img) => img.id !== id))
    } else if (tab === 'audio') {
      setSelectedAudio((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      onAudioLibraryChange(audioLibrary.filter((it) => it.id !== id))
      // 释放试听 blob URL(缓存条目移除时 revoke,防泄漏)
      revokeAudioBlob(id)
    } else {
      onVideoLibraryChange(videoLibrary.filter((it) => it.id !== id))
    }
  }

  // 音频导入(文件 → ArrayBuffer 入库;≥200MB 拒绝)。**type 用扩展名
  // 兜底**(File.type 常为空,空 type 的 Blob 音频无法播放 = 导入音频
  // 无法播放 Bug 的根因,2026-08-08 修复)
  const handleAudioImport = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) return
    void Promise.all(
      files
        .filter((f) => f.type.startsWith('audio/') || AUDIO_EXT_RE.test(f.name))
        .map(async (f) => {
          if (f.size > MAX_AUDIO_BYTES) return null
          return {
            id: genLibraryId('audio'),
            name: f.name.slice(0, 100),
            type: inferAudioType(f.name, f.type),
            data: await f.arrayBuffer(),
            createdAt: Date.now(),
          } as AudioLibraryItem
        }),
    ).then((items) => {
      const added = items.filter((it): it is AudioLibraryItem => it !== null)
      if (added.length === 0) return
      onAudioLibraryChange([...audioLibrary, ...added])
    })
  }
  // 批量导入播放列表(勾选的音频)
  const addSelectedToPlaylist = () => {
    const items = audioLibrary.filter((it) => selectedAudio.has(it.id))
    if (items.length > 0) {
      onAddToPlaylist(items)
      setSelectedAudio(new Set())
    }
  }
  const toggleSelect = (id: string) => {
    setSelectedAudio((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // 库 tab 切换(QuickMenu,2026-08-08):切换时清掉行内编辑与试听/播放。
  // **内容切换动画(2026-08-10 用户要求"下方内容布局切换动画")**:
  // 交叉时序(与 Agent 设置菜单同款)——离场(0.24s)播 50%(0.12s)
  // 即重挂载新 tab 内容,入场(0.34s 回弹)与离场尾部重叠,旧内容上移
  // 淡出中新内容下移淡入;leaving 期间忽略重复切换
  const [tabLeaving, setTabLeaving] = useState(false)
  const [tabAnimSeq, setTabAnimSeq] = useState(0)
  const tabLeavingRef = useRef(false)
  const switchTab = (next: MediaLibTab) => {
    if (next === tab || tabLeavingRef.current) return
    tabLeavingRef.current = true
    setTabLeaving(true)
    setEditingId(null)
    setPreviewId(null)
    setClosingId(null)
    setCtxMenu(null)
    window.clearTimeout(previewTimerRef.current)
    window.setTimeout(() => {
      tabLeavingRef.current = false
      setTabLeaving(false)
      setTab(next)
      setTabAnimSeq((s) => s + 1)
    }, 120)
  }
  const tabCounts: Record<MediaLibTab, number> = {
    image: imageLibrary?.length ?? 0,
    audio: audioLibrary.length,
    video: videoLibrary.length,
  }
  const tabLabel = (t: MediaLibTab) => `${LIB_TAB_LABELS[t]}(${tabCounts[t]})`
  // 图片右键应用:直接导入对应背景槽位 + 跳转背景编辑器(宿主组装)
  const applyImageToBackground = (target: 'expanded' | 'compact') => {
    if (ctxMenu && onApplyImageToBackground) onApplyImageToBackground(target, ctxMenu.img.dataUrl)
    setCtxMenu(null)
  }

  return (
    <div ref={panelRef} className="island-panel-list island-lib-view">
      <PanelHead title="多媒体库" count={`${tabCounts[tab]} 项`} />
      {/* 库类型切换:通用 QuickMenu(整合按钮 + 同行联通展开 + 滚轮逐格
          循环切换 + 高亮滑块 + 宽度过渡,与 Agent 设置菜单同款设计) */}
      <QuickMenu
        items={LIB_TABS}
        value={tab}
        onChange={switchTab}
        getLabel={tabLabel}
        title="库类型(滚轮切换)"
        className="island-media-lib-menu"
        wheelWhenOpen
      />
      <input
        type="text"
        className="island-lib-search"
        placeholder={`搜索${tab === 'image' ? '图片' : tab === 'audio' ? '音频' : '视频'}名称…`}
        value={search}
        onChange={(event) => {
          event.stopPropagation()
          setSearch(event.target.value)
        }}
      />

      {/* 内容区(2026-08-10 用户要求 tab 切换动画):key=tabAnimSeq
          重挂载重放入场(island-ui-in 回弹淡入),leaving 时旧内容挂
          island-ui-out(上移淡出 0.24s)播 120ms 后切新 tab */}
      <div
        key={tabAnimSeq}
        className={`island-media-lib-content${tabLeaving ? ' island-ui-out' : ''}`}
      >
      {/* 图片 tab:缩略图网格(与应用背景的图片库同源);右键 → 应用背景 */}
      {tab === 'image' && (
        <ul className="island-lib-grid">
          {filteredImages.length === 0 && (
            <li className="island-track-empty">{search.trim() ? '没有匹配的图片' : '暂无图片,点击下方上传'}</li>
          )}
          {filteredImages.map((img) => (
            <li
              key={img.id}
              className={`island-lib-card${editingId === img.id ? ' editing' : ''}${savedId === img.id ? ' saved' : ''}`}
              onContextMenu={(event) => {
                // 右键菜单:应用到紧凑态/展开态背景(默认菜单屏蔽)。
                // 坐标转相对面板(absolute 定位不被岛体 transform 影响)
                event.preventDefault()
                event.stopPropagation()
                const panel = panelRef.current
                const pr = panel ? panel.getBoundingClientRect() : null
                setCtxMenu({
                  img,
                  x: pr ? event.clientX - pr.left : event.clientX,
                  y: pr ? event.clientY - pr.top : event.clientY,
                })
              }}
            >
              {editingId === img.id ? (
                <input
                  type="text"
                  className="island-lib-edit-input island-lib-edit-input--card island-ui-enter"
                  value={renameDraft}
                  autoFocus
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation()
                    setRenameDraft(event.target.value)
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') commitRename()
                    if (event.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={commitRename}
                />
              ) : (
                <>
                  <span className="island-lib-card-main">
                    <span
                      className="island-lib-card-thumb"
                      style={{ backgroundImage: `url("${img.dataUrl}")` }}
                      aria-hidden="true"
                    />
                    <span className={`island-lib-card-name${savedId === img.id ? ' island-ui-enter' : ''}`}>
                      {img.name}
                    </span>
                  </span>
                  <span className="island-lib-card-acts">
                    <button
                      type="button"
                      className="island-lib-row-act"
                      title="编辑名称"
                      onClick={(event) => {
                        event.stopPropagation()
                        startRename(img.id, img.name)
                      }}
                    >
                      <EditIcon />
                    </button>
                    <button
                      type="button"
                      className="island-lib-row-act island-lib-row-del"
                      title="删除"
                      onClick={(event) => {
                        event.stopPropagation()
                        removeItem(img.id)
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 音频 tab:列表 + 定制播放条 + 批量导入播放列表 */}
      {tab === 'audio' && (
        <div className="island-media-lib-list">
          {filteredAudio.length === 0 && (
            <div className="island-track-empty">{search.trim() ? '没有匹配的音频' : '暂无音频,点击下方导入'}</div>
          )}
          {filteredAudio.map((it) => (
            <div
              key={it.id}
              data-preview-id={it.id}
              className={`island-media-lib-row${editingId === it.id ? ' editing' : ''}${savedId === it.id ? ' saved' : ''}`}
            >
              {/* 勾选框(2026-08-08 定制:打勾描线动画 + 背景填充过渡,
                  原生 checkbox 无动画;input 隐藏,视觉框 + 对勾 SVG) */}
              <label className={`island-media-lib-check${selectedAudio.has(it.id) ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={selectedAudio.has(it.id)}
                  onChange={() => toggleSelect(it.id)}
                  onClick={(event) => event.stopPropagation()}
                />
                <span className="island-media-lib-checkbox" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
              </label>
              {editingId === it.id ? (
                <input
                  type="text"
                  className="island-lib-edit-input island-ui-enter"
                  value={renameDraft}
                  autoFocus
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation()
                    setRenameDraft(event.target.value)
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') commitRename()
                    if (event.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={commitRename}
                />
              ) : (
                // 编辑关闭后名称淡入(savedId 期间重放 island-ui-in;
                // 取消编辑(Esc)直接恢复不播动画)
                <span
                  className={`island-media-lib-name${savedId === it.id ? ' island-ui-enter' : ''}`}
                  title={it.name}
                >
                  {it.name}
                </span>
              )}
              <span className="island-media-lib-acts">
                <button
                  type="button"
                  className={`island-lib-row-act${previewId === it.id ? ' is-playing' : ''}`}
                  title={previewId === it.id ? '收起试听' : '试听'}
                  onClick={(event) => {
                    event.stopPropagation()
                    togglePreview(it.id)
                  }}
                >
                  {/* 图标态由 previewId 判断(2026-08-08 修复"暂停了一会
                      图标才变"):closing 期间容器播收起动画但 previewId
                      已置 null,图标立即切换;2026-08-09 起经
                      PlayPauseSwitch 交叉动画过渡,不再是硬切 */}
                  <PlayPauseSwitch />
                </button>
                <button
                  type="button"
                  className="island-lib-row-act"
                  title="导入播放列表"
                  onClick={(event) => {
                    event.stopPropagation()
                    onAddToPlaylist([it])
                  }}
                >
                  <ListPlusIcon />
                </button>
                <button
                  type="button"
                  className="island-lib-row-act"
                  title="编辑名称"
                  onClick={(event) => {
                    event.stopPropagation()
                    startRename(it.id, it.name)
                  }}
                >
                  <EditIcon />
                </button>
                <button
                  type="button"
                  className="island-lib-row-act island-lib-row-del"
                  title="删除"
                  onClick={(event) => {
                    event.stopPropagation()
                    removeItem(it.id)
                  }}
                >
                  <TrashIcon />
                </button>
              </span>
              {/* 试听展开/收起:显式高度过渡 + 内容淡入(2026-08-09 三轮
                  修复:grid-rows 过渡的 .open 类曾由 showPreview 判定,
                  closing 期间不移除 → 行高恒 1fr 纹丝不动,closing 结束
                  才瞬间归零。现在类/高度都由 previewId 判定——收起
                  瞬间高度开始过渡,内容由 closingId 保留播动画) */}
              <div
                className={`island-media-preview${previewId === it.id ? ' open' : ''}`}
                style={{ height: previewId === it.id ? `${previewHeights[it.id] ?? 0}px` : '0px' }}
              >
                <div
                  ref={(el) => {
                    if (el) previewInnerRefs.current.set(it.id, el)
                    else previewInnerRefs.current.delete(it.id)
                  }}
                  data-pid={it.id}
                  className="island-media-preview-inner"
                >
                  {showPreview(it.id) && <AudioPlayBar src={blobUrlForAudio(it)} autoPlay />}
                </div>
              </div>
            </div>
          ))}
          {filteredAudio.length > 0 && (
            <div className="island-media-lib-batch">
              <span>已选 {selectedAudio.size} 首</span>
              <button
                type="button"
                className="island-ctl island-ctl--upload"
                disabled={selectedAudio.size === 0}
                onClick={(event) => {
                  event.stopPropagation()
                  addSelectedToPlaylist()
                }}
              >
                批量导入播放列表
              </button>
            </div>
          )}
        </div>
      )}

      {/* 视频 tab:列表 + 岛内流式播放(island-media://),展开/收起动画 */}
      {tab === 'video' && (
        <div className="island-media-lib-list">
          {filteredVideo.length === 0 && (
            <div className="island-track-empty">{search.trim() ? '没有匹配的视频' : '暂无视频,点击下方导入'}</div>
          )}
          {filteredVideo.map((it) => (
            <div
              key={it.id}
              data-preview-id={it.id}
              className={`island-media-lib-row${editingId === it.id ? ' editing' : ''}${savedId === it.id ? ' saved' : ''}`}
            >
              {editingId === it.id ? (
                <input
                  type="text"
                  className="island-lib-edit-input island-ui-enter"
                  value={renameDraft}
                  autoFocus
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation()
                    setRenameDraft(event.target.value)
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') commitRename()
                    if (event.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={commitRename}
                />
              ) : (
                // 编辑关闭后名称淡入(与音频行同款)
                <span
                  className={`island-media-lib-name${savedId === it.id ? ' island-ui-enter' : ''}`}
                  title={it.path}
                >
                  {it.name}
                </span>
              )}
              <span className="island-media-lib-size">{(it.size / 1024 / 1024).toFixed(1)}MB</span>
              <span className="island-media-lib-acts">
                <button
                  type="button"
                  className={`island-lib-row-act${previewId === it.id ? ' is-playing' : ''}`}
                  title={previewId === it.id ? '收起播放' : '播放'}
                  onClick={(event) => {
                    event.stopPropagation()
                    togglePreview(it.id)
                  }}
                >
                  {/* 图标态由 previewId 判断(同音频行:收起瞬间立即切换;
                      2026-08-09 起交叉动画过渡) */}
                  <PlayPauseSwitch />
                </button>
                <button
                  type="button"
                  className="island-lib-row-act"
                  title="编辑名称"
                  onClick={(event) => {
                    event.stopPropagation()
                    startRename(it.id, it.name)
                  }}
                >
                  <EditIcon />
                </button>
                <button
                  type="button"
                  className="island-lib-row-act island-lib-row-del"
                  title="删除"
                  onClick={(event) => {
                    event.stopPropagation()
                    removeItem(it.id)
                  }}
                >
                  <TrashIcon />
                </button>
              </span>
              {/* 播放展开/收起:grid-rows 0fr↔1fr 高度过渡 + video 淡入;
                  **收起时 video 保留到 closing 结束(2026-08-09 重新设计,
                  替换 2026-08-08 的"立即卸载")**:立即卸载让画面"啪"地
                  消失、只剩空容器收缩——顿挫主因。暂停后画面是静止帧,
                  重绘成本远低于播放中(当初卡顿的前提),内容随 inner
                  淡出上移 + 自身轻微缩放收进卡片(0.55s),画面消失与
                  高度收缩一体;closing 结束后卸载。收起动画期间快速
                  重开 = 画面仍在,由 togglePreview 手动续播(不重挂)。
                  autoPlay:初次展开点击 ▶ 立即播放(手势链内允许) */}
              <div
                className={`island-media-preview island-media-preview--video${previewId === it.id ? ' open' : ''}`}
                style={{ height: previewId === it.id ? `${previewHeights[it.id] ?? 0}px` : '0px' }}
              >
                <div
                  ref={(el) => {
                    if (el) previewInnerRefs.current.set(it.id, el)
                    else previewInnerRefs.current.delete(it.id)
                  }}
                  data-pid={it.id}
                  className="island-media-preview-inner"
                >
                  {showPreview(it.id) && (
                    // 定制播放器(2026-08-10 用户要求:替代原生 controls,
                    // 音量/更多与对话播放器/视频岛双向同步)
                    <MediaLibVideoPlayer key={it.id} path={it.path} />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      <div className="island-lib-foot">
        {tab === 'image' && (
          <button
            type="button"
            className="island-ctl island-ctl--upload"
            onClick={(event) => {
              event.stopPropagation()
              if (onImageLibraryChange && imageLibrary) {
                // 图片上传复用现有图片库上传(降采样入库)
                const input = document.createElement('input')
                input.type = 'file'
                input.accept = 'image/*'
                input.onchange = () => {
                  const f = input.files?.[0]
                  if (!f) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    if (typeof reader.result !== 'string') return
                    // 降采样复用背景库工具(长边 ≤1024,防大图卡顿)
                    void import('../../../media/backgroundStore').then(({ downscaleBackgroundImage }) =>
                      downscaleBackgroundImage(reader.result as string).then((small) => {
                        onImageLibraryChange([
                          ...imageLibrary,
                          { id: genImageId(), name: f.name.replace(/\.[^.]+$/, ''), dataUrl: small, createdAt: Date.now() },
                        ])
                      }),
                    )
                  }
                  reader.readAsDataURL(f)
                }
                input.click()
              }
            }}
          >
            ＋ 上传图片
          </button>
        )}
        {tab === 'audio' && (
          <button
            type="button"
            className="island-ctl island-ctl--upload"
            onClick={(event) => {
              event.stopPropagation()
              audioInputRef.current?.click()
            }}
          >
            ＋ 导入音频
          </button>
        )}
        {tab === 'video' && (
          <button
            type="button"
            className="island-ctl island-ctl--upload"
            onClick={(event) => {
              event.stopPropagation()
              onVideoImport?.()
            }}
          >
            ＋ 导入视频
          </button>
        )}
        <button
          type="button"
          className="island-ctl island-ctl--back"
          onClick={(event) => {
            event.stopPropagation()
            onBack()
          }}
        >
          ‹ 返回
        </button>
      </div>
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onClick={(event) => event.stopPropagation()}
        onChange={handleAudioImport}
      />
      {/* 图片右键菜单(应用到展开态/紧凑态背景);menuRef 供点外关闭判定 */}
      {ctxMenu && (
        <ImageCtxMenu x={ctxMenu.x} y={ctxMenu.y} onPick={applyImageToBackground} menuRef={ctxMenuRef} />
      )}
    </div>
  )
}

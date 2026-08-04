import { useCallback, useEffect, useRef, useState } from 'react'
import { recognizePlatform, type SystemPlatform } from '../media/systemPlatforms'
import type { PlaybackMode } from '../media/playbackModes'

/** 本地桥接服务地址(scripts/system-media-bridge.ts 提供) */
const BRIDGE_BASE = 'http://127.0.0.1:8765/system-media'
/** 状态轮询间隔(ms):校准系统进度 */
const POLL_MS = 1000
/** 单次请求超时(ms):未启动桥接时快速失败 */
const REQUEST_TIMEOUT_MS = 800
/** 本地进度插值步进(ms):轮询间隙平滑推进播放进度 */
const TICK_MS = 250
/** SMTC 位置严重偏离阈值(秒):显示进度 = 锚定基准 + 本地时钟流逝,
 *  常规轮询不跟随上报位置(浏览器等平台的位置会抖动或阶梯式过期——
 *  冻结数秒后突然跳变,跟随会让进度条抽搐或周期性回跳)。仅在偏离超过
 *  本阈值**且**上报位置大幅移动(见 POSITION_ALIVE_MOVE_SEC)时重锚定:
 *  同时满足才可能是真实跳变(外部 seek/重播);浏览器阶梯上报在冻结期
 *  移动≈0、更新瞬间偏差≈0,永远不满足 */
const POSITION_DIVERGENCE_LIMIT_SEC = 5
/** 上报位置"活着"判定(秒):距上次轮询移动超过该值才视为真实跳变,
 *  用于区分可靠上报(原生客户端每次轮询前进 ~1s,seek 时移动数十秒)
 *  与不可靠上报(浏览器冻结期移动≈0) */
const POSITION_ALIVE_MOVE_SEC = 2
/** seek 验证容差(秒):seek 后系统位置与目标距离 ≤ 该值视为已生效 */
const SEEK_VERIFY_TOLERANCE_SEC = 3
/** seek 验证跳变判定(秒):系统位置单次轮询移动超过该值视为位置确实
 *  跳转——覆盖浏览器等阶梯式更新平台(位置以粗粒度块状前进,可能
 *  永远不落在目标 ±3s 内,但跳变本身证明 seek 已生效) */
const SEEK_VERIFY_JUMP_SEC = 5
/** seek 验证时限(ms):超时未跟随视为客户端"接受"但实际未跳转
 *  (如 QQ音乐),回退显示并判定该平台不支持跳转。仅在平台首次验证时
 *  等待(结果按平台持久化,之后直接按记忆处理) */
const SEEK_VERIFY_LIMIT_MS = 8000
/** seek 支持记忆持久化键:按 sourceAppId 记录平台是否真的跟随进度跳转 */
const SEEK_SUPPORT_STORAGE_KEY = 'island-seek-support'

/** 读取持久化的平台 seek 支持记忆(键 = sourceAppId) */
function loadSeekSupport(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SEEK_SUPPORT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, boolean>
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch {
    // 忽略存储失败
  }
  return {}
}

export interface SystemTrackInfo {
  title: string
  artist: string
  album?: string
}

export type SystemControlAction =
  | 'previous'
  | 'play'
  | 'pause'
  | 'next'
  | 'seek'
  | 'repeat-one'
  | 'repeat-all'
  | 'shuffle'
  | 'shuffle-off'

export interface SystemMediaState {
  /** 桥接是否连通且存在活跃的系统媒体会话 */
  active: boolean
  platform: SystemPlatform
  track: SystemTrackInfo | null
  isPlaying: boolean
  position: number
  duration: number
  /** 客户端是否支持播放模式读写(PlaybackInfo 可用);
   *  QQ音乐等不暴露状态的客户端为 false,前端禁用模式按钮 */
  modeSupported: boolean
  /** 系统真实播放模式(从 SMTC PlaybackInfo 读取;客户端不写入时为 sequence;
   *  repeat-all 由宿主映射为前端三态) */
  mode: PlaybackMode
  /** 向系统媒体发送控制指令(上一首/播放暂停/下一首/跳转进度);
   *  返回客户端是否接受该控制(true/false,不可判定时为 undefined) */
  control(action: SystemControlAction, position?: number): Promise<boolean | undefined>
}

interface BridgeStateMessage {
  sourceAppId?: string | null
  track?: { title?: string; artist?: string; album?: string } | null
  isPlaying?: boolean
  position?: number
  duration?: number
  modeSupported?: boolean
  playbackMode?: string
}

/**
 * 系统媒体监听:轮询本地桥接服务(scripts/system-media-bridge.ts),
 * 读取 Windows 系统媒体会话(SMTC)中活跃平台的播放状态(曲目/进度),
 * 并发送上一首/播放暂停/下一首/跳转控制指令。
 * 进度显示 = 锚定基准 + 本地时钟流逝:常规轮询不跟随上报位置
 * (浏览器等平台的位置会抖动/阶梯式过期,跟随会让进度条抽搐),
 * 仅在曲目变化 / 播放状态变化 / 用户 seek(立即锚定,拒绝则回退)/
 * 严重偏离且上报位置大幅移动时重锚定。
 * 桥接未运行时 active 为 false,回退本地播放器。
 */
export function useSystemMedia(): SystemMediaState {
  const [active, setActive] = useState(false)
  const [platform, setPlatform] = useState<SystemPlatform>(recognizePlatform(null))
  const [track, setTrack] = useState<SystemTrackInfo | null>(null)
  const [duration, setDuration] = useState(0)
  const [modeSupported, setModeSupported] = useState(true)
  // 系统真实播放模式(轮询校准;客户端不写入 SMTC 时保持 sequence)
  const [mode, setMode] = useState<PlaybackMode>('sequence')
  // 用户意图状态:播放/暂停按钮按用户点击意图即时驱动(响应快),
  // 轮询时以 SMTC PlaybackStatus 双向校准(Windows 11 26100 新版 API
  // 实测状态可信:暂停返回 false、播放返回 true)。旧版"恒 true"假设
  // 已不成立——否则暂停态切歌后外部自动播放,按键仍显示暂停
  const [userPlaying, setUserPlaying] = useState(true)
  // 进度显示 = 校准基准 + 本地流逝时间(无覆盖回跳,播放时间平滑推进)
  const baseRef = useRef(0) // 最近一次重锚定的位置
  const baseAtRef = useRef(0) // 重锚定时刻(performance.now)
  const playingRef = useRef(true) // 播放中才累计流逝
  // 上次轮询的曲目标识:曲目变化(切歌/换平台)时重锚定位置
  const prevTrackKeyRef = useRef('')
  // 上次轮询的 SMTC 播放状态:播放状态变化(暂停/恢复)时校准
  const prevSmPlayingRef = useRef(true)
  // 上次轮询的上报位置:"大幅移动"判定(区分真实跳变与阶梯式过期上报)
  const prevReportedRef = useRef<number | null>(null)
  // 挂起的 seek 验证(control 内创建,轮询确认或超时收尾):
  // 客户端"接受" seek 但实际未跳转时(如 QQ音乐)回退显示并判定不支持
  const pendingSeekRef = useRef<{
    target: number
    prevBase: number
    prevBaseAt: number
    sourceId: string
    resolve: (accepted: boolean | undefined) => void
  } | null>(null)
  const seekVerifyTimerRef = useRef(0)
  // 平台 seek 支持记忆:按 sourceAppId 记录(持久化,切换平台/重启
  // 都不重学);false = 该平台"接受" seek 但实际不跳转
  const seekSupportRef = useRef<Record<string, boolean>>(loadSeekSupport())
  const sourceIdRef = useRef<string | null>(null)
  // 250ms tick 驱动重渲染(重算显示进度)
  const [, setTick] = useState(0)

  // 记忆平台 seek 支持状态(按 sourceAppId,持久化;
  // 验证结果归属调用时的平台,防止验证期间切换平台张冠李戴)
  const rememberSeekSupport = useCallback((sourceId: string, supported: boolean) => {
    const next = { ...seekSupportRef.current, [sourceId]: supported }
    seekSupportRef.current = next
    try {
      localStorage.setItem(SEEK_SUPPORT_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // 忽略存储失败
    }
  }, [])

  useEffect(() => {
    let stopped = false
    let timer = 0
    const poll = async () => {
      try {
        const res = await fetch(`${BRIDGE_BASE}/state`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (res.ok) {
          const data = (await res.json()) as BridgeStateMessage
          if (stopped) return
          setActive(true)
          setPlatform(recognizePlatform(data.sourceAppId))
          // 曲目内容未变时保持旧对象引用:setTrack 每次传新对象会强制
          // 父组件每秒重渲染(即使曲目/进度都没变化),这里按字段比较
          setTrack((prev) => {
            const next = data.track?.title
              ? {
                  title: data.track.title,
                  artist: data.track.artist ?? '',
                  album: data.track.album,
                }
              : null
            if (
              prev?.title === next?.title &&
              prev?.artist === next?.artist &&
              prev?.album === next?.album
            ) {
              return prev
            }
            return next
          })
          // 时长可信度:位置已明显超过上报时长(>5s)说明时长本身不可信
          // (如 QQ音乐个别曲目 EndTime 固定 ~8s 而实际播放数分钟),视为
          // 未知(0)→ 进度条切不确定态、不显示假的总时长;不做外部查询
          // 兜底(曲库搜索匹配到的是同名其它版本,不可靠)
          const reportedPos = typeof data.position === 'number' ? data.position : 0
          const reportedDur = typeof data.duration === 'number' ? data.duration : 0
          setDuration(reportedDur > 0 && reportedPos > reportedDur + 5 ? 0 : reportedDur)
          if (typeof data.modeSupported === 'boolean') setModeSupported(data.modeSupported)
          // 真实播放模式校准(SMTC PlaybackInfo;repeat-all 映射为 sequence 前端三态)
          if (data.playbackMode === 'repeat-one' || data.playbackMode === 'shuffle') {
            setMode(data.playbackMode)
          } else {
            setMode('sequence')
          }
          // 位置基准更新策略:常规轮询**不跟随**上报位置——浏览器等平台
          // 的 SMTC 位置会抖动或阶梯式过期(冻结数秒后跳变),跟随会让
          // 进度条抽搐或周期性回跳。显示进度 = 锚定基准 + 本地时钟流逝,
          // 仅在以下情况重锚定:
          //   1) 曲目变化(切歌/换平台)
          //   2) 播放状态变化:暂停冻结在本地时钟当前显示位置、恢复从
          //      冻结位置继续推进(上报位置可能过期数秒,不采信)
          //   3) 位置严重偏离(> 5s)且上报位置大幅移动(本次 ≥ 2s):
          //      真实跳变(外部 seek/重播)才满足;浏览器阶梯上报在
          //      冻结期移动≈0、更新瞬间偏差≈0,永远不满足
          const reported = data.position ?? baseRef.current
          const now = performance.now()
          const displayed = playingRef.current
            ? baseRef.current + (now - baseAtRef.current) / 1000
            : baseRef.current
          const trackKey = `${data.track?.title ?? ''}|${data.track?.artist ?? ''}`
          const trackChanged = trackKey !== prevTrackKeyRef.current
          prevTrackKeyRef.current = trackKey
          const smPlaying =
            typeof data.isPlaying === 'boolean' ? data.isPlaying : prevSmPlayingRef.current
          const playChanged = smPlaying !== prevSmPlayingRef.current
          prevSmPlayingRef.current = smPlaying
          // 记录当前平台(seek 支持按平台持久化记忆,切换不重学)
          const sourceId = data.sourceAppId ?? null
          if (sourceId !== sourceIdRef.current) sourceIdRef.current = sourceId
          if (trackChanged) {
            baseRef.current = reported
            baseAtRef.current = now
          } else if (playChanged && !smPlaying) {
            // 外部暂停:冻结在本地时钟当前显示位置
            baseRef.current = displayed
            baseAtRef.current = now
          } else if (
            Math.abs(reported - displayed) > POSITION_DIVERGENCE_LIMIT_SEC &&
            (prevReportedRef.current === null ||
              Math.abs(reported - prevReportedRef.current) > POSITION_ALIVE_MOVE_SEC)
          ) {
            baseRef.current = reported
            baseAtRef.current = now
          }
          prevReportedRef.current = reported
          // 挂起的 seek 验证:系统位置跟随目标(或单次大幅移动——覆盖
          // 浏览器等阶梯式更新平台,位置块状前进可能永远不落在目标
          // ±3s 内,但跳变本身证明 seek 已生效)即视为成功;
          // 超时未跟随的收尾见 control() 里的定时器
          const pendingSeek = pendingSeekRef.current
          if (
            pendingSeek &&
            (Math.abs(reported - pendingSeek.target) <= SEEK_VERIFY_TOLERANCE_SEC ||
              Math.abs(reported - prevReportedRef.current) > SEEK_VERIFY_JUMP_SEC)
          ) {
            pendingSeekRef.current = null
            window.clearTimeout(seekVerifyTimerRef.current)
            rememberSeekSupport(pendingSeek.sourceId, true)
            pendingSeek.resolve(true)
          }
          // PlaybackStatus 双向校准:暂停态切歌后外部自动播放时,
          // 播放键/时间插值能跟随真实状态(不再卡在"暂停"显示)
          if (typeof data.isPlaying === 'boolean') setUserPlaying(data.isPlaying)
        } else {
          if (!stopped) setActive(false)
        }
      } catch {
        if (!stopped) setActive(false)
      }
      if (!stopped) timer = window.setTimeout(poll, POLL_MS)
    }
    poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.clearTimeout(seekVerifyTimerRef.current)
      pendingSeekRef.current?.resolve?.(undefined)
      pendingSeekRef.current = null
    }
  }, [rememberSeekSupport])

  // 250ms tick 驱动重渲染:显示进度 = 基准 + 播放流逝(仅播放中需要推进)。
  // 暂停时位置冻结在基准上、未连接时无进度可推——两种情况都无需渲染,
  // 常驻 interval 会让暂停/空闲状态每秒白渲 4 次整棵组件树
  useEffect(() => {
    if (!active || !userPlaying) return
    const id = window.setInterval(() => setTick((t) => t + 1), TICK_MS)
    return () => window.clearInterval(id)
  }, [active, userPlaying])
  playingRef.current = userPlaying

  // 显示进度:校准基准 + 播放以来的本地流逝时间(平滑无回跳);
  // 暂停时停在基准位置,轮询持续校准
  const position = playingRef.current
    ? baseRef.current + (performance.now() - baseAtRef.current) / 1000
    : baseRef.current

  const control = useCallback(
    async (action: SystemControlAction, seekPosition?: number): Promise<boolean | undefined> => {
      // 记录用户意图:播放/暂停按钮按意图显示与发指令;
      // 切歌后客户端通常自动播放,乐观更新为播放态(轮询会校准)
      if (action === 'play') setUserPlaying(true)
      else if (action === 'pause') {
        setUserPlaying(false)
        // 暂停:立即把显示位置冻结在点击瞬间(本地时钟当前值),避免
        // 显示停在旧基准上;恢复时从冻结位置继续推进
        baseRef.current = baseRef.current + (performance.now() - baseAtRef.current) / 1000
        baseAtRef.current = performance.now()
      } else if (action === 'next' || action === 'previous') setUserPlaying(true)
      // 用户主动 seek:立即把显示位置锚定到目标(拖拽即时响应)。
      // 是否生效由"挂起验证"判定(对照系统真实位置,见轮询):
      //   已记忆为不支持的平台直接拒绝(零等待);
      //   客户端明确拒绝立即回退;
      //   超时未跟随(客户端"接受"但实际未跳转,如 QQ音乐)回退并拒绝。
      // 验证结果按 sourceAppId 持久化,切换平台/重启都不重学
      const seekTarget = typeof seekPosition === 'number' ? seekPosition : null
      const seekSourceId = sourceIdRef.current ?? ''
      if (seekTarget !== null && seekSupportRef.current[seekSourceId] === false) return false
      const prevSeekBase = seekTarget !== null ? baseRef.current : null
      const prevSeekBaseAt = seekTarget !== null ? baseAtRef.current : null
      if (seekTarget !== null) {
        baseRef.current = seekTarget
        baseAtRef.current = performance.now()
      }
      let accepted: boolean | undefined
      try {
        const res = await fetch(`${BRIDGE_BASE}/control`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, position: seekPosition }),
        })
        if (!res.ok) return undefined
        const data = (await res.json()) as { accepted?: boolean }
        accepted = data.accepted
      } catch {
        return undefined
      }
      if (seekTarget === null) return accepted
      if (accepted === false) {
        // 客户端明确拒绝:回退显示并记忆不支持
        if (prevSeekBase !== null && prevSeekBaseAt !== null) {
          baseRef.current = prevSeekBase
          baseAtRef.current = prevSeekBaseAt
        }
        rememberSeekSupport(seekSourceId, false)
        return false
      }
      if (seekSupportRef.current[seekSourceId] === true) return true
      // 未明确拒绝且未知:挂起验证,等轮询确认系统位置跟随目标
      // (浏览器等阶梯式更新平台可能数秒后才反映);超时判定为不支持
      return await new Promise<boolean | undefined>((resolve) => {
        window.clearTimeout(seekVerifyTimerRef.current)
        const myPending = {
          target: seekTarget,
          prevBase: prevSeekBase as number,
          prevBaseAt: prevSeekBaseAt as number,
          sourceId: seekSourceId,
          resolve,
        }
        pendingSeekRef.current = myPending
        seekVerifyTimerRef.current = window.setTimeout(() => {
          if (pendingSeekRef.current !== myPending) return
          pendingSeekRef.current = null
          baseRef.current = myPending.prevBase
          baseAtRef.current = myPending.prevBaseAt
          rememberSeekSupport(myPending.sourceId, false)
          myPending.resolve(false)
        }, SEEK_VERIFY_LIMIT_MS)
      })
    },
    [rememberSeekSupport],
  )

  // 对外 isPlaying 用用户意图(QQ音乐真实状态不可读,意图驱动播放/暂停按钮)
  return {
    active,
    platform,
    track,
    isPlaying: userPlaying,
    position,
    duration,
    modeSupported,
    mode,
    control,
  }
}

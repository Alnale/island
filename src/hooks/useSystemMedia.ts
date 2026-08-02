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
 * 进度在轮询间隙由本地时钟平滑插值,每次轮询校准。
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
  const baseRef = useRef(0) // 最近一次轮询校准的位置
  const baseAtRef = useRef(0) // 校准时刻(performance.now)
  const playingRef = useRef(true) // 播放中才累计流逝
  // 250ms tick 驱动重渲染(重算显示进度)
  const [, setTick] = useState(0)

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
          setTrack(
            data.track?.title
              ? { title: data.track.title, artist: data.track.artist ?? '', album: data.track.album }
              : null,
          )
          setDuration(data.duration ?? 0)
          if (typeof data.modeSupported === 'boolean') setModeSupported(data.modeSupported)
          // 真实播放模式校准(SMTC PlaybackInfo;repeat-all 映射为 sequence 前端三态)
          if (data.playbackMode === 'repeat-one' || data.playbackMode === 'shuffle') {
            setMode(data.playbackMode)
          } else {
            setMode('sequence')
          }
          // 校准基准:更新基准位置与时刻,显示进度从基准平滑推进
          baseRef.current = data.position ?? 0
          baseAtRef.current = performance.now()
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
    }
  }, [])

  // 250ms tick 驱动重渲染:显示进度按"基准 + 播放流逝"重算
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), TICK_MS)
    return () => window.clearInterval(id)
  }, [])
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
      else if (action === 'pause') setUserPlaying(false)
      else if (action === 'next' || action === 'previous') setUserPlaying(true)
      try {
        const res = await fetch(`${BRIDGE_BASE}/control`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, position: seekPosition }),
        })
        if (!res.ok) return undefined
        const data = (await res.json()) as { accepted?: boolean }
        return data.accepted
      } catch {
        return undefined
      }
    },
    [],
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

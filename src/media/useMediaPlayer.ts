import { useCallback, useEffect, useRef, useState } from 'react'
import type { TrackInfo } from '../data/islandStates'
import type { PlaybackMode } from './playbackModes'
import { loadTracks } from './tracks'
import { inferAudioType, loadUploads, removeUpload, saveUpload, saveUploadData } from './uploadStore'
// 播放列表 ↔ 音频库同步(2026-08-08):上传歌曲到播放列表时自动补录
// 音频库(同名不重复导入);多媒体库音频 tab 可导入播放列表
import {
  findAudioByName,
  genLibraryId,
  saveAudioItem,
  type AudioLibraryItem,
} from './libraryStore'

/** 播放器阶段:加载中 / 播放中 / 已暂停 */
export type PlayerPhase = 'idle' | 'loading' | 'playing'

export interface MediaPlayer {
  phase: PlayerPhase
  /** 播放列表(内置 + 用户上传) */
  tracks: TrackInfo[]
  /** 当前播放索引 */
  index: number
  /** 当前歌曲,null 表示曲目尚未生成 */
  track: TrackInfo | null
  /** 播放进度(秒) */
  position: number
  /** 总时长(秒) */
  duration: number
  /** 播放模式:顺序 / 单曲循环 / 随机(决定 next/ended 行为与主题色) */
  mode: PlaybackMode
  /** 按 顺序 → 单曲循环 → 随机 → 顺序 轮换 */
  cycleMode(): void
  /** 直接指定播放模式 */
  setMode(mode: PlaybackMode): void
  play(): void
  pause(): void
  toggle(): void
  next(): void
  previous(): void
  /** 播放指定索引曲目(播放列表点击切换) */
  playIndex(index: number): void
  /** 上传音频文件加入播放列表(自动播放第一首新曲) */
  addTracks(files: File[]): void
  /** 从音频库导入播放列表(2026-08-08,单个/批量;自动播放第一首新曲;
      不重复入库——音频库已是来源)。opts.autoPlay=false = 仅入列表不
      自动播(2026-08-11 LLM 工具 add_audio_to_playlist:音频默认在对话
      窗口播放,切音乐模式只在用户明确要求时) */
  addLibraryTracks(items: AudioLibraryItem[], opts?: { autoPlay?: boolean }): void
  /**
   * 以原始 URL 加入播放列表并播放(2026-08-11 音频移交优化):**不 fetch
   * 不转码,立即播放**——对话窗口播放中的音频切到音乐模式不中断;
   * opts.position = 移交时播放进度(从该位置续播,不从头,参考视频岛
   * 续播机制);opts.loop = 对话窗口循环播放 → 音乐模式同步为单曲循环。
   * 本地文件(island-media:/绝对路径)后台异步持久化到 IndexedDB
   * (刷新后播放列表恢复;失败不影响本次播放);https/data/blob 跳过
   * (仅本次会话,与既有 addTracks 的持久化语义一致的部分)
   */
  addTrackUrl(url: string, name: string, opts?: { position?: number; loop?: boolean }): void
  /** 删除列表曲目(仅上传曲目可删);删除当前播放曲目则切到相邻曲目 */
  removeTrack(index: number): void
  /**
   * 按持久化 key 删除曲目(2026-08-11,LLM 工具 remove_playlist_item:
   * 桥删 IndexedDB 后经事件回调本方法)——播放列表与持久化存储保持
   * 同步(删当前播放曲目切相邻,复用 removeTrack 语义)
   */
  removeTrackByStorageKey(key: string): void
  /** 跳转进度(秒),由灵动岛进度条拖动回传 */
  seek(seconds: number): void
}

/** 等"可以播放"的超时兜底(真实 MP3 需缓冲,防止事件丢失时卡在加载中) */
const LOADING_FALLBACK_MS = 4000

/**
 * 真实音频播放器:浏览器内合成 WAV 曲目,由 <audio> 元素播放。
 * 同时同步到系统媒体会话(navigator.mediaSession)——系统媒体面板/耳机键
 * 也能看到歌曲信息并控制播放与进度,这是灵动岛 API 的"监听"底座。
 *
 * 注意:曲目生成是异步的,首帧 track 为 null;浏览器自动播放策略
 * 要求用户手势后 audio.play() 才会真正出声。
 */
export function useMediaPlayer(): MediaPlayer {
  const [tracks, setTracks] = useState<TrackInfo[]>([])
  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<PlayerPhase>('idle')
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [mode, setModeState] = useState<PlaybackMode>('sequence')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const tracksRef = useRef<TrackInfo[]>([])
  const indexRef = useRef(0)
  const phaseRef = useRef<PlayerPhase>('idle')
  const modeRef = useRef<PlaybackMode>('sequence')
  const timerRef = useRef<number | null>(null)
  // 本会话创建的 blob URL(删除曲目 / 卸载时 revoke,防常驻应用内存泄漏)
  const blobUrlsRef = useRef<Set<string>>(new Set())
  /** timeupdate 节流:位置推进无需逐事件重渲染全树(高频率事件源) */
  const lastPositionUpdateRef = useRef(0)
  /** 系统媒体会话进度同步节流(秒级,仅用于系统媒体面板显示) */
  const lastSessionSyncRef = useRef(0)
  tracksRef.current = tracks
  phaseRef.current = phase
  modeRef.current = mode

  const playTrack = useCallback((nextIndex: number, fromPosition?: number) => {
    const audio = audioRef.current
    const list = tracksRef.current
    const track = list[nextIndex]
    if (!audio || !track) return
    indexRef.current = nextIndex
    setIndex(nextIndex)
    setPosition(0)
    setPhase('loading')
    audio.src = track.url ?? ''
    audio.load()
    // 等"可以播放"再起播(加载中状态自然展示);超时兜底,自动播放被拦截时退回暂停
    const onReady = () => {
      audio.removeEventListener('canplay', onReady)
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      // 续播位置(2026-08-11 音频移交):canplay 后先 seek 到移交时进度
      // 再 play——从对话窗口切到音乐模式不从头播(参考视频岛续播机制)
      if (fromPosition && fromPosition > 0) {
        try {
          audio.currentTime = Math.min(
            fromPosition,
            Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fromPosition,
          )
          setPosition(audio.currentTime)
        } catch {
          // seek 失败忽略(照常播放)
        }
      }
      audio.play().catch(() => setPhase('idle'))
    }
    audio.addEventListener('canplay', onReady)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      audio.removeEventListener('canplay', onReady)
      onReady()
    }, LOADING_FALLBACK_MS)
  }, [])

  const play = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!audio.src) {
      playTrack(0)
      return
    }
    audio.play().catch(() => {})
  }, [playTrack])

  const pause = useCallback(() => {
    audioRef.current?.pause()
    setPhase('idle')
  }, [])

  const toggle = useCallback(() => {
    if (phaseRef.current === 'playing') pause()
    else play()
  }, [pause, play])

  /** 重播当前曲目(单曲循环:从头再播,不切 track) */
  const replayCurrent = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = 0
    audio.play().catch(() => {})
  }, [])

  /** 手动下一首:总是切歌——顺序 → 列表顺延;随机 → 随机曲目(单曲时退回顺序);
   *  单曲循环同样切歌(单曲循环只作用于自然播完时的重播) */
  const next = useCallback(() => {
    const list = tracksRef.current
    if (list.length === 0) return
    if (modeRef.current === 'shuffle' && list.length > 1) {
      let nextIndex = indexRef.current
      while (nextIndex === indexRef.current) {
        nextIndex = Math.floor(Math.random() * list.length)
      }
      playTrack(nextIndex)
      return
    }
    playTrack((indexRef.current + 1) % list.length)
  }, [playTrack])

  const cycleMode = useCallback(() => {
    setModeState((m) => (m === 'sequence' ? 'repeat-one' : m === 'repeat-one' ? 'shuffle' : 'sequence'))
  }, [])

  const setMode = useCallback((m: PlaybackMode) => setModeState(m), [])

  /** 播放指定索引曲目(播放列表点击切换) */
  const playIndex = useCallback(
    (i: number) => {
      const list = tracksRef.current
      if (i >= 0 && i < list.length) playTrack(i)
    },
    [playTrack],
  )

  /** 上传音频文件加入播放列表(持久化到 IndexedDB,刷新后可恢复),自动播放第一首新曲 */
  const addTracks = useCallback(
    async (files: File[]) => {
      const uploaded = await Promise.all(
        files
          // File.type 可能为空(部分系统/拖拽文件),按扩展名兜底——
          // 否则合法音频被静默过滤,"上传了但列表没有"(2026-08-08)
          .filter(
            (f) =>
              f.type.startsWith('audio/') ||
              /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|webm)$/i.test(f.name),
          )
          .map(async (f) => {
            const url = URL.createObjectURL(f)
            blobUrlsRef.current.add(url)
            // 自动补录音频库(2026-08-08,参考图片库导入机制):播放列表
            // 上传的歌曲若音频库**没有同名记录**则自动入库;已有则不
            // 重复导入(多媒体库是播放列表的持久化扩展,删库条目不影响
            // 播放列表本身)
            const existing = await findAudioByName(f.name).catch(() => null)
            if (!existing) {
              await saveAudioItem({
                id: genLibraryId('audio'),
                name: f.name.slice(0, 100),
                type: f.type,
                data: await f.arrayBuffer(),
                createdAt: Date.now(),
              }).catch(() => {
                // 音频库写入失败(配额等)不影响播放列表上传
              })
            }
            return {
              title: f.name.replace(/\.[^.]+$/, ''),
              artist: '本地音乐',
              duration: 0,
              url,
              source: 'uploaded' as const,
              storageKey: await saveUpload(f).catch(() => undefined),
            }
          }),
      )
      if (uploaded.length === 0) return
      const next = [...tracksRef.current, ...uploaded]
      tracksRef.current = next // 先同步 ref,playTrack 立即用新列表
      setTracks(next)
      playTrack(next.length - uploaded.length) // 播放第一首新曲
    },
    [playTrack],
  )

  /** 从音频库导入播放列表(2026-08-08):条目 data → Blob URL + 持久化
   * island-uploads(播放列表重启恢复);与 addTracks 同路径,但**不重复
   * 入库音频库**(来源即音频库);自动播放第一首新曲 */
  const addLibraryTracks = useCallback(
    async (items: AudioLibraryItem[], opts?: { autoPlay?: boolean }) => {
      if (items.length === 0) return
      const uploaded = await Promise.all(
        items.map(async (it) => {
          const url = URL.createObjectURL(new Blob([it.data], { type: it.type }))
          blobUrlsRef.current.add(url)
          return {
            title: it.name.replace(/\.[^.]+$/, ''),
            artist: '本地音乐',
            duration: 0,
            url,
            source: 'uploaded' as const,
            storageKey: await saveUploadData(it.name, it.type, it.data).catch(() => undefined),
          }
        }),
      )
      const next = [...tracksRef.current, ...uploaded]
      tracksRef.current = next // 先同步 ref,playTrack 立即用新列表
      setTracks(next)
      // autoPlay=false = 仅入列表不自动播放(2026-08-11 LLM 工具
      // add_audio_to_playlist:音频默认在对话窗口播放,切音乐模式只在
      // 用户明确要求时——加入播放列表不再自动播首曲/切模式)
      if (opts?.autoPlay !== false) playTrack(next.length - uploaded.length) // 播放第一首新曲
    },
    [playTrack],
  )

  /** 以原始 URL 加入播放列表并播放(2026-08-11 音频移交优化,见接口注释):
   * 立即播放不中断;本地文件后台持久化;position 续播 + loop 单曲循环 */
  const addTrackUrl = useCallback(
    (url: string, name: string, opts?: { position?: number; loop?: boolean }) => {
      const audio = audioRef.current
      if (!audio) return
      const title = (name || '对话音频').replace(/\.[^.]+$/, '')
      const track: TrackInfo = {
        title,
        artist: '本地音乐',
        duration: 0,
        url,
        source: 'uploaded' as const,
      }
      const idx = tracksRef.current.length
      const next = [...tracksRef.current, track]
      tracksRef.current = next // 先同步 ref,playTrack 立即用新列表
      setTracks(next)
      // 循环同步:对话窗口循环 → 音乐模式单曲循环(播完自动重播)
      if (opts?.loop) setModeState('repeat-one')
      // 从移交进度续播,不从头(参考视频岛续播机制)
      playTrack(idx, opts?.position)
      // 后台持久化(本地文件):刷新后播放列表恢复该曲目;island-media
      // 协议 fetch 返回文件内容(主进程流式协议);失败不影响本次播放
      if (/^(island-media:|[a-zA-Z]:[\\/]|\/)/.test(url)) {
        void (async () => {
          try {
            const res = await fetch(url)
            if (!res.ok) return
            const data = await res.arrayBuffer()
            const type = inferAudioType(name, '')
            const storageKey = await saveUploadData(name, type, data)
            if (storageKey) {
              const list = tracksRef.current.map((t, i) =>
                i === idx ? { ...t, storageKey } : t,
              )
              tracksRef.current = list
              setTracks(list)
            }
          } catch {
            // 持久化失败忽略(本次播放不受影响)
          }
        })()
      }
    },
    [playTrack],
  )

  /** 删除列表曲目(仅上传曲目可删);删除当前播放曲目则切到相邻曲目 */
  const removeTrack = useCallback(
    (removeIndex: number) => {
      const list = tracksRef.current
      const target = list[removeIndex]
      if (!target || target.source !== 'uploaded') return
      const cur = indexRef.current
      const next = list.filter((_, k) => k !== removeIndex)
      tracksRef.current = next // 先同步 ref,后续播放用新列表索引
      setTracks(next)
      // 同步删除 IndexedDB 持久化记录
      if (target.storageKey) removeUpload(target.storageKey).catch(() => {})
      // 释放该曲目的 blob URL(本会话创建的才 revoke,内置曲目不受影响)
      if (target.url?.startsWith('blob:') && blobUrlsRef.current.delete(target.url)) {
        URL.revokeObjectURL(target.url)
      }
      if (removeIndex === cur) {
        // 删除当前播放:切到相邻(新列表原位置,越界取最后);列表清空则真正停止
        const playAt = Math.min(removeIndex, next.length - 1)
        if (next.length > 0 && playAt >= 0) {
          playTrack(playAt)
        } else {
          // 只 setPhase('idle') 不会停音频——被删歌曲会继续响
          const audio = audioRef.current
          if (audio) {
            audio.pause()
            audio.removeAttribute('src')
            audio.load()
          }
          setPhase('idle')
        }
      } else if (removeIndex < cur) {
        indexRef.current = cur - 1
        setIndex(cur - 1)
      }
    },
    [playTrack],
  )

  const previous = useCallback(() => {
    const list = tracksRef.current
    if (list.length === 0) return
    playTrack((indexRef.current - 1 + list.length) % list.length)
  }, [playTrack])

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return
    audio.currentTime = Math.min(Math.max(seconds, 0), audio.duration)
    setPosition(audio.currentTime)
  }, [])

  const nextRef = useRef(next)
  nextRef.current = next

  // 创建音频元素并监听事件:play/pause/timeupdate/ended 等
  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'metadata'
    audioRef.current = audio

    const onPlay = () => setPhase('playing')
    const onPause = () => setPhase((p) => (p === 'playing' ? 'idle' : p))
    const onTimeUpdate = () => {
      // 节流:timeupdate 事件密集触发(部分浏览器/高倍速下远超显示需求),
      // 200ms 内多次事件合并为一次 setPosition,播放感知无差异
      const now = performance.now()
      if (now - lastPositionUpdateRef.current < 200) return
      lastPositionUpdateRef.current = now
      setPosition(audio.currentTime)
      // 同步系统媒体会话的进度(供系统媒体面板显示),节流到秒级
      if (
        now - lastSessionSyncRef.current >= 1000 &&
        'mediaSession' in navigator &&
        Number.isFinite(audio.duration) &&
        audio.duration > 0
      ) {
        lastSessionSyncRef.current = now
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: 1,
          position: audio.currentTime,
        })
      }
    }
    const onDurationChange = () => {
      const d = audio.duration
      if (Number.isFinite(d) && d > 0) setDuration(d)
    }
    // 自然播完:单曲循环重播当前,其余模式按模式切下一首
    const onEnded = () => {
      if (modeRef.current === 'repeat-one') replayCurrent()
      else nextRef.current()
    }

    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('seeking', onTimeUpdate)
    audio.addEventListener('durationchange', onDurationChange)
    audio.addEventListener('loadedmetadata', onDurationChange)
    audio.addEventListener('ended', onEnded)

    loadTracks().then((list) => {
      setTracks(list)
      // 预加载首曲,不自动播放(浏览器自动播放策略需要用户手势)
      if (list[0] && audioRef.current === audio) {
        audio.src = list[0].url ?? ''
      }
    })

    const blobUrls = blobUrlsRef.current // Set 实例挂载后不变,可安全捕获
    return () => {
      audio.pause()
      audioRef.current = null
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 计时器需读取清理时刻的最新值
      const pendingTimer = timerRef.current
      if (pendingTimer !== null) {
        window.clearTimeout(pendingTimer)
        timerRef.current = null
      }
      // 释放本会话创建的全部 blob URL(StrictMode 双挂载时首个挂载
      // 的 loadUploads 已被 cancelled,不会重复登记,安全)
      for (const url of blobUrls) URL.revokeObjectURL(url)
      blobUrls.clear()
    }
    // 一次性挂载 effect:replayCurrent/nextRef 均为稳定引用,无需重挂 audio
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 挂载时恢复持久化的上传曲目(IndexedDB → blob URL,刷新后不丢失)
  useEffect(() => {
    let cancelled = false
    loadUploads()
      .then((items) => {
        if (cancelled || items.length === 0) return
        const restored: TrackInfo[] = items.map((it) => {
          const url = URL.createObjectURL(new Blob([it.data], { type: it.type }))
          blobUrlsRef.current.add(url)
          return {
            title: it.name.replace(/\.[^.]+$/, ''),
            artist: '本地音乐',
            duration: 0,
            url,
            source: 'uploaded' as const,
            storageKey: it.key,
          }
        })
        setTracks((prev) => {
          const next = [...prev, ...restored]
          tracksRef.current = next
          return next
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // 同步系统媒体会话:歌曲信息 + 全局媒体键(系统媒体面板/耳机键也可控制)
  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
    const track = tracks[index]
    if (!track) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: '灵动岛演示',
    })
    navigator.mediaSession.setActionHandler('play', () => play())
    navigator.mediaSession.setActionHandler('pause', () => pause())
    navigator.mediaSession.setActionHandler('nexttrack', () => next())
    navigator.mediaSession.setActionHandler('previoustrack', () => previous())
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') seek(details.seekTime)
    })
  }, [index, tracks, play, pause, next, previous, seek])

  return {
    phase,
    tracks,
    index,
    track: tracks[index] ?? null,
    position,
    duration,
    mode,
    cycleMode,
    setMode,
    play,
    pause,
    toggle,
    next,
    previous,
    playIndex,
    addTracks,
    addLibraryTracks,
    addTrackUrl,
    removeTrack,
    removeTrackByStorageKey: (key) => {
      const idx = tracksRef.current.findIndex((t) => t.storageKey === key)
      if (idx >= 0) removeTrack(idx)
    },
    seek,
  }
}

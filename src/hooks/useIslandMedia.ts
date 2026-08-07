/**
 * 双宿主(Web 演示版 App.tsx / 桌面挂件 WidgetApp.tsx)共用的媒体数据源派生:
 * 外部平台(SMTC 监听)优先,本地播放器兜底——数据/控制/进度/模式按
 * externalActive 分支取数(2026-08-06 架构优化,消两端 ~150 行逐字重复)。
 *
 * 与宿主的分界:
 * - 本 hook 管"数据源选择 + 派生 + 控制分发"(两端一致的部分);
 * - 宿主保留:模式切换(挂件托盘/手势)、Agent 接线、主题色计算、
 *   演示页监控等环境专属逻辑。
 * 对齐的两端分叉(审计发现):lyrics 的 platformId(挂件版传监听平台,
 * Web 演示版此前漏传——歌词厂商跟随逻辑两端一致);回调一律 useCallback
 * 保持引用稳定(配合 DynamicIsland 的 memo,对 Web 演示版无害)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IslandState, TrackInfo } from '../data/islandStates'
import type { PlaybackMode } from '../media/playbackModes'
import type { SystemControlAction } from './useSystemMedia'
import { useLyrics } from './useLyrics'
import { useMediaPlayer } from '../media/useMediaPlayer'
import { useSystemMedia } from './useSystemMedia'

export function useIslandMedia({
  player,
  system,
  showHint,
}: {
  player: ReturnType<typeof useMediaPlayer>
  system: ReturnType<typeof useSystemMedia>
  showHint: (text: string) => void
}) {
  // 数据源开关:默认外部监听优先,点击灵动岛音乐图标在
  // "本地播放器 ↔ 系统监听"间切换
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
  // 系统媒体监听激活(外部平台正在播放):数据与控制优先走系统,本地播放器让位
  const externalActive = system.active && system.track != null && useExternalSource
  // 外部平台播放模式(前端跟踪,点击循环:顺序→单曲循环→随机→顺序;
  // 以系统真实状态为数据源,轮询校准——客户端写入 SMTC 时自动跟随)
  const [externalMode, setExternalMode] = useState<PlaybackMode>('sequence')
  const systemRef = useRef(system)
  systemRef.current = system
  // 循环模式 1.2s 跟随检测定时器:卸载后仍触发会 setState(审计 P2 #13),
  // ref 跟踪 + 卸载清理;连续点击循环重置计时
  const cycleModeTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (cycleModeTimerRef.current) window.clearTimeout(cycleModeTimerRef.current)
    },
    [],
  )
  useEffect(() => {
    if (!externalActive) return
    setExternalMode((current) => {
      const real = systemRef.current.mode
      return real === current ? current : real
    })
  }, [system.mode, externalActive])

  // 歌词字幕:按当前曲目(外部平台或本地)自动查询,播放位置驱动高亮。
  // platformId:自动切换歌词 API 到监听平台对应的厂商(QQ音乐/网易云/酷狗/
  // 酷我;浏览器等无对应平台回退手动配置)
  const lyricsData = useLyrics(
    externalActive ? system.track?.title ?? null : player.track?.title ?? null,
    externalActive ? system.track?.artist ?? null : player.track?.artist ?? null,
    // 歌词用 lyricPosition(跟随平台上报,与歌词对齐);进度条仍用
    // position(锚定 + 本地时钟,平滑)
    externalActive ? system.lyricPosition : player.position,
    true,
    externalActive ? system.platform?.id ?? null : null,
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

  // 播放模式循环:外部监听作用于外部平台(重复/随机,按客户端接受与否回退),
  // 本地作用于本地歌单;外部操作 1.2s 后检测系统真实状态,未生效则提示并回退。
  // 依赖只列动态值(system.control 为稳定引用,player 对象每次渲染新建,
  // 列入会使回调失去稳定性——与两端原实现一致)
  /* eslint-disable react-hooks/exhaustive-deps */
  const handleCycleMode = useCallback(() => {
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
      // 1.2s 后检测系统真实状态是否跟随:没跟随说明客户端不写 SMTC,
      // 提示并回退(经 ref 读最新值,闭包不捕获过期 system);
      // 定时器经 ref 跟踪,连续点击重置、卸载清理(审计 P2 #13)
      if (cycleModeTimerRef.current) window.clearTimeout(cycleModeTimerRef.current)
      cycleModeTimerRef.current = window.setTimeout(() => {
        cycleModeTimerRef.current = null
        const real = systemRef.current.mode
        if (real !== next) {
          showHint('当前平台不支持播放模式同步')
          setExternalMode(real)
        }
      }, 1200)
    } else {
      player.cycleMode()
    }
  }, [externalActive, externalMode, showHint])
  /* eslint-enable react-hooks/exhaustive-deps */
  // 外部平台进度条拖动:跳转系统媒体进度(需客户端支持
  // TryChangePlaybackPosition)。seek 是否生效由 useSystemMedia 内部验证
  // (对照系统真实位置,超时回退),返回 false 即平台不支持跳转,给出提示
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

  return {
    useExternalSource,
    handleToggleSource,
    externalActive,
    externalMode,
    setExternalMode,
    lyricsData,
    islandState,
    islandTrack,
    islandPosition,
    islandDuration,
    islandPrev,
    islandNext,
    islandToggle,
    handleCycleMode,
    islandSeek,
  }
}

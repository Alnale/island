/**
 * 视频播放偏好共享(2026-08-10 用户要求"音量/更多选项定制 UI +
 * 对话窗口 ↔ 视频岛 ↔ 多媒体库双向同步"):音量/倍速/循环三处播放器
 * 共用一份偏好——
 * - localStorage `widget-video-prefs` 持久化(跨会话);
 * - 修改经 setVideoPrefs 写存储 + 派发 `island:video-prefs` 事件,
 *   各播放器订阅实时同步(任意一处改动,其余即时生效)。
 */

export interface VideoPrefs {
  /** 音量 0-1 */
  volume: number
  /** 播放速度 0.5-2 */
  speed: number
  /** 循环播放 */
  loop: boolean
}

const STORAGE_KEY = 'widget-video-prefs'
export const VIDEO_PREFS_EVENT = 'island:video-prefs'

let cache: VideoPrefs | null = null

export function loadVideoPrefs(): VideoPrefs {
  if (cache) return cache
  cache = { volume: 1, speed: 1, loop: false }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<VideoPrefs>
      if (typeof p.volume === 'number') cache.volume = Math.min(1, Math.max(0, p.volume))
      if (typeof p.speed === 'number') cache.speed = Math.min(2, Math.max(0.5, p.speed))
      if (typeof p.loop === 'boolean') cache.loop = p.loop
    }
  } catch {
    // 存储损坏:用默认
  }
  return cache
}

/** 修改偏好:写 localStorage + 派发事件(各播放器订阅同步) */
export function setVideoPrefs(patch: Partial<VideoPrefs>): VideoPrefs {
  const p = loadVideoPrefs()
  if (patch.volume !== undefined) p.volume = Math.min(1, Math.max(0, patch.volume))
  if (patch.speed !== undefined) p.speed = Math.min(2, Math.max(0.5, patch.speed))
  if (patch.loop !== undefined) p.loop = patch.loop
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // 忽略存储失败
  }
  document.dispatchEvent(new CustomEvent(VIDEO_PREFS_EVENT, { detail: { ...p } }))
  return { ...p }
}

/** 订阅偏好变化(双向同步);返回取消订阅函数 */
export function onVideoPrefsChange(cb: (p: VideoPrefs) => void): () => void {
  const handler = (e: Event) => {
    cb((e as CustomEvent<VideoPrefs>).detail ?? loadVideoPrefs())
  }
  document.addEventListener(VIDEO_PREFS_EVENT, handler)
  return () => document.removeEventListener(VIDEO_PREFS_EVENT, handler)
}

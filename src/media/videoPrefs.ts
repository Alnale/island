/**
 * 视频播放偏好(2026-08-10 用户要求"音量/更多选项定制 UI + 对话窗口 ↔
 * 视频岛 ↔ 多媒体库双向同步";2026-08-10 二轮"正在播放两个视频,能独立
 * 调整单个视频的音量和播放模式"):
 * - **共享层** localStorage `widget-video-prefs`(跨会话,三处播放器共用);
 * - **个性化层** localStorage `widget-video-individual` = { [key]: prefs }——
 *   传入 key(视频名/标识)时按**单个视频**读写,无个性化记录回退共享层;
 *   修改经派发 `island:video-prefs` 事件,detail 带 key(个性化)或缺省
 *   (共享),订阅方按 key 匹配过滤——调一个视频不影响其它视频。
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
const INDIVIDUAL_KEY = 'widget-video-individual'
export const VIDEO_PREFS_EVENT = 'island:video-prefs'

let cache: VideoPrefs | null = null

/** 共享层归一化(钳制音量/速度) */
function normalize(p: Partial<VideoPrefs>): VideoPrefs {
  return {
    volume: Math.min(1, Math.max(0, typeof p.volume === 'number' ? p.volume : 1)),
    speed: Math.min(2, Math.max(0.5, typeof p.speed === 'number' ? p.speed : 1)),
    loop: Boolean(p.loop),
  }
}

function readIndividual(): Record<string, VideoPrefs> {
  try {
    const raw = localStorage.getItem(INDIVIDUAL_KEY)
    if (!raw) return {}
    const map = JSON.parse(raw) as Record<string, Partial<VideoPrefs>>
    const out: Record<string, VideoPrefs> = {}
    for (const [k, v] of Object.entries(map)) {
      if (v && typeof v === 'object') out[k] = normalize(v)
    }
    return out
  } catch {
    return {}
  }
}

function writeIndividual(map: Record<string, VideoPrefs>): void {
  try {
    localStorage.setItem(INDIVIDUAL_KEY, JSON.stringify(map))
  } catch {
    // 忽略存储失败
  }
}

/**
 * 读取播放偏好:
 * - key 缺省 = 共享层(cache 提速,三处播放器共用);
 * - key 指定 = 该视频的个性化(缺省回退共享层;仅个性化 key 时读盘,
 *   不污染共享缓存)。
 */
export function loadVideoPrefs(key?: string): VideoPrefs {
  if (key) {
    const ind = readIndividual()
    const p = ind[key]
    if (p) return normalize({ ...loadVideoPrefs(), ...p })
    return loadVideoPrefs()
  }
  if (cache) return cache
  cache = normalize({})
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) cache = normalize(JSON.parse(raw) as Partial<VideoPrefs>)
  } catch {
    // 存储损坏:用默认
  }
  return cache
}

/** 修改偏好:key 缺省写共享层,key 指定写个性化层;派发事件(带 key 时
 * 订阅方只对匹配的视频生效,其它视频不受影响) */
export function setVideoPrefs(patch: Partial<VideoPrefs>, key?: string): VideoPrefs {
  if (key) {
    const ind = readIndividual()
    const base = ind[key] ?? loadVideoPrefs()
    const next = normalize({
      volume: patch.volume !== undefined ? patch.volume : base.volume,
      speed: patch.speed !== undefined ? patch.speed : base.speed,
      loop: patch.loop !== undefined ? patch.loop : base.loop,
    })
    ind[key] = next
    writeIndividual(ind)
    document.dispatchEvent(new CustomEvent(VIDEO_PREFS_EVENT, { detail: { ...next, key } }))
    return { ...next }
  }
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

/** 订阅偏好变化(双向同步);返回取消订阅函数。
 * detail 可选带 key(个性化):订阅方自行过滤(与自身 key 不匹配的忽略) */
export function onVideoPrefsChange(cb: (p: VideoPrefs & { key?: string }) => void): () => void {
  const handler = (e: Event) => {
    cb((e as CustomEvent<VideoPrefs & { key?: string }>).detail ?? loadVideoPrefs())
  }
  document.addEventListener(VIDEO_PREFS_EVENT, handler)
  return () => document.removeEventListener(VIDEO_PREFS_EVENT, handler)
}

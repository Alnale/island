/**
 * 音频播放偏好(2026-08-12 用户要求"像视频一样操控单条音频的播放与否、
 * 音量以及是否循环"——与 videoPrefs 同构,无 speed/全屏):
 * - **共享层** localStorage `widget-audio-prefs`(跨会话,所有语音气泡共用);
 * - **个性化层** localStorage `widget-audio-individual` = { [key]: prefs }——
 *   传入 key(音频名 = media part alt,与 getConversationMedia 的 name
 *   同源)时按**单条音频**读写,无个性化记录回退共享层;
 *   修改经派发 `island:audio-prefs` 事件,detail 带 key(个性化)或缺省
 *   (共享),订阅方按 key 匹配过滤——调一条音频不影响其它音频。
 */

export interface AudioPrefs {
  /** 音量 0-1 */
  volume: number
  /** 循环播放 */
  loop: boolean
}

const STORAGE_KEY = 'widget-audio-prefs'
const INDIVIDUAL_KEY = 'widget-audio-individual'
export const AUDIO_PREFS_EVENT = 'island:audio-prefs'

let cache: AudioPrefs | null = null

/** 归一化(钳制音量) */
function normalize(p: Partial<AudioPrefs>): AudioPrefs {
  return {
    volume: Math.min(1, Math.max(0, typeof p.volume === 'number' ? p.volume : 1)),
    loop: Boolean(p.loop),
  }
}

function readIndividual(): Record<string, AudioPrefs> {
  try {
    const raw = localStorage.getItem(INDIVIDUAL_KEY)
    if (!raw) return {}
    const map = JSON.parse(raw) as Record<string, Partial<AudioPrefs>>
    const out: Record<string, AudioPrefs> = {}
    for (const [k, v] of Object.entries(map)) {
      if (v && typeof v === 'object') out[k] = normalize(v)
    }
    return out
  } catch {
    return {}
  }
}

function writeIndividual(map: Record<string, AudioPrefs>): void {
  try {
    localStorage.setItem(INDIVIDUAL_KEY, JSON.stringify(map))
  } catch {
    // 忽略存储失败
  }
}

/**
 * 读取播放偏好:
 * - key 缺省 = 共享层(cache 提速,所有语音气泡共用);
 * - key 指定 = 该音频的个性化(缺省回退共享层)。
 */
export function loadAudioPrefs(key?: string): AudioPrefs {
  if (key) {
    const ind = readIndividual()
    const p = ind[key]
    if (p) return normalize({ ...loadAudioPrefs(), ...p })
    return loadAudioPrefs()
  }
  if (cache) return cache
  cache = normalize({})
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) cache = normalize(JSON.parse(raw) as Partial<AudioPrefs>)
  } catch {
    // 存储损坏:用默认
  }
  return cache
}

/** 修改偏好:key 缺省写共享层,key 指定写个性化层;派发事件(带 key 时
 * 订阅方只对匹配的音频生效,其它音频不受影响) */
export function setAudioPrefs(patch: Partial<AudioPrefs>, key?: string): AudioPrefs {
  if (key) {
    const ind = readIndividual()
    const base = ind[key] ?? loadAudioPrefs()
    const next = normalize({
      volume: patch.volume !== undefined ? patch.volume : base.volume,
      loop: patch.loop !== undefined ? patch.loop : base.loop,
    })
    ind[key] = next
    writeIndividual(ind)
    document.dispatchEvent(new CustomEvent(AUDIO_PREFS_EVENT, { detail: { ...next, key } }))
    return { ...next }
  }
  const p = loadAudioPrefs()
  if (patch.volume !== undefined) p.volume = Math.min(1, Math.max(0, patch.volume))
  if (patch.loop !== undefined) p.loop = patch.loop
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // 忽略存储失败
  }
  document.dispatchEvent(new CustomEvent(AUDIO_PREFS_EVENT, { detail: { ...p } }))
  return { ...p }
}

/** 订阅偏好变化(双向同步);返回取消订阅函数。
 * detail 可选带 key(个性化):订阅方自行过滤(与自身 key 不匹配的忽略) */
export function onAudioPrefsChange(cb: (p: AudioPrefs & { key?: string }) => void): () => void {
  const handler = (e: Event) => {
    cb((e as CustomEvent<AudioPrefs & { key?: string }>).detail ?? loadAudioPrefs())
  }
  document.addEventListener(AUDIO_PREFS_EVENT, handler)
  return () => document.removeEventListener(AUDIO_PREFS_EVENT, handler)
}

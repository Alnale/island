/**
 * 歌词 API 提供商配置(渲染端;localStorage 持久化)
 *
 * 预设:QQ音乐(默认)/ 网易云音乐 / 酷我音乐 / 酷狗音乐 / 自定义。
 * **按监听平台自动切换**:SMTC 识别平台(qqmusic/netease/kugou/kuwo) →
 * 对应歌词 API(PLATFORM_LYRIC_MAP);浏览器等无对应平台时回退手动配置。
 * 请求时把 provider 传给本地桥接(/system-media/lyric),由桥接按厂商
 * 实现搜索+歌词(渲染端无 CORS 限制问题)。打开歌词后播放键下方提示
 * 显示对应厂商名。
 */

export interface LyricProvider {
  id: string
  /** 厂商显示名(提示用,如"QQ音乐"/"网易云音乐") */
  name: string
  type: 'netease' | 'qq' | 'kuwo' | 'kugou' | 'custom'
  /** 自定义:URL 模板,{title}/{artist} 占位替换 */
  url?: string
}

/** 预设厂家(设置视图选择;QQ音乐为默认接入点) */
export const LYRIC_PROVIDERS: readonly LyricProvider[] = [
  { id: 'qq', name: 'QQ音乐', type: 'qq' },
  { id: 'netease', name: '网易云音乐', type: 'netease' },
  { id: 'kuwo', name: '酷我音乐', type: 'kuwo' },
  { id: 'kugou', name: '酷狗音乐', type: 'kugou' },
  { id: 'custom', name: '自定义', type: 'custom', url: '' },
]

/** SMTC 监听平台 → 歌词厂商(自动切换;汽水/浏览器等无公开歌词 API 的
 * 平台不映射,回退手动配置) */
export const PLATFORM_LYRIC_MAP: Record<string, string> = {
  qqmusic: 'qq',
  netease: 'netease',
  kugou: 'kugou',
  kuwo: 'kuwo',
}

export const LYRIC_PROVIDER_KEY = 'widget-lyric-provider'
/** 自动切换开关(localStorage;默认开启:按监听平台自动换对应厂商 API) */
export const LYRIC_AUTO_KEY = 'widget-lyric-auto'

export function loadLyricAuto(): boolean {
  try {
    const v = localStorage.getItem(LYRIC_AUTO_KEY)
    if (v !== null) return v !== '0'
  } catch {
    // 忽略存储失败
  }
  return true // 默认开启
}

export function saveLyricAuto(on: boolean) {
  try {
    localStorage.setItem(LYRIC_AUTO_KEY, on ? '1' : '0')
  } catch {
    // 忽略存储失败
  }
}

export function findProvider(id: string): LyricProvider {
  return LYRIC_PROVIDERS.find((p) => p.id === id && p.type !== 'custom') ?? LYRIC_PROVIDERS[0]
}

export function loadLyricProvider(): LyricProvider {
  try {
    const raw = JSON.parse(localStorage.getItem(LYRIC_PROVIDER_KEY) ?? 'null') as LyricProvider | null
    if (raw && typeof raw.id === 'string') {
      const preset = findProvider(raw.id)
      if (preset) return preset
      // 自定义:保留 url
      if (raw.id === 'custom') return { id: 'custom', name: '自定义', type: 'custom', url: raw.url ?? '' }
    }
  } catch {
    // 损坏配置回退默认
  }
  return LYRIC_PROVIDERS[0]
}

export function saveLyricProvider(p: LyricProvider) {
  try {
    localStorage.setItem(LYRIC_PROVIDER_KEY, JSON.stringify(p))
  } catch {
    // 忽略存储失败
  }
}

/**
 * 解析实际使用的歌词厂商:
 * - 自动切换**开启**(默认)→ 监听平台有对应厂商(QQ/网易云/酷狗/酷我)
 *   自动切换;无对应(本地播放/浏览器/汽水等)回退手动配置;
 * - 自动切换**关闭** → 一直按手动选择生效,平台变化不影响
 */
export function resolveLyricProvider(platformId: string | null | undefined): LyricProvider {
  if (loadLyricAuto() && platformId && PLATFORM_LYRIC_MAP[platformId]) {
    return findProvider(PLATFORM_LYRIC_MAP[platformId])
  }
  return loadLyricProvider()
}

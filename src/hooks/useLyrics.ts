import { useEffect, useRef, useState } from 'react'

/** 本地桥接歌词代理地址(scripts/system-media-bridge.ts 提供) */
const LYRIC_BASE = 'http://127.0.0.1:8765/system-media/lyric'
const REQUEST_TIMEOUT_MS = 6000

export interface LyricLine {
  time: number
  text: string
}

export interface LyricsState {
  /** 是否正在查询 */
  loading: boolean
  /** 歌词对应的歌名(与实际匹配的搜索结果可能略异) */
  lyricTitle: string | null
  lines: LyricLine[]
  /** 当前播放位置对应的歌词行索引(-1 表示尚无匹配) */
  currentIndex: number
}

/**
 * 歌词字幕:按当前曲目(歌名/歌手)自动查询 LRC 歌词,
 * 播放位置变化时计算当前高亮行。
 * 歌词代理走本地桥接(Node 服务端无 CORS 限制)。
 */
export function useLyrics(
  title: string | null,
  artist: string | null,
  position: number,
  active: boolean,
): LyricsState {
  const [loading, setLoading] = useState(false)
  const [lyricTitle, setLyricTitle] = useState<string | null>(null)
  const [lines, setLines] = useState<LyricLine[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const lastKeyRef = useRef('')

  // 曲目变化 → 查询歌词(缓存由桥接承担)
  useEffect(() => {
    if (!active || !title) {
      setLines([])
      setLyricTitle(null)
      lastKeyRef.current = ''
      return
    }
    const key = `${title}|${artist ?? ''}`
    if (key === lastKeyRef.current) return
    lastKeyRef.current = key
    setLoading(true)
    setLines([])
    const params = new URLSearchParams({ title, artist: artist ?? '' })
    fetch(`${LYRIC_BASE}?${params.toString()}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
      .then(async (res) => {
        if (!res.ok) {
          setLines([])
          setLyricTitle(null)
          return
        }
        const data = (await res.json()) as { title: string; lines: LyricLine[] }
        setLines(data.lines ?? [])
        setLyricTitle(data.title ?? title)
      })
      .catch(() => {
        setLines([])
        setLyricTitle(null)
      })
      .finally(() => setLoading(false))
  }, [active, title, artist])

  // 播放位置 → 当前歌词行
  useEffect(() => {
    if (lines.length === 0) {
      setCurrentIndex(-1)
      return
    }
    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= position) idx = i
      else break
    }
    setCurrentIndex(idx)
  }, [lines, position])

  return { loading, lyricTitle, lines, currentIndex }
}

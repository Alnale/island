/**
 * 输入框底字:她写下的一句印在文字背后。
 * 新的一句按字落下(打印);已经盖住的字不再重印。
 * 用户每多一个码元,就盖住她的一个字,并在字面上迸开一团能看见的光。
 * 删字只把外层透明度拉回来,不重播打印。
 * 她的一句盖完之后再打的字没有字面可盖:粒子照打,颜色改主题色。
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { MindWhisper, MindWhisperKind } from '../../../agent/types'

/** 高饱和三色:说 / 望 / 纯,压在深色输入底上能分开 */
export const MIND_INK: Record<MindWhisperKind, string> = {
  say: '#FF2E88',
  hope: '#3DFFF3',
  pure: '#D6FF3C',
}

const SPARK_COUNT = 12

/** 一次快打/粘贴最多迸几团,再多糊成一片(盖字与打字两段共用)。 */
const SPLASH_MAX = 6

/** 主题色取不到时的兜底,与 Agent 发送键同色。 */
const THEME_INK_FALLBACK = '#4d6bfe'

/** 新对话/尚无底字时的空句:0 字可盖,打字粒子全走主题色路径。
 *  固定引用避免每渲染重建。kind 只在盖字路径用到,空句用不到。 */
const EMPTY_WHISPER: MindWhisper = { kind: 'pure', text: '' }

/** 光核比底字更亮,迸开时才看得出是这一色。 */
const MIND_HOT: Record<MindWhisperKind, string> = {
  say: '#FFD0EA',
  hope: '#F4FFFE',
  pure: '#FFF6B0',
}

interface Burst {
  id: number
  x: number
  y: number
  color: string
  hot: string
  delay: number
}

interface MindWhisperFieldProps {
  /** 她的一句。null = 新对话/尚无底字:0 字可盖,打字粒子全走主题色。 */
  whisper: MindWhisper | null
  typed: string
  /** 她写下这一句的时刻。0 = 存档恢复,直接摆上,不打印。 */
  revealAt: number
  textareaRef: RefObject<HTMLTextAreaElement | null>
}

/** 刚落定的一句才打印。展开面板若已过这窗口,句子是静置的。 */
const PRINT_FRESH_MS = 1500

/** 前几个字按 30ms 错开,后面收紧,避免长句把输入框占住。 */
function printDelay(order: number): number {
  if (order < 10) return order * 30
  return 10 * 30 + (order - 10) * 14
}

function codepoints(value: string): string[] {
  return Array.from(value)
}

function sparkShift(id: number, index: number): {
  dx: number
  dy: number
  size: number
  delay: number
  hot: boolean
  streak: boolean
  rot: number
} {
  const deg = (index * (360 / SPARK_COUNT) + ((id * 13) % 24)) % 360
  const turn = deg * (Math.PI / 180)
  const far = index % 3 === 0
  const dist = far ? 26 + ((id + index) % 4) * 4 : 12 + ((id + index * 2) % 5) * 3
  return {
    dx: Math.cos(turn) * dist,
    dy: Math.sin(turn) * dist - 6,
    size: far ? 3 : index % 4 === 0 ? 5.5 : 4,
    delay: (index % 5) * 16,
    hot: index % 3 === 1,
    streak: index % 4 === 2,
    rot: deg,
  }
}

/** 没有底字可盖那段的粒子用主题色(岛的强调色 --state-color),
 *  光核混白压亮,与三色墨水同一配比。 */
function themeInk(host: HTMLElement): { color: string; hot: string } {
  const color =
    getComputedStyle(host).getPropertyValue('--state-color').trim() || THEME_INK_FALLBACK
  return { color, hot: `color-mix(in srgb, ${color} 30%, #fff)` }
}

/** 她的一句之后再打的字没有字面可量:搭一行隐藏镜像(同字体/同内边距/
 *  同折行,内容框与 textarea 对齐),按码元量出落点,量完即弃。
 *  返回值按 [from, to) 对齐,量不出的位(行尾换行等)为 null。 */
function measureTailSpots(
  layer: HTMLElement,
  area: HTMLTextAreaElement | null,
  hostBox: DOMRect,
  typedChars: string[],
  from: number,
  to: number,
): Array<{ x: number; y: number } | null> {
  const spots: Array<{ x: number; y: number } | null> = new Array(to - from).fill(null)
  const mirror = document.createElement('div')
  mirror.className = 'island-mind-whisper-line island-mind-measure'
  mirror.setAttribute('aria-hidden', 'true')
  mirror.textContent = typedChars.slice(0, to).join('')
  // 镜像行跟 textarea 同步滚动,量到的才是屏上位置
  if (area) mirror.style.transform = `translateY(${-area.scrollTop}px)`
  layer.appendChild(mirror)
  const node = mirror.firstChild
  if (node) {
    // 码元 → UTF-16 偏移:astral 字符(emoji 等)占两个单元
    const offsets: number[] = []
    let cursor = 0
    for (let i = 0; i < to; i++) {
      offsets.push(cursor)
      cursor += typedChars[i].length
    }
    const range = document.createRange()
    for (let i = from; i < to; i++) {
      range.setStart(node, offsets[i])
      range.setEnd(node, offsets[i] + typedChars[i].length)
      const rect = range.getBoundingClientRect()
      if (rect.width < 1 && rect.height < 1) continue
      spots[i - from] = {
        x: rect.left - hostBox.left + rect.width / 2,
        y: rect.top - hostBox.top + rect.height / 2,
      }
    }
  }
  mirror.remove()
  return spots
}

export function MindWhisperField({
  whisper: whisperProp,
  typed,
  revealAt,
  textareaRef,
}: MindWhisperFieldProps) {
  // 无她的底字(新对话/尚无底字)按空句处理:0 字可盖 → 打字粒子全走主题色
  const whisper = whisperProp ?? EMPTY_WHISPER
  const layerRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  const charRefs = useRef<Array<HTMLSpanElement | null>>([])
  /** 上一次的打字码元总数(不是 covered——盖满之后还要接着记打字) */
  const prevTyped = useRef<number | null>(null)
  const seenText = useRef(whisper.text)
  const nextId = useRef(1)
  const scheduled = useRef(new Set<number>())
  const timersRef = useRef<number[]>([])
  const [bursts, setBursts] = useState<Burst[]>([])
  const [burstHost, setBurstHost] = useState<HTMLElement | null>(null)
  const chars = codepoints(whisper.text)
  const typedChars = codepoints(typed)
  const typedLen = typedChars.length
  const covered = Math.min(typedLen, chars.length)
  const lastReveal = useRef<number | null>(null)
  const originRef = useRef(0)
  const printingRef = useRef(false)
  if (lastReveal.current !== revealAt) {
    lastReveal.current = revealAt
    originRef.current = covered
    printingRef.current = revealAt > 0 && Date.now() - revealAt < PRINT_FRESH_MS
  }
  const printing = printingRef.current
  const printOrigin = originRef.current
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let printOrder = 0

  useLayoutEffect(() => {
    setBurstHost(layerRef.current?.parentElement ?? null)
  }, [])

  useLayoutEffect(() => {
    const area = textareaRef.current
    const line = lineRef.current
    if (!area || !line) return
    const sync = () => {
      line.style.transform = `translateY(${-area.scrollTop}px)`
    }
    sync()
    area.addEventListener('scroll', sync, { passive: true })
    return () => area.removeEventListener('scroll', sync)
  }, [textareaRef, whisper.text, revealAt])

  useLayoutEffect(() => {
    // 数组在 effect 内推导:依赖只挂原始值,免得每渲染都重跑
    const chars = codepoints(whisper.text)
    const typedChars = codepoints(typed)
    const next = typedChars.length
    if (prevTyped.current === null || seenText.current !== whisper.text) {
      prevTyped.current = next
      seenText.current = whisper.text
      return
    }
    const prev = prevTyped.current
    // 无增量(删除/持平)与减动效:推进基线但不迸
    if (next <= prev) {
      prevTyped.current = next
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      prevTyped.current = next
      return
    }
    // 瞬态守卫(面板刚展开、还没量到盒子)不推进基线:这一拍打字留到布局
    // 稳定后补迸,否则新对话第一次打字正好落在展开中就被吞掉、不再重试
    const layer = layerRef.current
    const host = layer?.parentElement
    if (!layer || !host) return
    const box = host.getBoundingClientRect()
    if (box.width < 1) return
    prevTyped.current = next
    const born: Burst[] = []
    // 进可视带外的落点不迸:滚动到看不见的字,粒子会飘在输入框外
    const stamp = (x: number, y: number, color: string, hot: string, order: number) => {
      if (x < -4 || x > box.width + 4 || y < -4 || y > box.height + 4) return
      born.push({ id: nextId.current++, x, y, color, hot, delay: order * 28 })
    }
    // ① 还有字可盖:原样——落点是被盖的那个字,墨色随她的种类
    const coverEnd = Math.min(next, chars.length, prev + SPLASH_MAX)
    for (let i = prev; i < coverEnd; i++) {
      const el = charRefs.current[i]
      if (!el) continue
      const rect = el.getBoundingClientRect()
      stamp(
        rect.left - box.left + rect.width / 2,
        rect.top - box.top + rect.height / 2,
        MIND_INK[whisper.kind],
        MIND_HOT[whisper.kind],
        i - prev,
      )
    }
    // ② 打过她最后一个字:没有字面可盖,同款粒子照打,颜色改主题色
    const tailFrom = Math.max(prev, chars.length)
    const tailTo = Math.min(next, tailFrom + (SPLASH_MAX - born.length))
    if (tailTo > tailFrom) {
      const ink = themeInk(host)
      const spots = measureTailSpots(layer, textareaRef.current, box, typedChars, tailFrom, tailTo)
      spots.forEach((spot, k) => {
        if (spot) stamp(spot.x, spot.y, ink.color, ink.hot, tailFrom + k - prev)
      })
    }
    if (born.length === 0) return
    setBursts((list) => [...list, ...born].slice(-8))
  }, [typed, whisper.kind, whisper.text, textareaRef])

  useEffect(() => {
    for (const burst of bursts) {
      if (scheduled.current.has(burst.id)) continue
      scheduled.current.add(burst.id)
      const timer = window.setTimeout(() => {
        scheduled.current.delete(burst.id)
        setBursts((list) => list.filter((item) => item.id !== burst.id))
      }, 460 + burst.delay)
      timersRef.current.push(timer)
    }
  }, [bursts])
  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer)
  }, [])

  return (
    <div
      ref={layerRef}
      className="island-mind-whisper"
      data-kind={whisper.kind}
      style={{ ['--mind-ink' as string]: MIND_INK[whisper.kind] }}
      aria-hidden="true"
    >
      <div key={`${whisper.text}:${revealAt}`} ref={lineRef} className="island-mind-whisper-line">
        {chars.map((ch, index) => {
          const stamp = printing && index >= printOrigin
          const delay = stamp && !reduceMotion ? printDelay(printOrder) : 0
          if (stamp) printOrder += 1
          return (
            <span
              key={`${whisper.text}-${index}`}
              ref={(el) => {
                charRefs.current[index] = el
              }}
              className={index < covered ? 'island-mind-ch is-covered' : 'island-mind-ch'}
            >
              <span
                className={stamp ? 'island-mind-ink is-printing' : 'island-mind-ink'}
                style={stamp ? { animationDelay: `${delay}ms` } : undefined}
              >
                {ch}
              </span>
            </span>
          )
        })}
      </div>
      {burstHost
        ? createPortal(
            <div className="island-mind-burst-layer" aria-hidden="true">
              {bursts.map((burst) => (
                <span
                  key={burst.id}
                  className="island-mind-burst"
                  style={{ left: burst.x, top: burst.y }}
                >
                  <span
                    className="island-mind-ring"
                    style={{
                      borderColor: burst.color,
                      animationDelay: `${burst.delay}ms`,
                      boxShadow: `0 0 10px ${burst.color}`,
                    }}
                  />
                  <span
                    className="island-mind-core"
                    style={{
                      background: burst.hot,
                      animationDelay: `${burst.delay}ms`,
                      boxShadow: `0 0 12px ${burst.color}`,
                    }}
                  />
                  {Array.from({ length: SPARK_COUNT }, (_, index) => {
                    const shift = sparkShift(burst.id, index)
                    return (
                      <span
                        key={index}
                        className={shift.streak ? 'island-mind-spark is-streak' : 'island-mind-spark'}
                        style={{
                          background: shift.hot ? burst.hot : burst.color,
                          width: shift.streak ? undefined : shift.size,
                          height: shift.streak ? undefined : shift.size,
                          animationDelay: `${burst.delay + shift.delay}ms`,
                          boxShadow: `0 0 ${shift.hot ? 10 : 7}px ${shift.hot ? burst.hot : burst.color}`,
                          ['--dx' as string]: `${shift.dx.toFixed(1)}px`,
                          ['--dy' as string]: `${shift.dy.toFixed(1)}px`,
                          ['--rot' as string]: `${shift.rot}deg`,
                        }}
                      />
                    )
                  })}
                </span>
              ))}
            </div>,
            burstHost,
          )
        : null}
    </div>
  )
}

import { useLayoutEffect, useRef } from 'react'
import { rgba } from '../../utils/color'

/** 与悬停进度条同长(base.css .island-extra 0.28s)。条先回到开头,火花再收干净。 */
export const PROGRESS_REWIND_MS = 280
/** 被扫过的粒子再淡这么久,避免条停住时火花被掐掉 */
const LIFT_MS = 220

/** 岛体缓出 cubic-bezier(0.22, 1, 0.36, 1)。回退是旧进度离场,用缓出。 */
function islandEaseOut(amount: number): number {
  if (amount <= 0) return 0
  if (amount >= 1) return 1
  const x1 = 0.22
  const y1 = 1
  const x2 = 0.36
  const y2 = 1
  let t = amount
  for (let i = 0; i < 6; i++) {
    const u = 1 - t
    const x = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t
    const dx = 3 * u * u * x1 + 6 * u * t * (x2 - x1) + 3 * t * t * (1 - x2)
    if (Math.abs(dx) < 1e-6) break
    t = Math.min(1, Math.max(0, t - (x - amount) / dx))
  }
  const u = 1 - t
  return 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t
}

function normalizeHex(color: string): string | null {
  if (!color.startsWith('#')) return null
  if (color.length === 7) return color
  if (color.length === 4) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
  }
  return null
}

interface Mote {
  /** 落在旧进度上的位置(px),等回退前端扫过才脱落 */
  anchor: number
  /** 1 向上,-1 向下,成对,不随机乱飞 */
  side: 1 | -1
  size: number
  born: number
}

/**
 * 切歌时盖在进度条上:把 --progress-ratio 从当前比例缓出到 0。
 * 粒子沿旧进度等距排好,被回退的前端扫过才脱落(光晕 + 白芯,与粒子时间同族)。
 * 父元素必须是写着 --progress-ratio 的那条进度热区。
 */
export function ProgressRewindLayer({ from, onDone }: { from: number; onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    if (!canvas || !host) {
      onDoneRef.current()
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      host.style.setProperty('--progress-ratio', '0')
      onDoneRef.current()
      return
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      host.style.setProperty('--progress-ratio', '0')
      onDoneRef.current()
      return
    }
    const theme =
      getComputedStyle(host).getPropertyValue('--state-color').trim() || '#4ade80'
    const hex = normalizeHex(theme)
    const halo = hex ? rgba(hex, 0.42) : theme

    let motes: Mote[] = []
    let seededW = 0
    const start = performance.now()
    let raf = 0
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      host.style.setProperty('--progress-ratio', '0')
      onDoneRef.current()
    }

    const seed = (origin: number) => {
      const count = Math.min(80, Math.max(12, Math.round(origin / 4.5)))
      const next: Mote[] = []
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count
        next.push({
          anchor: origin * t,
          side: i % 2 === 0 ? 1 : -1,
          // 每四颗一颗稍大,有节奏,不是大小乱跳
          size: i % 4 === 0 ? 1.15 : 0.72,
          born: -1,
        })
      }
      return next
    }

    const tick = (now: number) => {
      if (finished) return
      const w = host.clientWidth
      const h = host.clientHeight
      if (w < 2 || h < 2) {
        if (now - start > 240) finish()
        else raf = requestAnimationFrame(tick)
        return
      }
      if (seededW !== w) {
        const origin = Math.min(1, Math.max(0, from)) * w
        motes = seed(origin)
        seededW = w
        canvas.width = Math.floor(w * dpr)
        canvas.height = Math.floor(h * dpr)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }

      const amount = Math.min(1, (now - start) / PROGRESS_REWIND_MS)
      const ratio = from * (1 - islandEaseOut(amount))
      host.style.setProperty('--progress-ratio', ratio.toFixed(4))
      const head = ratio * w
      const mid = h / 2

      ctx.clearRect(0, 0, w, h)

      let alive = false
      // 先光晕,再白芯:和粒子时间一样分两遍,避免每颗都换色
      for (let pass = 0; pass < 2; pass++) {
        for (const mote of motes) {
          if (mote.born < 0) {
            if (head <= mote.anchor) mote.born = now
            else continue
          }
          const age = (now - mote.born) / LIFT_MS
          if (age >= 1) continue
          alive = true
          const e = islandEaseOut(Math.min(1, Math.max(0, age)))
          const fade = (1 - e) * (1 - e)
          const x = mote.anchor - e * 5
          const y = mid + mote.side * (1.2 + e * 5.5)
          if (pass === 0) {
            ctx.globalAlpha = fade * 0.9
            ctx.fillStyle = halo
            ctx.beginPath()
            ctx.arc(x, y, 2.5 * mote.size, 0, Math.PI * 2)
            ctx.fill()
          } else {
            ctx.globalAlpha = fade
            ctx.fillStyle = '#fff'
            ctx.beginPath()
            ctx.arc(x, y, 0.85 * mote.size, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }

      // 回退前端:一颗实芯,身后留下刚空出来的那一段淡尾
      if (amount < 1) {
        for (let i = 5; i >= 1; i--) {
          ctx.globalAlpha = 0.22 * (1 - i / 6)
          ctx.fillStyle = halo
          ctx.beginPath()
          ctx.arc(head + i * 3.2, mid, 1.6, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.globalAlpha = 0.55
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(head, mid, 3.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.arc(head, mid, 1.35, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1

      if (amount < 1 || alive) raf = requestAnimationFrame(tick)
      else finish()
    }

    host.style.setProperty('--progress-ratio', String(from))
    raf = requestAnimationFrame(tick)
    return () => {
      finished = true
      cancelAnimationFrame(raf)
    }
  }, [from])

  return <canvas ref={canvasRef} className="island-progress-rewind-particles" aria-hidden="true" />
}

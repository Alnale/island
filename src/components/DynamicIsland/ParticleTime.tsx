import { useCallback, useEffect, useRef, useState } from 'react'
import { formatTime } from '../../utils/format'
import { rgba } from '../../utils/color'

/** 粒子数量上限:采样过密时自动加大采样步长。
 *  提高上限让采样步长保持在 2~3(粒子间距 ~1.5px),字形更密更清晰;
 *  过少(420)会把步长推到 4+,字形稀疏发虚 */
const MAX_PARTICLES = 1200
/** 画布左右留白(粒子浮动空间) */
const PAD_PX = 8
/** 画布高度(容纳大字 + 光晕浮动) */
const HEIGHT_PX = 36
/** 粒子时间字号:比岛内普通文字(0.95rem)更大,细字重,字形更轻盈 */
const TIME_FONT = '300 26px system-ui, -apple-system, "Segoe UI", sans-serif'

interface Particle {
  x: number
  y: number
  tx: number
  ty: number
  phase: number
}

interface ParticleTimeProps {
  /** 显示的秒数(拖动中的进度/播放中的当前时间) */
  seconds: number
  /** 画布水平位置相对岛 padding-box 左缘的偏移(px):
   *  居中模式传入的是"画布中心"(紧凑态标题文字区域),
   *  内联模式不需要定位(作为 flex 子元素参与布局) */
  centerX: number
  /** 光晕颜色(跟随灵动岛状态色) */
  color: string
  /** 内联模式:canvas 脱离绝对定位,作为 flex 子元素参与布局
   *  (展开面板中与歌名同行右对齐,不重叠) */
  inline?: boolean
}

/**
 * 粒子时间:拖动进度条时,左侧文字变为粒子拼成的当前时间。
 * 时间字符串先栅格化到离屏画布,按透明度采样出粒子目标点;
 * 粒子以阻尼逼近目标,时间变化(拖动经过分钟边界)时自动"变形"到新数字。
 * 组件仅在拖动期间挂载,卸载即停止动画。
 */
export function ParticleTime({ seconds, centerX, color, inline = false }: ParticleTimeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const offRef = useRef<HTMLCanvasElement | null>(null)
  const particlesRef = useRef<Particle[]>([])
  const oldTargetsRef = useRef<Array<{ tx: number; ty: number }>>([])
  const lastTextRef = useRef('')
  const rafRef = useRef(0)
  const colorRef = useRef(color)
  colorRef.current = color
  const [size, setSize] = useState({ w: 0, h: HEIGHT_PX })

  /** 栅格化时间字符串 → 粒子目标点(自适应步长,粒子数封顶) */
  const rasterize = useCallback(
    (text: string) => {
      const off = offRef.current
      if (!off) return null
      const dpr = window.devicePixelRatio || 1
      const ctx = off.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.font = TIME_FONT
      const textW = ctx.measureText(text).width
      const w = Math.ceil(textW) + PAD_PX * 2
      const h = HEIGHT_PX
      off.width = Math.ceil(w * dpr)
      off.height = Math.ceil(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.font = TIME_FONT
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#fff'
      ctx.fillText(text, PAD_PX, h / 2 + 1) // +1 光学居中
      const img = ctx.getImageData(0, 0, off.width, off.height).data
      let step = 2
      let targets: Array<{ tx: number; ty: number }> = []
      do {
        targets = []
        for (let y = 0; y < off.height; y += step) {
          for (let x = 0; x < off.width; x += step) {
            if (img[(y * off.width + x) * 4 + 3] > 120) {
              targets.push({ tx: x / dpr, ty: y / dpr })
            }
          }
        }
        step += 1
      } while (targets.length > MAX_PARTICLES && step <= 8)
      return { targets, w, h }
    },
    [],
  )

  /** 应用新目标点:粒子数量与目标一致,不足的从旧字形区域附近出生
   *  (时间变化时粒子平滑流入新字形,避免随机撒点的"爆闪"),多余的直接截断 */
  const applyTargets = useCallback(
    (text: string) => {
      const canvas = canvasRef.current
      const result = rasterize(text)
      if (!canvas || !result) return
      const { targets, w, h } = result
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.ceil(w * dpr) || canvas.height !== Math.ceil(h * dpr)) {
        // 设置 width/height 会清空画布,下一帧即重绘
        canvas.width = Math.ceil(w * dpr)
        canvas.height = Math.ceil(h * dpr)
        setSize({ w, h })
      }
      const particles = particlesRef.current
      const oldTargets = oldTargetsRef.current
      while (particles.length > targets.length) particles.pop()
      while (particles.length < targets.length) {
        const t = targets[particles.length]
        // 出生点:旧字形随机目标点 + 抖动(旧字形还在时平滑变形),
        // 首次渲染退化为全画布随机
        const old = oldTargets.length > 0
          ? oldTargets[Math.floor(Math.random() * oldTargets.length)]
          : null
        particles.push({
          x: old ? old.tx + (Math.random() - 0.5) * 16 : PAD_PX + Math.random() * (w - PAD_PX * 2),
          y: old ? old.ty + (Math.random() - 0.5) * 16 : Math.random() * h,
          tx: t.tx,
          ty: t.ty,
          phase: Math.random() * Math.PI * 2,
        })
      }
      for (let i = 0; i < targets.length; i++) {
        const p = particles[i]
        p.tx = targets[i].tx
        p.ty = targets[i].ty
      }
      oldTargetsRef.current = targets
    },
    [rasterize],
  )

  // 挂载:初始化目标点并启动动画循环
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    offRef.current = document.createElement('canvas')
    const dpr = window.devicePixelRatio || 1
    // 用挂载时刻的初始秒数(拖动开始的瞬间)
    lastTextRef.current = formatTime(seconds)
    applyTargets(lastTextRef.current)

    const tick = (now: number) => {
      const t = now / 1000
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
        for (const p of particlesRef.current) {
          p.x += (p.tx - p.x) * 0.14
          p.y += (p.ty - p.y) * 0.14
          const px = p.x + Math.sin(t * 3 + p.phase) * 0.4
          const py = p.y + Math.cos(t * 2.2 + p.phase) * 0.4
          // 光晕(跟随状态色),细字用更小的弥散半径
          ctx.fillStyle = rgba(colorRef.current, 0.3)
          ctx.beginPath()
          ctx.arc(px, py, 3, 0, Math.PI * 2)
          ctx.fill()
          // 白色核心(半径略大,字形更实)
          ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
          ctx.beginPath()
          ctx.arc(px, py, 1.5, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafRef.current)
      particlesRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyTargets])

  // 时间变化(拖动跨秒/跨分钟):重新栅格化,粒子向新数字变形
  useEffect(() => {
    const text = formatTime(seconds)
    if (text === lastTextRef.current) return
    lastTextRef.current = text
    applyTargets(text)
  }, [seconds, applyTargets])

  return (
    <canvas
      ref={canvasRef}
      className={`island-time-particles${inline ? ' island-time-particles--inline' : ''}`}
      aria-hidden="true"
      style={{ left: centerX, width: size.w, height: size.h }}
    />
  )
}

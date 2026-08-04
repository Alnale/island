import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { clamp01, hexToHsv, hsvToHex } from './layout'

/**
 * 岛内自绘取色器(SV 面 + 色相条):字体颜色 / 主题色共用。
 * value 变化(预设 / hex 外部修改)时同步归位;拖拽期间以本地为准,
 * 避免 8bit 量化往返换算导致光标抖动。不弹系统对话框,UI 不出岛
 */
export function IslandColorPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (hex: string) => void
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const svRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)
  const pickingRef = useRef(false)
  useEffect(() => {
    if (pickingRef.current) return
    setHsv(hexToHsv(value))
  }, [value])
  const apply = (next: { h: number; s: number; v: number }) => {
    setHsv(next)
    onChange(hsvToHex(next.h, next.s, next.v))
  }
  const hsvFromPointer = (
    el: HTMLDivElement,
    event: ReactPointerEvent<HTMLDivElement>,
  ): { h: number; s: number; v: number } | null => {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const x = clamp01((event.clientX - rect.left) / rect.width)
    const y = clamp01((event.clientY - rect.top) / rect.height)
    return { h: hsv.h, s: x, v: 1 - y }
  }
  const capture = (el: HTMLDivElement, event: ReactPointerEvent<HTMLDivElement>) => {
    // 捕获失败(合成事件等异常指针)不阻塞取色,拖动越界功能降级为按下取色
    try {
      el.setPointerCapture(event.pointerId)
    } catch {
      /* 忽略捕获失败 */
    }
  }
  const isCaptured = (el: HTMLDivElement, event: ReactPointerEvent<HTMLDivElement>): boolean => {
    try {
      return el.hasPointerCapture(event.pointerId)
    } catch {
      return false
    }
  }
  const handleEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pickingRef.current = false
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      /* 忽略释放失败 */
    }
  }
  const handleSvDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return // 右键只属于挂件拖拽
    event.preventDefault()
    event.stopPropagation() // 不冒泡为岛体长按
    capture(event.currentTarget, event)
    pickingRef.current = true
    const next = hsvFromPointer(event.currentTarget, event)
    if (next) apply(next)
  }
  const handleSvMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isCaptured(event.currentTarget, event)) return
    const next = hsvFromPointer(event.currentTarget, event)
    if (next) apply(next)
  }
  const applyHue = (el: HTMLDivElement, event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    apply({ ...hsv, h: clamp01((event.clientX - rect.left) / rect.width) * 360 })
  }
  const handleHueDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    capture(event.currentTarget, event)
    pickingRef.current = true
    applyHue(event.currentTarget, event)
  }
  const handleHueMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isCaptured(event.currentTarget, event)) return
    applyHue(event.currentTarget, event)
  }
  return (
    <>
      {/* 取色面:横向 = 饱和度(白→纯色),纵向 = 明度(纯色→黑),
          指针拖动即取色(pointer capture,拖出面板也持续响应) */}
      <div
        ref={svRef}
        className="island-font-sv"
        style={{ '--sv-hue': `${hsv.h}deg` } as CSSProperties}
        onPointerDown={handleSvDown}
        onPointerMove={handleSvMove}
        onPointerUp={handleEnd}
        onPointerCancel={handleEnd}
      >
        <span
          className="island-font-sv-cursor"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
          aria-hidden="true"
        />
      </div>
      {/* 色相条:横向渐变,拖动选色相 */}
      <div
        ref={hueRef}
        className="island-font-hue"
        onPointerDown={handleHueDown}
        onPointerMove={handleHueMove}
        onPointerUp={handleEnd}
        onPointerCancel={handleEnd}
      >
        <span
          className="island-font-hue-thumb"
          style={{ left: `${(hsv.h / 360) * 100}%` }}
          aria-hidden="true"
        />
      </div>
    </>
  )
}

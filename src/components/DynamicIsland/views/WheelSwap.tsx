/**
 * 滚轮切换内容交换动画(快捷切换按钮 / 记忆类型按钮共用):
 * 旧内容滑出淡出、新内容回弹滑入——精致缓动,替代生硬的机械跳格。
 * 方向 = 滚轮方向:向前(dir 1,滚轮向下)新内容自下而上,向后自上而下。
 *
 * 2026-08-18 重构(设计规范:频繁触发交互用 transition 而非 keyframes):
 * 原实现以 key={tick} 每次重挂载重放 @keyframes——快速连续滚轮时旧动画
 * 未播完即被卸载,内容"闪烁/倒带"。现改为常驻两层 + 双帧 class 驱动的
 * CSS transition:
 * - 稳态:out 层(displayed)与 in 层(children)同内容叠放,显示新值;
 * - tick 变化 → 加 .swap(首帧初始态,transition 关闭瞬移:out 显示位、
 *   in 在外部)→ 下一帧加 .animate(目标态,transition 开启)平滑过渡;
 * - 动画结束 → 静默把 out 层内容同步为最新 children、移除 .swap 复位;
 * - 快速滚动:动画中再次 tick 只更新 in 层内容,过渡被重定向平滑续接,
 *   不清除动画定时器(swapRef 标记避免重置 out 层造成内容跳变)。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

/** 动画总时长(ms):覆盖 CSS 中 in 层 0.22s 过渡,结束后复位状态 */
const SWAP_ANIM_MS = 240

export function WheelSwap({
  tick,
  dir,
  prev,
  children,
}: {
  /** 步进计数:变化即触发一次交换 */
  tick: number
  /** 本次切换方向(1 = 向前; -1 = 向后) */
  dir: 1 | -1
  /** 切换前的旧内容(null = 尚无切换) */
  prev: ReactNode | null
  /** 新内容 */
  children: ReactNode
}) {
  // out 层当前展示的内容:初始 = 当前值;动画开始置为切换前内容;结束同步为新值
  const [displayed, setDisplayed] = useState<ReactNode>(children)
  // 动画阶段:swap = 初始态帧(transition 关闭瞬移);animate = 目标态帧(过渡)
  const [swapping, setSwapping] = useState(false)
  const [animate, setAnimate] = useState(false)
  const childrenRef = useRef<ReactNode>(children)
  childrenRef.current = children
  const prevRef = useRef<ReactNode>(prev)
  prevRef.current = prev
  // 动画进行中标记:快速滚动时避免重复重置(否则 out 层内容跳变 + 清掉定时器)
  const swapRef = useRef(false)
  // 当前动画的 rAF/定时器句柄(卸载清理用;快速滚动续接时不清除)
  const animRef = useRef<{ raf: number; timer: number } | null>(null)

  useEffect(() => {
    if (tick <= 0) return
    // 已在动画中(快速连续滚轮):只更新 in 层内容,过渡被重定向续接,不重置
    if (swapRef.current) return
    // 开始交换:out 层置为切换前内容,进入初始态帧(无 transition,瞬移到位)
    setDisplayed(prevRef.current ?? childrenRef.current)
    setSwapping(true)
    setAnimate(false)
    swapRef.current = true
    // 下一帧加 .animate,触发 transition 从初始态过渡到目标态
    const raf = requestAnimationFrame(() => setAnimate(true))
    const timer = window.setTimeout(() => {
      swapRef.current = false
      setSwapping(false)
      setAnimate(false)
      setDisplayed(childrenRef.current)
      animRef.current = null
    }, SWAP_ANIM_MS)
    animRef.current = { raf, timer }
  }, [tick])

  // 2026-08-18 修复偶现"多个菜单文本重叠":外部直接改 value 但 tick 不变
  // (如 LLM 工具/设置同步直接改 QuickMenu 的 value)时,children 变化而
  // 常驻 out 层(displayed)仍是旧值,稳态下 out/in 两层不同文本叠加显示。
  // 这里在非动画期静默把 displayed 同步为最新 children;动画中交给结束
  // timer 统一同步(避免动画中途跳变 out 层内容)
  useEffect(() => {
    if (swapRef.current) return
    setDisplayed(childrenRef.current)
  }, [children])

  // 卸载时清理未完成动画(避免切面板后残留定时器)
  useEffect(
    () => () => {
      if (animRef.current) {
        cancelAnimationFrame(animRef.current.raf)
        window.clearTimeout(animRef.current.timer)
      }
    },
    [],
  )

  return (
    <span
      className={`island-wheel-swap${swapping ? ' swap' : ''}${animate ? ' animate' : ''}${dir < 0 ? ' back' : ''}`}
    >
      <span className="island-wheel-swap-out" aria-hidden="true">
        {displayed}
      </span>
      <span className="island-wheel-swap-in">{children}</span>
    </span>
  )
}

/**
 * WheelSwap 内容交换动画状态机
 * (2026-08-07 审计 P1:原 4 处「tick/prev/dir 状态舞蹈」逐字重复——
 * 快捷按钮 / 记忆类型按钮 / 缩放步进器 / 帮助手册模式按钮收敛;
 * 手感契约(每 60px 一步等)在 useWheelSteps,此处只管动画状态)
 *
 * - tick:每步 +1(消费方以 key={tick} 重挂载子元素重放交换动画,
 *   tick > 0 时加 .tick 类触发柔和强调闪动);
 * - prev:切换前的旧内容(WheelSwap 旧层滑出淡出);
 * - dir:切换方向(新内容自下而上 / 自上而下);
 * - step(oldValue, direction):触发一次交换——prev 置为旧值、方向记录、
 *   tick+1。**值本身由消费方更新**(本 hook 只管动画状态)
 */

import { useCallback, useState } from 'react'

export function useWheelSwap<T>(): {
  tick: number
  dir: 1 | -1
  prev: T | null
  step: (oldValue: T, direction: 1 | -1) => void
} {
  const [tick, setTick] = useState(0)
  const [prev, setPrev] = useState<T | null>(null)
  const [dir, setDir] = useState<1 | -1>(1)
  const step = useCallback((oldValue: T, direction: 1 | -1) => {
    setPrev(oldValue)
    setDir(direction)
    setTick((t) => t + 1)
  }, [])
  return { tick, dir, prev, step }
}

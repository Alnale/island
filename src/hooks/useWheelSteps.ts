/**
 * 滚轮逐格步进器 —— 快捷切换按钮(AgentView)与记忆类型按钮
 * (AgentSettingsView)共用,保证两处滚轮手感完全一致:
 * - 每 60px 一步(行模式 deltaMode=1 换算 33px/行,统一按像素累积);
 * - 步间 ≥100ms 冷却(顿挫 tick 动画播完才允许下一步,快速滚动也
 *   逐格推进,不连跳);
 * - 350ms 无滚动重置累积(甩动残留不带到下一轮滚动)。
 *
 * 返回本次应推进的方向(1 = 向下滚 → 下一项;-1 = 向上滚 → 上一项;
 * 0 = 未到阈值)。方向恒为 ±1(单次事件最多一步)。
 */

import { useCallback, useRef, type WheelEvent } from 'react'

/** 一步的滚轮像素阈值 / 步间冷却 / 无滚动重置窗口 */
const STEP_PX = 60
const STEP_COOLDOWN_MS = 100
const RESET_IDLE_MS = 350

export function useWheelSteps() {
  const accRef = useRef(0)
  const lastStepAtRef = useRef(0)
  const lastWheelAtRef = useRef(0)
  return useCallback((event: WheelEvent): 0 | 1 | -1 => {
    event.stopPropagation()
    const now = performance.now()
    if (now - lastWheelAtRef.current > RESET_IDLE_MS) accRef.current = 0
    lastWheelAtRef.current = now
    // 行模式(部分鼠标 deltaMode=1)换算成像素,统一按像素累积
    accRef.current += event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY
    if (Math.abs(accRef.current) >= STEP_PX && now - lastStepAtRef.current >= STEP_COOLDOWN_MS) {
      const dir: 1 | -1 = accRef.current > 0 ? 1 : -1
      accRef.current -= dir * STEP_PX
      lastStepAtRef.current = now
      return dir
    }
    return 0
  }, [])
}

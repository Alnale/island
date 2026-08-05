/**
 * 滚轮切换内容交换动画(快捷切换按钮 / 记忆类型按钮共用):
 * 旧内容滑出淡出、新内容回弹滑入——精致缓动,替代生硬的机械跳格
 * (0.3s 轻微过冲回弹,与设置视图 island-ui-in 同款曲线)。
 * 方向 = 滚轮方向:向前(dir 1,滚轮向下)新内容自下而上,向后自上而下。
 *
 * key = tick:每格重挂载重放动画;`.swap` 类仅在 tick > 0(首次步进后)
 * 加——首帧挂载不播动画(设置视图进入/面板展开时不闪动)。
 * 旧内容层 absolute + 容器 overflow hidden:滑动过程不外溢。
 */

import type { ReactNode } from 'react'

export function WheelSwap({
  tick,
  dir,
  prev,
  children,
}: {
  /** 步进计数:变化即重挂载重放动画 */
  tick: number
  /** 本次切换方向(1 = 向前; -1 = 向后) */
  dir: 1 | -1
  /** 旧内容(首次步进前的初始内容;null = 尚无切换) */
  prev: ReactNode | null
  /** 新内容 */
  children: ReactNode
}) {
  return (
    <span
      key={tick}
      className={`island-wheel-swap${tick > 0 ? ' swap' : ''}${dir < 0 ? ' back' : ''}`}
    >
      <span className="island-wheel-swap-out" aria-hidden="true">
        {prev}
      </span>
      <span className="island-wheel-swap-in">{children}</span>
    </span>
  )
}

/**
 * 离场动画列表管理(2026-08-07 审计 P2:原 ~6 处「标记 leaving →
 * 260ms 后提交 → 取消标记」定时器模式收敛——会话历史行/工具禁用行、
 * 记忆条目/技能行/MCP 卡片等)
 *
 * - leavingIds:正在播离场动画的条目(渲染时挂 leaving 类);
 * - beginLeave(id, commit):标记离场并启动 260ms 定时器,到期执行
 *   commit(真正删除/提交)后取消标记;重复触发同一 id 忽略;
 * - 卸载时清理全部未完成定时器(动画未播完即卸载不残留)。
 *
 * 备注:AgentView 输入候选的倒序 stagger 退场(240 + n×30 总时长、重复
 * 触发重置计时)语义不同,不并入本 hook。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const LEAVE_MS = 260

export function useLeavingList() {
  const [leavingIds, setLeavingIds] = useState<readonly string[]>([])
  const timersRef = useRef<Map<string, number>>(new Map())

  const beginLeave = useCallback((id: string, commit: () => void) => {
    setLeavingIds((prev) => {
      if (prev.includes(id)) return prev
      return [...prev, id]
    })
    timersRef.current.set(
      id,
      window.setTimeout(() => {
        commit()
        timersRef.current.delete(id)
        setLeavingIds((prev) => prev.filter((x) => x !== id))
      }, LEAVE_MS),
    )
  }, [])

  // 卸载时清理离场定时器(动画未完成即卸载不残留)
  useEffect(
    () => () => {
      for (const t of timersRef.current.values()) window.clearTimeout(t)
      timersRef.current.clear()
    },
    [],
  )

  return { leavingIds, beginLeave }
}

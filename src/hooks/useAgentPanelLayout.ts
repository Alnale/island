/**
 * useAgentPanelLayout —— Agent 面板岛体高度/界面缩放布局
 * (2026-08-07 从 DynamicIsland 抽出,审计 P0 纯搬移,零行为变化;
 * 高度动画状态机首次可独立测试)
 *
 * 职责:
 * - 岛体高度(--agent-h 变量):AgentView 测量回调写入目标值,JS 动画
 *   rAF + easeOutCubic 逼近(60fps 动画直接写 DOM 变量,不经 React
 *   state,不触发整岛重渲染),每帧上报显示高度给宿主跟随窗口;
 * - 界面缩放(100-300%):等比例放大展开态 UI(UI 元素不缩放),
 *   localStorage 持久化,LLM 设置工具(set_agent_scale)即时生效;
 * - 进入 agent 视图入口高度从紧凑 56 滑升到面板下限、缩放变化即时
 *   同步窗口宽度。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { AGENT_SCALE_STORAGE_KEY, onSettingsChange, readAgentScale } from '../settingsBridge'
import {
  AGENT_PANEL_MIN_H,
  AGENT_SETTINGS_H,
  AGENT_WIDTH_ANIMATE_MS,
  ISLAND_COMPACT_H,
  ISLAND_PANEL_H,
} from '../components/DynamicIsland/layout'

export interface AgentPanelLayoutParams {
  /** 岛体 DOM(ref 写 --agent-h 变量与 CSS 变量) */
  islandRef: RefObject<HTMLDivElement | null>
  /** 当前面板视图(非 agent 时高度重置/动画停摆) */
  panelView: string
  /** 展开态逻辑宽度(缩放前的基准) */
  expandedWidth: number
  /** 是否展开(缩放同步窗口宽度的前提) */
  expanded: boolean
  /** Agent 模式是否激活(agent prop 存在即激活) */
  agentActive: boolean
  /** 宿主回调:窗口跟随岛体尺寸(宽 × 缩放、高不乘) */
  onAgentPanelSize?(width: number, height: number): void
  /** 宿主回调:缩放变化即时同步窗口宽度 */
  onAgentPanelWidth?(width: number): void
}

export function useAgentPanelLayout(params: AgentPanelLayoutParams): {
  /** 岛体高度目标值 setter(AgentView 测量写入;高度动画在 hook 内驱动,
   * 组件侧只消费 setter) */
  setAgentPanelH: (h: number) => void
  /** 界面缩放(100-300,百分比) */
  agentScale: number
  handleAgentScaleChange: (scale: number) => void
  /** 高度动画就绪(宽度动画完成,2026-08-08 串行展开):组件侧据此
   * 延迟挂载 AgentView——宽度动画期间 compact 内容保持可见,
   * 面板(覆盖岛体)在高度动画开始时才挂载,避免宽条岛体全透明 */
  agentHReady: boolean
} {
  const {
    islandRef,
    panelView,
    expandedWidth,
    expanded,
    agentActive,
    onAgentPanelSize,
    onAgentPanelWidth,
  } = params

  // Agent 面板岛体高度(px,逻辑值,作为**动画目标**):内容自适应
  // (AgentView 测量回调写入),默认下限留一点空;离开 agent 视图重置,
  // 下次进入重新测量
  const [agentPanelH, setAgentPanelH] = useState(AGENT_PANEL_MIN_H)
  useEffect(() => {
    if (panelView !== 'agent') setAgentPanelH(AGENT_PANEL_MIN_H)
  }, [panelView])
  // 高度动画就绪标记(2026-08-08 用户要求"先宽后高"串行展开):进入
  // agent 视图后宽度动画(MORPH_ANIMATE_MS)期间高度保持紧凑 56(宽条),
  // 宽度动画完成才置 true → 高度动画启动(JS 动画 56 → 目标,窗口跟随)
  const [agentHReady, setAgentHReady] = useState(false)
  const agentHReadyTimerRef = useRef(0)
  useEffect(
    () => () => window.clearTimeout(agentHReadyTimerRef.current),
    [],
  )
  // ---- Agent 面板高度动画(2026-08-06 v1 回退:并行动画 CSS 方案在软件
  // 渲染下仍卡,回到 JS 驱动——内容变化经 rAF + easeOutQuart 逼近,直接写
  // DOM 的 --agent-h 变量(不经 React state,60fps 动画不触发整岛重渲染);
  // 时长随距离自适应(小步快跟、大步滑行),中途重定向从当前显示值无缝续动;
  // 每帧上报显示高度给宿主,窗口逐帧跟随。
  // **曲线/时长(2026-08-09 优化"展开不够平滑")**:easeOutCubic 收尾偏硬
  // (速度在末段仍快,观感"机械"),换 easeOutQuart((1-t)^4 收尾更缓更柔);
  // 时长公式 100+dist×3.5 在大步时钳 380ms 仍偏长(总时长被拉长),改
  // 120+dist×1.5 钳 [140, 340]——展开 56→200 约 336ms,从容且与宽度
  // (0.3s)衔接无空等;流式小步(几 px)约 140ms 保持跟追灵敏 ----
  const agentHDispRef = useRef(ISLAND_COMPACT_H)
  const agentHAnimRef = useRef<{ raf: number } | null>(null)
  // 直接写 --agent-h(60fps 动画不经 React state);入口直设也走这里
  const setAgentHVar = useCallback((v: number) => {
    agentHDispRef.current = v
    const el = islandRef.current
    if (el) el.style.setProperty('--agent-h', `${Math.round(v)}px`)
  }, [islandRef])
  const animateAgentH = useCallback((to: number, report: (h: number) => void) => {
    const el = islandRef.current
    if (!el) return
    if (agentHAnimRef.current) cancelAnimationFrame(agentHAnimRef.current.raf)
    const from = agentHDispRef.current
    const apply = (v: number) => {
      setAgentHVar(v)
      report(Math.round(v))
    }
    // 同步落起点(var 缺省会命中 CSS fallback 闪一帧高)
    apply(from)
    const dist = Math.abs(to - from)
    if (dist < 1) {
      apply(to)
      return
    }
    // 时长单位**毫秒**(now - startAt 也是毫秒)
    const duration = Math.min(340, Math.max(140, 120 + dist * 1.5))
    const startAt = performance.now()
    // easeOutQuart:开始快、收尾极缓,展开动作"丝滑"而非"戛然而止"
    const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4)
    const tick = (now: number) => {
      // t 钳制 [0,1]:首帧 rAF 时间戳可能略早于 performance.now()
      const t = Math.min(1, Math.max(0, (now - startAt) / duration))
      apply(from + (to - from) * easeOutQuart(t))
      if (t < 1) agentHAnimRef.current = { raf: requestAnimationFrame(tick) }
      else agentHAnimRef.current = null
    }
    agentHAnimRef.current = { raf: requestAnimationFrame(tick) }
  }, [setAgentHVar, islandRef])
  // 卸载时取消未完成的动画帧
  useEffect(
    () => () => {
      if (agentHAnimRef.current) cancelAnimationFrame(agentHAnimRef.current.raf)
    },
    [],
  )
  // 进入 agent 视图 / Agent 设置视图:入口高度 **JS 动画**滑升(与宽度
  // 同步增长——直设会瞬间 56→200,形变开始时宽度还在紧凑值,出现窄高
  // 矩形,实测 bug)。
  // - agent 视图:从紧凑 56 滑升到面板下限,窗口**不做逐帧上报**(形变
  //   期间只报一次,避免软件渲染逐帧 setSize 全幅重绘;岛体 ≤ 窗口不
  //   裁剪),内容测量后窗口跟随;
  // - agent-settings 视图(2026-08-07 用户要求"参考 Agent 展开的先变宽
  //   再变长动画"):从**当前显示高度**滑升到固定 540(起点 = 上次 agent
  //   面板显示值,从未进过 = 展开面板 244 = settings 视图高度——不再
  //   重置为紧凑 56,否则从设置视图切入会先"缩到 56 再长高",实测观感
  //   倒退),**逐帧上报窗口跟随**(与内容动画同步滑升,无"窗口先就位、
  //   岛体还在长"的割裂)
  useLayoutEffect(() => {
    const isPanel = panelView === 'agent' || panelView === 'agent-settings'
    if (!isPanel) {
      setAgentHReady(false)
      window.clearTimeout(agentHReadyTimerRef.current)
      if (agentHAnimRef.current) cancelAnimationFrame(agentHAnimRef.current.raf)
      agentHAnimRef.current = null
      // 离开 agent 视图后岛体高度由 CSS 回到展开面板 244(基础规则):
      // 同步显示值,settings → agent-settings 的入口起点才准确
      // (agent → agent-settings 直接切不经过这里,保留 agent 显示值)
      agentHDispRef.current = ISLAND_PANEL_H
      return
    }
    const s = agentScale / 100
    const w = Math.round(expandedWidth * s)
    if (panelView === 'agent') {
      // 串行展开(2026-08-08 用户要求:先执行宽度展开动画,再执行高度
      // 展开动画,然后伴随滚动):进入 agent 视图**只启动宽度动画**——
      // 高度保持紧凑 56(宽条),窗口只变宽(高保持紧凑);宽度动画
      // 完成(MORPH_ANIMATE_MS)后置 agentHReady → 下方高度动画 effect
      // 启动,56 滑升到测量目标,窗口逐帧跟随;AgentView 的进入滚动
      // 同步延迟(伴随高度展开)
      agentHDispRef.current = ISLAND_COMPACT_H
      setAgentHVar(ISLAND_COMPACT_H)
      setAgentHReady(false)
      window.clearTimeout(agentHReadyTimerRef.current)
      // 宽度动画完成即置位(2026-08-09:原 MORPH_ANIMATE_MS 400ms 计时
      // vs 宽度过渡 240ms,宽度到位后空等 160ms 高度才启动——顿点;
      // 现与宽度同步,无缝进入高度动画)
      agentHReadyTimerRef.current = window.setTimeout(
        () => setAgentHReady(true),
        AGENT_WIDTH_ANIMATE_MS,
      )
      onAgentPanelSize?.(w, ISLAND_COMPACT_H)
    } else {
      // agent-settings 视图保持原并行逻辑(从当前显示高度滑升到固定 540)
      setAgentHReady(false)
      window.clearTimeout(agentHReadyTimerRef.current)
      const startH = Math.max(agentHDispRef.current, ISLAND_PANEL_H)
      agentHDispRef.current = startH
      animateAgentH(AGENT_SETTINGS_H, (h) => onAgentPanelSize?.(w, h))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在视图切换时触发
  }, [panelView])

  // Agent 面板界面缩放(百分比 100-300,最低 100%):等比例缩放展开态 UI。
  // 持久化 localStorage;视觉尺寸 = 逻辑值 × 缩放,窗口由宿主跟随。
  // 默认 200%(用户要求:初次安装初次进入 Agent 模式时默认放大——小屏
  // 挂件默认 100% 观感偏小;已有 localStorage(用户改过)保留原值)
  // 缩放初始化与设置桥共用 readAgentScale(收敛两处独立 clamp,审计 P2)
  const [agentScale, setAgentScale] = useState(() => readAgentScale())
  const handleAgentScaleChange = useCallback((scale: number) => {
    const clamped = Math.min(300, Math.max(100, Math.round(scale)))
    setAgentScale(clamped)
    try {
      localStorage.setItem(AGENT_SCALE_STORAGE_KEY, String(clamped))
    } catch {
      // 忽略存储失败
    }
  }, [])
  // LLM 设置工具(set_agent_scale,经设置桥写 localStorage)的即时生效:
  // 监听设置变更的 scale 域,从存储重读缩放状态(typed 包装:事件名/
  // scope/注销统一,见 settingsBridge.onSettingsChange)
  useEffect(
    () =>
      onSettingsChange(['scale'], () => {
        try {
          const v = Number(localStorage.getItem(AGENT_SCALE_STORAGE_KEY))
          if (Number.isFinite(v) && v >= 100 && v <= 300) setAgentScale(Math.round(v))
        } catch {
          // 忽略存储失败
        }
      }),
    [],
  )
  // 目标/缩放/宽度变化:JS 动画从当前显示值无缝重定向(流式 80ms 测量
  // 节拍连续到达,动画持续跟追目标)。宿主回调须引用稳定;animateAgentH
  // 引用稳定(useCallback []);声明在 agentScale 之后——依赖数组渲染期求值。
  // **agentHReady 门闩(2026-08-08 串行展开)**:宽度动画完成前不启动
  // 高度动画(保持紧凑 56);agentHReady 置 true 或目标变化时触发,
  // 从当前显示值滑升到最新目标(展开瞬间的测量值已在宽度动画期间就绪)。
  // **窗口不逐帧跟随(2026-08-08 用户要求"至少视觉 160 帧")**:高度动画
  // 开始时窗口**一次性 resize 到最终尺寸**(岛体 ≤ 窗口不裁剪,透明区
  // 无视觉),动画期间窗口不动——软件渲染下逐帧 setSize 全幅重绘是
  // "肉眼可见卡"的根源;流式测量(目标变化)时再一次性重设,低频
  useLayoutEffect(() => {
    if (panelView !== 'agent') return
    if (!agentHReady) return
    const s = agentScale / 100
    const w = Math.round(expandedWidth * s)
    onAgentPanelSize?.(w, agentPanelH)
    animateAgentH(agentPanelH, () => {})
  }, [agentPanelH, agentScale, expandedWidth, onAgentPanelSize, panelView, agentHReady, animateAgentH])
  // 缩放变化立即同步窗口宽度(无论当前面板视图——设置视图里切缩放
  // 也要即时看到放大效果;高度由各视图回调管理)
  useEffect(() => {
    if (!agentActive || !expanded) return
    onAgentPanelWidth?.(Math.round(expandedWidth * (agentScale / 100)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅缩放/展开变化时触发
  }, [agentScale, expanded])

  return { setAgentPanelH, agentScale, handleAgentScaleChange, agentHReady }
}

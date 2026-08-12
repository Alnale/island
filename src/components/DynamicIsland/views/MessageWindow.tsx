/**
 * 消息列表虚拟滚动窗口(2026-08-12 新增,修复"100+ 条消息滚动到中间
 * 抽搐"——用户实测:全量渲染下消息 DOM 数千节点,挂件禁用硬件加速
 * 软件渲染,滚动中部每帧绘制成本随内容全长增长 = 掉帧抽搐;且滚动条
 * 没有"按消息压缩"。原理 = **窗口化**:只挂载可视区 ± overscan 的
 * 消息,其余高度由上下两个 spacer 撑起,滚动条按真实内容比例显示。
 *
 * 设计要点:
 * - **高度缓存** Map<id, px>:挂载消息经 ResizeObserver 实测(消息内部
 *   高度变化——工具卡片展开、媒体 aspect 修正、文本重排——自动跟踪);
 *   滚动经过的区域全部真实化,重挂载直接复用(滚动回来不再测量)。
 * - **未测消息用角色预估**(user 64 / assistant 150):测量前的滚动条
 *   估算;滚动经过时一次只真实化一条——content-visibility 是滚动中
 *   整段真实化(累计高度修正 = 滚动条抽搐),本方案逐条平滑修正。
 * - **spacer 数学**:top = offset(start) − gap、bottom = total −
 *   offset(end) − gap(offset(i) = 更早消息高度和 + 每条后一个 gap),
 *   窗口 div 布局高恒等于虚拟总高(可证:top + gap + 渲染段 + gap +
 *   bottom 展开即 total)——AgentView 的岛体高度测量(children
 *   offsetHeight 求和)因此无需改动,直接量窗口 div。
 * - **零重渲染的布局更新**:高度变化(RO)只直写 spacer + 贴底校正,
 *   不 setState;只有可视范围变化(滚动/岛体长高)才重渲染挂载区。
 *   滚动中挂载区 ~15 条消息,软件渲染绘制成本与内容全长解耦。
 * - **贴底保持**:atBottom(用户没上翻)时消息测量推高内容 → 同步
 *   scrollTop = scrollHeight;上翻查看历史时不打扰。
 * - **宽度变化**(展开/缩放动画)→ 已挂载消息因换行变化高度自动重测
 *   (消息 RO 观察含宽度,换行 → 高度变化 → 回调),屏外消息保留旧
 *   宽度缓存、滚动经过时重挂载重测——比整清缓存更准且零重渲染。
 * - **离开副本**(scrollRef 缺省,视图切换离场动画):不绑定滚动/测量,
 *   固定渲染顶部 INITIAL_RENDER 条作淡出视觉残留(原全量渲染,长历史
 *   下太贵)。
 * - 已知取舍:屏外消息卸载 → 工具卡片的展开状态不保留(滚走再滚回
 *   折叠),媒体不挂载(桥 list_conversation_media 只列可视区附件)。
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { AgentMessage } from '../../../agent/types'

/** 未测消息的预估高度(px):测量前的滚动条估算。user 气泡短文本
 * ~40-90,assistant 含文本段 + 脚注 ~120-200(媒体/工具汇总更高),
 * 取中值;误差只在首次滚动经过时按条平滑修正 */
const EST_USER_H = 64
const EST_ASSIST_H = 150

/** 顶部 overscan 条数:往上滚的预渲染缓冲(快速回滚先看到内容再测量) */
const OVERSCAN_TOP = 3
/** 底部 overscan 高度(px):媒体消息超高(400-700px),按高度向前挂载
 * 保证贴底时媒体已渲染(跳底后媒体就位,滚动条末端不虚) */
const OVERSCAN_BOTTOM = 600

/** 初始渲染条数:主实例挂载即被 useLayoutEffect 按可视范围修正;
 * 离开副本(scrollRef 缺省)就用此固定条数渲染顶部 */
const INITIAL_RENDER = 12

/** 预估高度(模块级,稳定引用供 useCallback 链) */
function estH(m: AgentMessage): number {
  return m.role === 'user' ? EST_USER_H : EST_ASSIST_H
}

export const MessageWindow = memo(function MessageWindow({
  messages,
  scrollRef,
  atBottomRef,
  onLayoutChange,
  renderItem,
}: {
  messages: AgentMessage[]
  /** 滚动容器(.island-agent-messages);离开副本传 undefined */
  scrollRef?: RefObject<HTMLDivElement | null>
  /** 贴底标志(AgentView 维护:滚动/发送时更新;高度变化时据此保持贴底) */
  atBottomRef?: RefObject<boolean>
  /** 内容总高变化回调 → AgentView 重测岛体高度 */
  onLayoutChange?: () => void
  /** 单条消息渲染(AgentView 提供,useCallback 稳定引用) */
  renderItem: (m: AgentMessage) => ReactNode
}) {
  // 可视范围 [start, end):滚动/岛体尺寸变化时重算,范围外消息卸载
  const [range, setRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: INITIAL_RENDER,
  })
  // 高度缓存 id → px:挂载消息经 ResizeObserver 实测
  const heightsRef = useRef<Map<string, number>>(new Map())
  // 运行时 gap(px):与 .island-agent-messages 的 CSS gap 对齐,挂载时读取
  const gapRef = useRef(10)
  // 可变数据经 ref 访问:updateLayout 空依赖链保持稳定(不打穿渲染路径)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const onLayoutChangeRef = useRef(onLayoutChange)
  onLayoutChangeRef.current = onLayoutChange
  const roRef = useRef<ResizeObserver | null>(null)
  const rafRef = useRef(0)
  const lastTotalRef = useRef(0)
  const lastRangeRef = useRef({ start: 0, end: 0 })
  const topSpacerRef = useRef<HTMLDivElement>(null)
  const bottomSpacerRef = useRef<HTMLDivElement>(null)
  const winRef = useRef<HTMLDivElement>(null)
  // 首次布局标志:首帧贴底优先(滚动位置尚未按内容校正,直接按底部
  // 计算可视范围——否则先显示顶部消息一帧再跳底,展开观感闪烁)
  const firstInitRef = useRef(true)

  /** 重算可视范围与 spacer(线性一次遍历;滚动/岛体尺寸/消息高度变化
   * 后调用)。范围变化 → setState(挂载/卸载消息);高度变化只直写
   * spacer(零 React 重渲染,滚动中流畅的关键) */
  const updateLayout = useCallback(() => {
    const scroller = scrollRef?.current
    if (!scroller || !atBottomRef) return
    const msgs = messagesRef.current
    const heights = heightsRef.current
    const gap = gapRef.current
    const n = msgs.length
    const clientH = scroller.clientHeight
    if (n === 0) {
      // 空列表(新对话/清除数据):清空高度缓存(旧会话 id 不再出现)
      heights.clear()
      lastTotalRef.current = 0
      if (lastRangeRef.current.start !== 0 || lastRangeRef.current.end !== 0) {
        lastRangeRef.current = { start: 0, end: 0 }
        setRange({ start: 0, end: 0 })
      }
      return
    }
    // 总高(含每条消息后一个 gap;未测消息用预估)
    let total = 0
    for (let i = 0; i < n; i++) total += (heights.get(msgs[i].id) ?? estH(msgs[i])) + gap
    // 有效可视位置:首帧贴底优先(此时 scrollTop 还没按内容校正)。
    // **必须真正写入 scrollTop**(不能只改局部范围计算):否则滚动条
    // 停在顶部、可视区显示 top spacer 空白,而 AgentView 的跳底
    // effect(150ms 定时器)是唯一的兜底,偶发竞态下贴底链断裂
    // (实测:200 条注入后偶发停在中间,内容可见但滚动条在顶部)
    const firstInit = firstInitRef.current
    firstInitRef.current = false
    let scrollTop = scroller.scrollTop
    if (firstInit && atBottomRef.current && total > clientH) {
      scrollTop = total - clientH
      scroller.scrollTop = scrollTop
    }
    // **滚动位置钳制到有效范围(2026-08-12 实测修复"贴底链断裂"核心)**:
    // 贴底(scrollTop = scrollHeight)后测量收敛会令 total 变小——下一帧
    // 读取的 scrollTop 瞬时**大于**内容总高,start 循环 `acc + h > scrollTop`
    // 恒 false → start=0(全量渲染)+ spacer 直写 0/0 → win 高塌缩 →
    // 浏览器把 scrollTop clamp 到塌缩后的小值,内容总高恢复后 scrollTop
    // 不再恢复 = 滚动停在中间(实测 200 条注入后停在 ~145 条处,手动
    // 滚动能到尾部)。在 start 循环前把 scrollTop 钳到
    // [0, total - clientH],贴底语义由 atBottomRef 分支保持
    if (scrollTop > total - clientH) scrollTop = Math.max(0, total - clientH)
    // 找 start:第一条 offset(i) + h(i) 越过可视区顶部,再回退 overscan 条
    let acc = 0
    let start = 0
    for (let i = 0; i < n; i++) {
      const h = heights.get(msgs[i].id) ?? estH(msgs[i])
      if (acc + h > scrollTop) {
        start = i
        break
      }
      acc += h + gap
    }
    if (start > 0) start = Math.max(0, start - OVERSCAN_TOP)
    // end:从 start 累加直到 offset 越过可视区底部 + overscan
    let end = start
    let offAcc = 0
    for (let i = 0; i < start; i++) offAcc += (heights.get(msgs[i].id) ?? estH(msgs[i])) + gap
    for (let i = start; i < n; i++) {
      if (offAcc > scrollTop + clientH + OVERSCAN_BOTTOM) break
      offAcc += (heights.get(msgs[i].id) ?? estH(msgs[i])) + gap
      end = i + 1
    }
    // **媒体消息常驻(2026-08-13 用户实测"下方出现几个新消息就要从头
    // 播放,所有状态丢失")**:含 media part 的消息(视频/音频气泡)即使
    // 滚出可视区也不卸载——否则播放中的视频被卸载销毁,进度/音量/倍速/
    // 播放态全丢;新消息插入下方把媒体顶出 overscan 是主场景。媒体
    // 消息数量少,常驻成本可接受;渲染范围扩到覆盖全部媒体消息
    for (let i = 0; i < n; i++) {
      const parts = (msgs[i] as AgentMessage).parts
      if (Array.isArray(parts) && parts.some((p) => p && p.type === 'media')) {
        if (i < start) start = i
        if (i + 1 > end) end = i + 1
      }
    }
    // start 的虚拟偏移(重新累加;消息数百-数千,微秒级,无需前缀和缓存)
    let sOff = 0
    for (let i = 0; i < start; i++) sOff += (heights.get(msgs[i].id) ?? estH(msgs[i])) + gap
    // end 之后的偏移(媒体常驻扩大的范围不再收缩)
    let off = sOff
    for (let i = start; i < end; i++) off += (heights.get(msgs[i].id) ?? estH(msgs[i])) + gap
    // spacer 数学:窗口布局高恒等于 total(组件头注释有推导)
    const top = start > 0 ? sOff - gap : 0
    const bottom = end < n ? total - off - gap : 0
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${Math.max(0, top)}px`
    if (bottomSpacerRef.current) bottomSpacerRef.current.style.height = `${Math.max(0, bottom)}px`
    const changed = start !== lastRangeRef.current.start || end !== lastRangeRef.current.end
    lastRangeRef.current = { start, end }
    if (changed) setRange({ start, end })
    // 内容总高变化(消息测量真实化/媒体加载/工具卡片展开)才动作:
    // ① 贴底保持——用户贴底时(atBottomRef,事件驱动:onScroll 按距底
    //    48px 判定,程序跳底触发 scroll 事件后恒 true)同步滚到新底部
    //    (上翻查看历史时不打扰;贴底只发生在高度变化时,滚动本身不
    //    强制——用户拖到"距底 20px"不会被吸到底部);
    //    注意:不能按"当前几何距底"判定——内容增长后距底天然变大,
    //    用户并未上翻,几何判定会把贴底链切断(实测:200 条注入后
    //    停在 ~145 条处,手动滚动能到尾部)
    // ② 通知外部重测岛体(滚动本身不改变总高,避免滚动中每帧 reflow)
    if (total !== lastTotalRef.current) {
      lastTotalRef.current = total
      if (atBottomRef.current) scroller.scrollTop = scroller.scrollHeight
      onLayoutChangeRef.current?.()
    }
  }, [scrollRef, atBottomRef])

  /** rAF 合帧的布局更新(滚动事件/RO 高频触发时合并到每帧一次) */
  const scheduleLayout = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      updateLayout()
    })
  }, [updateLayout])

  /** 尺寸观察:
   * - 消息高度变化(工具卡片展开、媒体 aspect 修正、文本重排、宽度
   *   动画中的换行变化)→ 更新高度缓存 + 重算布局——**宽度变化无需
   *   整清缓存**:已挂载消息因换行变化自身高度变化,RO 自动回调重测;
   *   屏外消息保留旧宽度缓存,滚动经过时重挂载重测(比全预估更准);
   * - 窗口尺寸变化(岛体长高)→ 重算范围(可视区变大,挂载更多消息)。
   * 窗口宽度变化本身(展开/缩放动画)由消息级 RO 覆盖,这里不特判 */
  const handleResize = useCallback(
    (entries: ResizeObserverEntry[]) => {
      let dirty = false
      for (const e of entries) {
        const el = e.target as HTMLElement
        if (el !== winRef.current) {
          const id = el.dataset.vid
          if (id) {
            const h = e.contentRect.height
            if (h > 0 && Math.abs(h - (heightsRef.current.get(id) ?? -1)) > 0.5) {
              heightsRef.current.set(id, h)
              dirty = true
            }
          }
        } else {
          dirty = true
        }
      }
      if (dirty) scheduleLayout()
    },
    [scheduleLayout],
  )

  /** 惰性创建 RO(消息元素在 commit 阶段先于 effects attach,不能在
   * effect 里初始化——首次 attach 时创建并观察窗口容器) */
  const getRo = useCallback(() => {
    if (!roRef.current) {
      roRef.current = new ResizeObserver(handleResize)
      if (winRef.current) roRef.current.observe(winRef.current)
    }
    return roRef.current
  }, [handleResize])

  /** 消息挂载测量(ref cleanup,React 19):挂载 → observe,卸载 → unobserve
   * (不释放观察关系会累积被卸载消息的强引用,长历史滚动泄漏) */
  const attachMsg = useCallback(
    (el: HTMLDivElement | null, id: string) => {
      if (!el) return
      el.dataset.vid = id
      getRo().observe(el)
      return () => {
        roRef.current?.unobserve(el)
      }
    },
    [getRo],
  )

  // 滚动监听(被动;滚动中每帧 → rAF 合帧重算范围)
  useEffect(() => {
    const scroller = scrollRef?.current
    if (!scroller || !atBottomRef) return
    const onScroll = () => {
      // 底部 48px 内视为贴底(与 AgentView handleScroll 同款判定)
      atBottomRef.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
      scheduleLayout()
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scrollRef, atBottomRef, scheduleLayout])

  // 初始布局:读运行时 gap、初始贴底(进入面板总是看最新消息,滚动条
  // 位置先按预估,消息挂载测量后由贴底保持校正)、按可视范围渲染
  useLayoutEffect(() => {
    const scroller = scrollRef?.current
    if (!scroller || !atBottomRef) return
    const gap = parseFloat(getComputedStyle(scroller).rowGap)
    if (Number.isFinite(gap) && gap > 0) gapRef.current = gap
    getRo()
    scroller.scrollTop = scroller.scrollHeight
    updateLayout()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载一次
  }, [])

  // 消息变化(新消息落定/历史切换/清空):重算范围;空列表清高度缓存
  useEffect(() => {
    if (messages.length === 0) heightsRef.current.clear()
    updateLayout()
  }, [messages, updateLayout])

  // 卸载:断开全部观察、取消在途 rAF(面板收起/视图切换)
  useEffect(
    () => () => {
      roRef.current?.disconnect()
      cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  // 空列表不渲染窗口:两个 spacer 之间的 flex gap 会残留 10px 高度,
  // 干扰欢迎语的 margin:auto 居中与岛体高度测量
  if (messages.length === 0) return null
  const start = Math.min(range.start, messages.length)
  const end = Math.min(range.end, messages.length)
  const visible = messages.slice(start, end)
  return (
    <div className="island-msgs-window" ref={winRef}>
      <div ref={topSpacerRef} aria-hidden="true" style={{ height: 0, flexShrink: 0 }} />
      {visible.map((m) => (
        <div key={m.id} ref={(el) => attachMsg(el, m.id)} className="island-msgs-item">
          {renderItem(m)}
        </div>
      ))}
      <div ref={bottomSpacerRef} aria-hidden="true" style={{ height: 0, flexShrink: 0 }} />
    </div>
  )
})

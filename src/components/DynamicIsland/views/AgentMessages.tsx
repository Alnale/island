/**
 * Agent 消息呈现组件群(2026-08-06 从 AgentView.tsx 拆出):
 * 用户气泡 / 工具卡片 / 工具汇总 / 助手消息块。
 * 全部 memo 化:已落定消息 props 引用不变,流式期间不再重建。
 * 与 AgentView 的边界:本文件只负责"渲染一条消息",
 * 状态(列表/测量/输入/菜单)留在 AgentView。
 */

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentMessage, AgentPart } from '../../../agent/types'
import { stripNapcatInstructions, stripTurnMarks, textFromMessage, textFromParts } from '../../../agent/text'
import { firstMediaKindInText } from './markdownParser'
import { AgentImage, CopyButton, Markdown, MediaFrame } from './Markdown'

/** 用户消息气泡:右侧强调色,Markdown 文本(plainMermaid:用户贴的
 * mermaid 源码按普通代码块显示,图表深色主题进浅色气泡不可读) + 复制按钮。
 * memo:已落定消息引用不变,流式期间不再重建 */
/** 剥离 NapCat 注入指令段(2026-08-12 修复"提示词泄露"):main.cjs
 * 群/陌生人消息的注入文本 = 【来源】消息 + 【群聊指令/私聊指令】…——
 * 指令段只给 LLM 看(引擎历史回传完整),对话窗口显示剥离,用户只见
 * 来源标注与原始消息(实现已抽到 src/agent/text.ts,与 useAgent 历史
 * 发送防污染共用) */

export const UserBubble = memo(function UserBubble({ m, onUndo }: { m: AgentMessage; onUndo?: (messageId: string) => void }) {
  const text = stripNapcatInstructions(textFromMessage(m))
  // 收到的 QQ/群图片(2026-08-12 收图链路):用户消息 media part →
  // MediaFrame 展示图片(main.cjs 已下载到本地路径)
  const mediaParts = m.parts.filter((p): p is Extract<AgentPart, { type: 'media' }> => p.type === 'media')
  // 档案卡展开态(2026-08-13 优化:受控展开 + 0fr↔1fr 高度动画,
  // 与工具卡同款曲线;原 details 原生折叠无动画)
  const [cardOpen, setCardOpen] = useState(false)
  // 撤销两段式确认(2026-08-14 停止与撤销分离):首次点击进确认态
  // (3s 自动复位),再点执行——回滚具破坏性(丢该轮 git 提交与新建
  // 文件),与快捷清空上下文同款交互兑底
  const [undoArmed, setUndoArmed] = useState(false)
  useEffect(() => {
    if (!undoArmed) return
    const t = window.setTimeout(() => setUndoArmed(false), 3000)
    return () => window.clearTimeout(t)
  }, [undoArmed])
  return (
    <div className="island-agent-msg-user-row">
      {onUndo && (
        <button
          type="button"
          className={`island-agent-msg-undo${undoArmed ? ' armed' : ''}`}
          title={
            undoArmed
              ? '再点一次确认撤销:上下文与文件(git)回滚到这条消息之前'
              : '撤销:上下文与文件(git)回滚到这条消息之前'
          }
          onClick={(event) => {
            event.stopPropagation()
            if (!undoArmed) {
              setUndoArmed(true)
              return
            }
            setUndoArmed(false)
            onUndo(m.id)
          }}
          onPointerDown={(event) => {
            if (event.button === 0) event.stopPropagation()
          }}
        >
          {undoArmed ? (
            <span className="island-agent-msg-undo-confirm">确认?</span>
          ) : (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
            </svg>
          )}
        </button>
      )}
      <div className="island-agent-msg-user">
      <div className="island-agent-msg-user-text">
        {/* NapCat 来源头(2026-08-13 布局细分重构,用户要求"总体 QQ →
            私聊/群聊 → 发言 QQ 号 → 档案卡"):第一行 类别 + QQ 号 +
            档案卡按钮;档案卡展开为全宽块(每条消息都带,主人/外人
            一眼区分);ask(陌生人询问轮)同私聊类别显示 */}
        {(m.source === 'qq' || m.source === 'group' || m.source === 'ask') && (
          <div className="island-agent-msg-qq-head">
            <span className="island-agent-msg-qq-cat">QQ · {m.source === 'group' ? '群聊' : '私聊'}</span>
            <span className="island-agent-msg-qq-num">{m.qq ? `QQ ${m.qq}` : ''}</span>
            {m.profileCard && (
              <div className={`island-agent-msg-qq-card${cardOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  className="island-agent-msg-qq-card-summary"
                  aria-expanded={cardOpen}
                  onClick={() => setCardOpen((o) => !o)}
                >
                  <span>档案卡</span>
                  <svg
                    className="island-agent-msg-qq-card-arrow"
                    viewBox="0 0 16 16"
                    width="9"
                    height="9"
                    aria-hidden="true"
                  >
                    <path
                      d="M4 6l4 4 4-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <div className="island-agent-msg-qq-card-wrap">
                  <div className="island-agent-msg-qq-card-body">
                    {m.profileCard.split('\n').map((line, i) => {
                      const label = /^([^:：]{1,8}[:：])(.*)$/.exec(line)
                      return (
                        <div key={i} className="island-agent-msg-qq-card-line">
                          {label ? (
                            <>
                              <span className="island-agent-msg-qq-card-label">{label[1]}</span>
                              {label[2]}
                            </>
                          ) : (
                            line || ' '
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        <Markdown text={text} plainMermaid />
        {mediaParts.map((p, i) => (
          <MediaFrame key={`media-${i}`} kind={p.kind} src={p.url} alt={p.name} />
        ))}
      </div>
      <CopyButton text={text} />
      </div>
    </div>
  )
})

/** "发给对方"指纹标签(2026-08-14 指纹 UI):本轮指纹命中的回复 =
 * 路由发给 QQ 对方的话,气泡上方挂一行小标签(指纹图标 + 文案)与
 * 给主人的普通回复区分;配色跟随全局文字色,纯结构区分。
 * 落定消息(AssistantBlock)与流式气泡(AgentView)共用 */
export const PeerTurnTag = memo(function PeerTurnTag() {
  return (
    <div className="island-agent-msg-peer-tag" title="这条回复带本轮指纹,会路由发给 QQ 对方">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
        <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
        <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
        <path d="M2 12a10 10 0 0 1 18-6" />
        <path d="M2 16h.01" />
        <path d="M21.8 16c.2-2 .131-5.354 0-6" />
        <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
        <path d="M8.65 22c.21-.66.45-1.32.57-2" />
        <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
      </svg>
      <span>发给对方</span>
    </div>
  )
})

/** "发给主人"指纹标签(2026-08-15 双指纹机制 UI,用户要求"区分别人和
 * 主人指纹"):本轮主人指纹【主人指纹:xx】命中的回复 = 路由发回主人 QQ
 * 的话,气泡上方挂一行小标签(皇冠图标 + 文案)——与"发给对方"标签
 * (纸飞机图标)视觉区分:主人 = 强调色高亮,对方 = 弱化透明度 */
export const MasterTurnTag = memo(function MasterTurnTag() {
  return (
    <div className="island-agent-msg-master-tag" title="这条回复带主人指纹,会路由发给主人 QQ">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
        <path d="M5 21h14" />
      </svg>
      <span>发给主人</span>
    </div>
  )
})

/** "已停止"标签(2026-08-14 软停止):手动停止落定的部分工作消息,
 * 气泡上方挂一行小标签与正常回复区分(复用 PeerTurnTag 同款结构,
 * 配色跟随全局文字色纯结构区分) */
export const InterruptedTag = memo(function InterruptedTag() {
  return (
    <div className="island-agent-msg-stopped-tag" title="这一轮被手动停止,以下是已完成的部分">
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
      <span>已停止</span>
    </div>
  )
})

/** 单个工具调用的数据(模块内卡片 / 流式卡片共用) */
interface ToolCallData {
  id: string
  name: string
  args: Record<string, unknown>
  ok?: boolean
  result?: string
  durationMs?: number
}

/** 工具卡片:头部(状态 + 名称 + 耗时)+ 可展开参数/结果(过程可知)。
    展开/收起 = 高度经 grid-template-rows 0fr↔1fr 动画(无需测量高度;
    无过冲缓动——弹簧曲线插值到负 fr 会被钳制,收起时会抖动)。
    memo:已落定消息里 call 引用稳定,流式期间不再重建 */
export const ToolCard = memo(function ToolCard({ call }: { call: ToolCallData }) {
  const [open, setOpen] = useState(false)
  // body 懒渲染(2026-08-11 性能):工具调用流式期间每帧重渲染整个
  // ToolSummary(参数增量逐帧累积),卡片默认折叠——参数 JSON.stringify
  // + 8000 字符结果 pre 的渲染纯浪费(不可见),且大参数(write_file
  // 内容/长命令)stringify 本身是重活。折叠时 body 不渲染;展开先挂
  // 内容、双 rAF 后再加 open 类(0fr→1fr 动画首帧内容已就位不塌缩);
  // 收起动画(0.28s)结束后清空
  const [showBody, setShowBody] = useState(false)
  const bodyClearTimerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(bodyClearTimerRef.current), [])
  // 气泡宽度动画(2026-08-19 用户要求:详情展开/收起时列表整体变宽/缩窄
  // 无动画):参数/结果长行把 shrink-to-fit 气泡瞬间撑宽/缩窄。宽度是
  // 内容驱动的 auto 布局结果——interpolate-size 只支持数值↔关键字过渡,
  // auto→auto(内容变化)不触发 transition,纯 CSS 无解。走 FLIP(QuickMenu
  // 按钮宽度过渡同款):显式 width 从旧值过渡到新值,结束后清回 auto
  // 不干扰后续自然布局。展开在内容挂载帧启动(挂载后才知道目标宽);
  // **收起并行化(2026-08-19 二次优化,用户要求"一边收缩变窄,一边收缩
  // 变矮同步进行")**:原两段式(高度先收完 0.28s,300ms 后内容卸载气泡
  // 才缩窄)改为 toggle 收起时同帧启动——临时 display:none body 量出
  // "卸载后目标宽"再恢复,宽度过渡与高度 grid 动画同时长同曲线并行
  const cardRef = useRef<HTMLDivElement | null>(null)
  const flipW0Ref = useRef<number | null>(null)
  const flipStopRef = useRef<(() => void) | null>(null)
  useEffect(() => () => flipStopRef.current?.(), [])
  /** 启动宽度过渡 w0→w1。clearOnEnd:结束后清显式宽回 auto(展开用);
   *  收起传 false——保留 w1 到 300ms 后内容卸载帧再清:过渡完成(280ms)
   *  到内容卸载(300ms)之间内容仍渲染,清掉会弹回内容宽闪烁;卸载后
   *  自然宽已 = w1(display:none 量的就是卸载等效态),清掉无跳变 */
  const startWidthFlip = (bubble: HTMLElement, w0: number, w1: number, clearOnEnd: boolean) => {
    flipStopRef.current?.()
    bubble.style.width = `${w0}px`
    void bubble.offsetWidth // 强制 reflow 锁定过渡起点
    bubble.style.width = `${w1}px`
    const stop = () => {
      bubble.removeEventListener('transitionend', done)
      bubble.removeEventListener('transitioncancel', done)
      if (clearOnEnd) bubble.style.width = ''
      if (flipStopRef.current === stop) flipStopRef.current = null
    }
    const done = (event: TransitionEvent) => {
      if (event.propertyName !== 'width') return
      stop()
    }
    bubble.addEventListener('transitionend', done)
    bubble.addEventListener('transitioncancel', done)
    flipStopRef.current = stop
  }
  const toggle = () => {
    // 快照/启动前终止进行中的 FLIP 并清显式宽,取真实布局宽(快速连点时
    // 新动画从当前实际宽度出发,不残留旧目标)
    const bubble = cardRef.current?.closest<HTMLElement>('.island-agent-msg-assistant')
    flipStopRef.current?.()
    if (bubble) bubble.style.width = ''
    if (!open) {
      // 展开:快照当前宽,内容挂载帧 layout effect 启动(挂载后才知道
      // 目标宽;挂载瞬间气泡已被内容撑宽,FLIP 锁回 w0 再过渡到 w1)
      if (bubble) flipW0Ref.current = bubble.offsetWidth
      setShowBody(true)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setOpen(true))
      })
    } else {
      // 收起:宽度与高度**并行**收缩(同帧启动,0.28s 同曲线)。收起后
      // 目标宽量不到(内容 300ms 后才卸载)——临时 display:none body
      // 绕过 React 量一次"卸载后宽度"再恢复(同一同步块,无渲染帧介入
      // 不闪烁);宽度不变(短参数)则跳过。showBody 卸载帧 layout effect
      // 里 flipW0Ref 为 null,不会重复启动
      const bodyWrap = cardRef.current?.querySelector<HTMLElement>('.island-agent-tool-body-wrap')
      if (bubble && bodyWrap) {
        const w0 = bubble.offsetWidth
        bodyWrap.style.display = 'none'
        const w1 = bubble.offsetWidth
        bodyWrap.style.display = ''
        if (Math.abs(w1 - w0) >= 1) startWidthFlip(bubble, w0, w1, false)
      }
      setOpen(false)
      window.clearTimeout(bodyClearTimerRef.current)
      bodyClearTimerRef.current = window.setTimeout(() => setShowBody(false), 300)
    }
  }
  // 展开:内容挂载帧(showBody 翻 true)paint 前启动宽度过渡;收起的
  // 收尾也在此——内容卸载帧(翻 false)清收起 FLIP 残留的显式宽
  useLayoutEffect(() => {
    const bubble = cardRef.current?.closest<HTMLElement>('.island-agent-msg-assistant')
    if (!showBody) {
      if (bubble) bubble.style.width = ''
      return
    }
    const w0 = flipW0Ref.current
    flipW0Ref.current = null
    if (w0 === null || !bubble) return
    bubble.style.width = ''
    const w1 = bubble.offsetWidth
    if (Math.abs(w1 - w0) < 1) return
    startWidthFlip(bubble, w0, w1, true)
  }, [showBody])
  return (
    <div ref={cardRef} className={`island-agent-tool${open ? ' open' : ''}`}>
      {/* 卡片是交互元素:拦截左键,长按卡片不触发岛体收回 */}
      <button
        type="button"
        className="island-agent-tool-head"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          toggle()
        }}
        onPointerDown={(event) => {
          if (event.button === 0) event.stopPropagation()
        }}
      >
        <span className={`island-agent-tool-state ${call.ok === false ? 'err' : call.ok ? 'ok' : 'run'}`} aria-hidden="true">
          {/* 纯汉字状态(2026-08-07 用户要求:移除绿勾/红叉图标) */}
          {call.ok === false ? '调用失败' : call.ok ? '调用成功' : '执行中'}
        </span>
        <span className="island-agent-tool-name">{call.name}</span>
        {call.durationMs !== undefined && (
          <span className="island-agent-tool-time">{call.durationMs}ms</span>
        )}
        <span className="island-agent-tool-toggle" aria-hidden="true">
          ▸
        </span>
      </button>
      {showBody && (
        <div className="island-agent-tool-body-wrap">
          <div className="island-agent-tool-body">
            <div className="island-agent-tool-sec">
              <span className="island-agent-tool-sec-title">参数</span>
              <pre className="island-agent-tool-code">{JSON.stringify(call.args ?? {}, null, 2)}</pre>
            </div>
            {call.result !== undefined && (
              <div className="island-agent-tool-sec">
                <span className="island-agent-tool-sec-title">{call.ok === false ? '错误' : '结果'}</span>
                <pre className="island-agent-tool-code">{call.result}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

/** 工具汇总列表:一轮回复的**全部**工具调用收纳成单行(信息密度优化 v2,
    2026-08-06:取代按连续序列分组的模块——实时收纳,流式执行中也逐个
    并入同一列表)。默认折叠:只有头部一行(图标 + 名称/计数 + 状态汇总 +
    总耗时 + 箭头),工具再多也不撑开消息气泡;点击展开看各卡,再点卡片
    展开参数/结果。头部实时汇总:执行中脉冲点 / 成功失败计数,收纳态也能
    一眼看到执行概况 */
export const ToolSummary = memo(function ToolSummary({ items }: { items: ToolCallData[] }) {
  const [open, setOpen] = useState(false)
  const running = items.some((i) => i.ok === undefined)
  const okCount = items.filter((i) => i.ok === true).length
  const errCount = items.filter((i) => i.ok === false).length
  const totalMs = items.reduce((sum, i) => sum + (i.durationMs ?? 0), 0)
  return (
    <div className={`island-agent-tool-summary${open ? ' open' : ''}`}>
      {/* 头部:交互元素,拦截左键(长按不触发岛体收回) */}
      <button
        type="button"
        className="island-agent-tool-summary-head"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((v) => !v)
        }}
        onPointerDown={(event) => {
          if (event.button === 0) event.stopPropagation()
        }}
      >
        <svg
          className="island-ctl-svg"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="4" y1="6" x2="20" y2="6" />
          <circle cx="14" cy="6" r="2" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <circle cx="8" cy="12" r="2" />
          <line x1="4" y1="18" x2="20" y2="18" />
          <circle cx="16" cy="18" r="2" />
        </svg>
        <span className="island-agent-tool-summary-title">
          {items.length === 1 ? items[0].name : `工具调用 ×${items.length}`}
        </span>
        {running ? (
          <span className="island-agent-tool-summary-state run">● 执行中</span>
        ) : (
          <>
            {okCount > 0 && <span className="island-agent-tool-summary-state ok">调用成功 {okCount}</span>}
            {errCount > 0 && <span className="island-agent-tool-summary-state err">调用失败 {errCount}</span>}
          </>
        )}
        {totalMs > 0 && <span className="island-agent-tool-time">{totalMs}ms</span>}
        <span className="island-agent-tool-toggle" aria-hidden="true">
          ▸
        </span>
      </button>
      <div className="island-agent-tool-summary-body">
        <div className="island-agent-tool-summary-inner">
          {items.map((call) => (
            <ToolCard key={call.id} call={call} />
          ))}
        </div>
      </div>
    </div>
  )
})

/** 助手消息块:parts 按顺序渲染(文本段 + 工具汇总),尾部附 token 用量。
    本轮回复的**全部**工具调用(执行顺序)收纳进尾部单一工具汇总列表——
    工具不再夹在文本段之间撑开消息气泡(信息密度优化 v2,2026-08-06);
    点击汇总行展开看各卡,再点卡片展开参数。
    memo:已落定消息 parts 引用不变,流式期间不再重建 */
export const AssistantBlock = memo(function AssistantBlock({
  id,
  parts,
  usage,
  sentToPeer = false,
  sentToMaster = false,
  interrupted = false,
  mediaAutoPlay = false,
  onMediaAutoPlayed,
}: {
  /** 消息 id(2026-08-11:消费标记回调按 id 传参,回调引用稳定——原
   * 内联箭头 `() => onMediaAutoPlayed?.(m.id)` 每渲染新引用,把 memo
   * 整个打穿,消息一多任何一次重渲染(流式/视频播放上报)都全列表
   * 重建 = 卡顿放大器) */
  id?: string
  parts: AgentMessage['parts']
  usage?: AgentMessage['usage']
  /** 轮次指纹命中(2026-08-14 指纹 UI):true = 本条回复路由发给了
   * QQ 对方——气泡换"发给对方"风格(镜像角形/虚线边框/指纹标签),
   * 与给主人的普通回复一眼区分(主题色全局,纯结构区分) */
  sentToPeer?: boolean
  /** 主人指纹命中(2026-08-15 双指纹 UI):true = 本条回复路由发回主人
   * QQ——气泡挂"发给主人"标签(皇冠 + 强调色),与"发给对方"/
   * 普通回复区分;与 sentToPeer 互斥(开头标记唯一) */
  sentToMaster?: boolean
  /** 软停止落定(2026-08-14):true = 本条是手动停止时保留的部分工作,
   * 气泡上方挂"已停止"标签 */
  interrupted?: boolean
  /** 2026-08-10 自动播放只限"当次对话":本会话流式落定且未消费的消息才
   * true(LLM 播放的那一轮自动播一次);历史/重挂载读到 false */
  mediaAutoPlay?: boolean
  /** 消费标记(自动播放已发生,该消息重挂载不再播) */
  onMediaAutoPlayed?: (id: string) => void
}) {
  // 消费自动播放标记:渲染后立即从 Set 移除——之后重挂载(收起再展开/
  // 历史恢复)渲染时读到 false,不再自动播放;消费幂等(Set.delete 重复
  // 调用无害)
  useEffect(() => {
    if (mediaAutoPlay && id !== undefined) onMediaAutoPlayed?.(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅标记翻转时
  }, [mediaAutoPlay])
  // 文本段按原顺序渲染;工具调用全量收集(调用 + 结果配对;顺序即执行
  // 顺序,过程可知)
  const textParts: Array<Extract<AgentPart, { type: 'text' }>> = []
  const toolCalls: ToolCallData[] = []
  // 结果一次遍历建 Map,按 id 配对(避免每个 tool-call 都 parts.find 的
  // O(parts²) 扫描——长对话 + 多工具调用时是流式重渲染的隐藏开销)
  const resultById = new Map<string, { ok?: boolean; result?: string; durationMs?: number }>()
  parts.forEach((part) => {
    if (part.type === 'text') {
      textParts.push(part)
    } else if (part.type === 'tool-result') {
      resultById.set(part.id, { ok: part.ok, result: part.result, durationMs: part.durationMs })
    }
  })
  parts.forEach((part) => {
    if (part.type !== 'tool-call') return
    const r = resultById.get(part.id)
    toolCalls.push({
      id: part.id,
      name: part.name,
      args: part.args,
      ok: r?.ok,
      result: r?.result,
      durationMs: r?.durationMs,
    })
  })
  // 媒体附件(带原 parts 索引,自动播权分派用)
  const mediaParts: Array<{ p: Extract<AgentPart, { type: 'media' }>; idx: number }> = []
  parts.forEach((part, i) => {
    if (part.type === 'media') mediaParts.push({ p: part, idx: i })
  })
  // 自动播权分派(2026-08-10 三轮修复"LLM 找歌来听没自动播放"):按原
  // parts 顺序找**第一个**音频/视频媒体——markdown 内嵌 ![歌名](路径)
  // (LLM 常用回复内嵌而非工具拦截)或 media part;获权者自动播放,其余
  // 保持被动。mediaAutoPlay(当次对话标记)为 false 时全部不播
  let grantTextIdx: number | null = null
  let grantMediaIdx: number | null = null
  for (let i = 0; i < parts.length && grantTextIdx === null && grantMediaIdx === null; i++) {
    const p = parts[i]
    if (p.type === 'text') {
      const k = firstMediaKindInText(p.text)
      if (k === 'audio' || k === 'video') grantTextIdx = textParts.indexOf(p)
    } else if (p.type === 'media' && (p.kind === 'audio' || p.kind === 'video')) {
      grantMediaIdx = i
    }
  }
  return (
    <div className={`island-agent-msg-assistant${sentToPeer ? ' qq-peer' : ''}`}>
      {sentToPeer && <PeerTurnTag />}
      {sentToMaster && <MasterTurnTag />}
      {interrupted && <InterruptedTag />}
      {textParts.map((p, i) => (
        <div key={`t-${i}`} className="island-agent-text">
          {/* 轮次标记剥离(2026-08-13 指纹协议):「【回复对方】」(旧静态
              标记)与「【指纹:xx】」(每轮随机指纹)是给主进程路由层验证
              用的,气泡里不显示——首个文本段开头剥离(历史存储路径已在
              useAgent 剥过,此处兜底流式/回放) */}
          <Markdown text={i === 0 ? stripTurnMarks(p.text) : p.text} mediaAutoPlay={mediaAutoPlay && i === grantTextIdx} />
        </div>
      ))}
      {/* 工具图片附件(如 bili 登录二维码):引擎注入的 image part,
          消息气泡内直接展示(不依赖 LLM 复述 base64;按缩放等比显示) */}
      {parts
        .filter((p): p is Extract<AgentPart, { type: 'image' }> => p.type === 'image')
        .map((p, i) => <AgentImage key={`img-${i}`} src={p.dataUrl} alt="工具图片" />)}
      {/* 工具媒体附件(2026-08-08,open_file 媒体拦截):引擎注入的 media
          part,MediaFrame 窗口内直接播放——LLM 说"打开视频看看"不再走
          外部播放器,也不依赖 LLM 输出 markdown(实测只回"已播放"不展示)
          **自动播放(2026-08-10 用户要求)**:LLM 播放视频/音频 → 媒体
          元素加载出后自动播放(i === 0 只自动播第一条——一条回复多个
          附件不全响,其余点一下播放);被自动播放策略拦截静默回退封面/
          播放键 */}
      {mediaParts.map(({ p, idx }) => (
        <MediaFrame
          key={`media-${idx}`}
          kind={p.kind}
          src={p.url}
          alt={p.name}
          // 只自动播该消息第一个音频/视频媒体(markdown 内嵌或 media
          // part 谁先谁获权;多条不全响);仅当次对话的流式落定消息
          // (mediaAutoPlay)才自动播——历史/重挂载不播
          autoPlay={mediaAutoPlay && idx === grantMediaIdx}
        />
      ))}
      {toolCalls.length > 0 && <ToolSummary items={toolCalls} />}
      {/* 气泡脚注:复制按钮(复制本条回复文本)+ token 用量 */}
      <div className="island-agent-msg-foot">
        <CopyButton text={textFromParts(parts)} />
        {usage && (
          <span className="island-agent-usage">
            输入 {usage.input.toLocaleString()} · 输出 {usage.output.toLocaleString()}
            {usage.cached ? ` · 缓存命中 ${usage.cached.toLocaleString()}` : ''}
          </span>
        )}
      </div>
    </div>
  )
})


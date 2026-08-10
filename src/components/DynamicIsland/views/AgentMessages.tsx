/**
 * Agent 消息呈现组件群(2026-08-06 从 AgentView.tsx 拆出):
 * 用户气泡 / 工具卡片 / 工具汇总 / 助手消息块。
 * 全部 memo 化:已落定消息 props 引用不变,流式期间不再重建。
 * 与 AgentView 的边界:本文件只负责"渲染一条消息",
 * 状态(列表/测量/输入/菜单)留在 AgentView。
 */

import { memo, useEffect, useState } from 'react'
import type { AgentMessage, AgentPart } from '../../../agent/types'
import { textFromMessage, textFromParts } from '../../../agent/text'
import { firstMediaKindInText } from './markdownParser'
import { AgentImage, CopyButton, Markdown, MediaFrame } from './Markdown'

/** 用户消息气泡:右侧强调色,Markdown 文本(plainMermaid:用户贴的
 * mermaid 源码按普通代码块显示,图表深色主题进浅色气泡不可读) + 复制按钮。
 * memo:已落定消息引用不变,流式期间不再重建 */
export const UserBubble = memo(function UserBubble({ m }: { m: AgentMessage }) {
  const text = textFromMessage(m)
  return (
    <div className="island-agent-msg-user">
      <div className="island-agent-msg-user-text">
        <Markdown text={text} plainMermaid />
      </div>
      <CopyButton text={text} />
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
  return (
    <div className={`island-agent-tool${open ? ' open' : ''}`}>
      {/* 卡片是交互元素:拦截左键,长按卡片不触发岛体收回 */}
      <button
        type="button"
        className="island-agent-tool-head"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((v) => !v)
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
  parts,
  usage,
  mediaAutoPlay = false,
  onMediaAutoPlayed,
}: {
  parts: AgentMessage['parts']
  usage?: AgentMessage['usage']
  /** 2026-08-10 自动播放只限"当次对话":本会话流式落定且未消费的消息才
   * true(LLM 播放的那一轮自动播一次);历史/重挂载读到 false */
  mediaAutoPlay?: boolean
  /** 消费标记(自动播放已发生,该消息重挂载不再播) */
  onMediaAutoPlayed?: () => void
}) {
  // 消费自动播放标记:渲染后立即从 Set 移除——之后重挂载(收起再展开/
  // 历史恢复)渲染时读到 false,不再自动播放;消费幂等(Set.delete 重复
  // 调用无害)
  useEffect(() => {
    if (mediaAutoPlay) onMediaAutoPlayed?.()
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
    <div className="island-agent-msg-assistant">
      {textParts.map((p, i) => (
        <div key={`t-${i}`} className="island-agent-text">
          <Markdown text={p.text} mediaAutoPlay={mediaAutoPlay && i === grantTextIdx} />
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


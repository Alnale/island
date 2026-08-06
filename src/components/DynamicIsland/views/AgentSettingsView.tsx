/**
 * Agent 设置视图(设置视图"Agent 设置"入口,设置类视图:只能经返回键退出)
 *
 * 字段:API Key / Base URL / 模型 / 自定义提示词 / 思考强度 / 界面放大 /
 * MCP 服务列表(stdio 进程或 sse 远程端点,逐条"测试"连通)/
 * 技能目录列表(扫描 SKILL.md)/ **记忆系统**(结构化长期记忆:偏好/事实/
 * 工作流/教训,增删改)/ **自我进化**(一键触发记忆自主优化,日志 + 回滚)。
 * 保存经 onSave 走主进程 settings.json(agent 段),记忆与进化走独立 IPC。
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type WheelEvent } from 'react'
import type { AgentConfig, AgentToolInfo, McpServerConfig, MemoryEntry } from '../../../agent/types'
import { useWheelSteps } from '../../../hooks/useWheelSteps'
import { BackFoot, PanelHead } from './shared'
import { WheelSwap } from './WheelSwap'

export interface AgentSettingsViewProps {
  config: AgentConfig | null
  onSave: (patch: Partial<AgentConfig>) => void
  /** 工具清单(已注册技能/MCP 的预览展示;agent:tools 异步加载) */
  tools?: AgentToolInfo[]
  /** 界面缩放(百分比 100-300,最低 100%) */
  scale: number
  onScaleChange: (scale: number) => void
  onBack: () => void
}

/** MCP 服务表单行(参数/环境变量以逐行文本编辑,保存时转换) */
interface McpServerForm {
  name: string
  type: 'stdio' | 'sse'
  command: string
  /** 每行一个参数(支持含空格路径) */
  args: string[]
  /** 每行 KEY=VALUE */
  env: string[]
  /** sse 端点 URL */
  url: string
  /** sse 请求头,每行 KEY=VALUE */
  headers: string[]
}

const MEMORY_TYPES: Array<[MemoryEntry['type'], string]> = [
  ['preference', '偏好'],
  ['fact', '事实'],
  ['workflow', '工作流'],
  ['lesson', '教训'],
]

/** 记忆类型下拉(定制 UI:展开/收起动画,精致缓动;替代原生 select) */
function MemoryTypeSelect({
  value,
  onChange,
}: {
  value: MemoryEntry['type']
  onChange: (v: MemoryEntry['type']) => void
}) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  // 滚轮每格 +1:重挂载按钮重放内容交换动画(与快捷按钮同款)
  const [tick, setTick] = useState(0)
  // 切换前的类型与方向(WheelSwap 旧徽标滑出/新徽标回弹滑入)
  const [prevType, setPrevType] = useState<MemoryEntry['type'] | null>(null)
  const [dir, setDir] = useState<1 | -1>(1)
  const ref = useRef<HTMLDivElement>(null)
  // 收起:先播动画再卸载(与候选列表同模式)
  const closeWithAnim = () => {
    setClosing(true)
    window.setTimeout(() => {
      setOpen(false)
      setClosing(false)
    }, 260)
  }
  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDoc = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) closeWithAnim()
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [open])
  // 原生非 passive 滚轮监听:悬浮在类型按钮上滚轮切换时,吞掉滚轮的
  // 默认滚动行为(设置页是滚动容器;React onWheel 为 passive 监听,
  // preventDefault 无效)——否则切换类型的同时整页跟着滚。下拉展开时
  // 放行(滚轮属于选项浮层的交互面,不切换类型)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onNativeWheel = (event: globalThis.WheelEvent) => {
      if (!openRef.current) event.preventDefault()
    }
    el.addEventListener('wheel', onNativeWheel, { passive: false })
    return () => el.removeEventListener('wheel', onNativeWheel)
  }, [])
  // 滚轮切换:直接在本体按钮上滚动,逐格循环切换类型(与快捷按钮共用
  // useWheelSteps,手感一致);下拉展开时不响应(选项浮层是当时的交互面)
  const wheelSteps = useWheelSteps()
  const handleTypeWheel = (event: WheelEvent<HTMLButtonElement>) => {
    const step = wheelSteps(event)
    if (!step || open) return
    const idx = MEMORY_TYPES.findIndex(([v]) => v === value)
    const next = MEMORY_TYPES[(idx + step + MEMORY_TYPES.length) % MEMORY_TYPES.length]
    setPrevType(value)
    setDir(step)
    onChange(next[0])
    setTick((t) => t + 1)
  }
  // 类型徽标(WheelSwap 旧/新两层共用;标签按类型查表)
  const typeBadgeNode = (v: MemoryEntry['type']) => (
    <span className={`island-memory-type t-${v}`}>{MEMORY_TYPES.find(([t]) => t === v)?.[1] ?? v}</span>
  )
  return (
    <div className="island-memory-type-wrap" ref={ref}>
      <button
        key={tick}
        type="button"
        className={`island-memory-type-btn${tick > 0 ? ' tick' : ''}`}
        onWheel={handleTypeWheel}
        onClick={(event) => {
          event.stopPropagation()
          if (open) closeWithAnim()
          else setOpen(true)
        }}
      >
        <WheelSwap tick={tick} dir={dir} prev={prevType ? typeBadgeNode(prevType) : null}>
          {typeBadgeNode(value)}
        </WheelSwap>
        <span className={`island-memory-type-arrow${open ? ' open' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className={`island-memory-type-pop${closing ? ' closing' : ''}`}>
          {MEMORY_TYPES.map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={`island-memory-type-opt${v === value ? ' on' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                onChange(v)
                closeWithAnim()
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 技能行(设置技能区;移除 = 加入排除列表;leaving = 离场动画中) */
function SkillRow({
  t,
  leaving,
  onExclude,
}: {
  t: AgentToolInfo
  leaving: boolean
  onExclude: (slug: string) => void
}) {
  return (
    <div className={`island-skills-reg-row${leaving ? ' island-ui-leave' : ''}`}>
      <span className="island-skills-reg-name">{t.name.replace(/^skill_/, '')}</span>
      <span className="island-skills-reg-desc" title={t.description}>
        {t.description.slice(0, 36)}
      </span>
      <button
        type="button"
        className="island-agent-scale-btn island-skills-reg-rm"
        onClick={(event) => {
          event.stopPropagation()
          onExclude(t.name.replace(/^skill_/, ''))
        }}
      >
        移除
      </button>
    </div>
  )
}

/** 环境变量行解析:KEY=VALUE,取首个 '=' 分隔(值可含 '=') */
function parseEnvLine(line: string): [string, string] | null {
  const i = line.indexOf('=')
  if (i <= 0) return null
  const k = line.slice(0, i).trim()
  if (!k) return null
  return [k, line.slice(i + 1)]
}

/** 表单行 → 配置(过滤空参数/空环境变量) */
function toConfigServer(s: McpServerForm): McpServerConfig {
  const kvOf = (lines: string[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of lines) {
      const pair = parseEnvLine(line)
      if (pair) out[pair[0]] = pair[1]
    }
    return out
  }
  if (s.type === 'sse') {
    return {
      name: s.name.trim(),
      type: 'sse',
      command: s.url.trim(),
      url: s.url.trim(),
      headers: kvOf(s.headers),
    }
  }
  return {
    name: s.name.trim(),
    type: 'stdio',
    command: s.command.trim(),
    args: s.args.map((a) => a.trim()).filter(Boolean),
    env: kvOf(s.env),
  }
}

/** 配置 → 表单行 */
function fromConfigServer(s: McpServerConfig): McpServerForm {
  const linesOf = (obj?: Record<string, string>): string[] =>
    Object.entries(obj ?? {}).map(([k, v]) => `${k}=${v}`)
  if (s.type === 'sse') {
    return {
      name: s.name ?? '',
      type: 'sse',
      command: s.url ?? '',
      args: [],
      env: [],
      url: s.url ?? '',
      headers: linesOf(s.headers),
    }
  }
  return {
    name: s.name ?? '',
    type: 'stdio',
    command: s.command ?? '',
    args: s.args ?? [],
    env: linesOf(s.env),
    url: '',
    headers: [],
  }
}

export function AgentSettingsView({ config, onSave, tools, scale, onScaleChange, onBack }: AgentSettingsViewProps) {
  const [form, setForm] = useState({
    apiKey: '',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    systemPrompt: '',
    reasoningEffort: 'high',
    mcpServers: [] as McpServerForm[],
    skillsDirs: [] as string[],
  })
  const [saved, setSaved] = useState(false)
  const savedTimerRef = useRef(0)
  // 自定义缩放输入草稿(失焦/回车提交,避免输入过程中被钳制打断)
  const [draftScale, setDraftScale] = useState(String(scale))
  useEffect(() => setDraftScale(String(scale)), [scale])
  const commitScale = () => {
    const v = Number(draftScale)
    const clamped = Number.isFinite(v) ? Math.min(300, Math.max(100, Math.round(v))) : scale
    setDraftScale(String(clamped))
    onScaleChange(clamped)
  }
  const handleScaleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commitScale()
  }
  // MCP 服务测试状态:正在测试的索引 / 最近一次结果
  const [testingIdx, setTestingIdx] = useState<number | null>(null)
  const [testResult, setTestResult] = useState<{ idx: number; ok: boolean; text: string } | null>(null)
  // 技能目录添加输入
  const [skillsDirDraft, setSkillsDirDraft] = useState('')
  // 已排除技能(slug;本地即时更新 + 提交 settings.json)
  const [excludedSkills, setExcludedSkills] = useState<string[]>([])
  // 记忆系统:条目列表 + 添加表单 + 编辑中条目
  const [memory, setMemory] = useState<MemoryEntry[]>([])
  const [memoryError, setMemoryError] = useState('')
  const [memoryDraft, setMemoryDraft] = useState({ type: 'fact' as MemoryEntry['type'], content: '' })
  const [editingMemory, setEditingMemory] = useState<{ id: string; content: string } | null>(null)
  // 导出状态(成功显示路径/取消/失败)
  const [exportMsg, setExportMsg] = useState('')
  // 导入状态(成功显示导入/跳过计数;失败显示错误)
  const [importMsg, setImportMsg] = useState('')
  // 离场动画中的条目 id(先播完收起动画,再真正移除)
  const [leavingMemory, setLeavingMemory] = useState<string[]>([])
  const [leavingSkills, setLeavingSkills] = useState<string[]>([])
  const [leavingMcp, setLeavingMcp] = useState<number[]>([])
  // 导入技能/清除版本结果提示
  const [skillImportMsg, setSkillImportMsg] = useState('')
  // 导入后本地工具快照(Bug 修复:导入的技能立即显示,无需重进设置;
  // 组件重挂载时重置,回到 prop 数据)
  const [localTools, setLocalTools] = useState<AgentToolInfo[] | null>(null)
  // 记忆编辑保存动画:保存按钮反馈 ✓ + 编辑容器离场
  const [editSaving, setEditSaving] = useState(false)
  const [editLeaving, setEditLeaving] = useState(false)
  // MCP 服务分组折叠(组名 → 折叠中)
  const [mcpCollapsed, setMcpCollapsed] = useState<Record<string, boolean>>({})
  // 技能三区:灵动岛创建 / 手动导入 / 扫描到的(外部目录);
  // shownTools = 导入后本地快照优先(Bug 修复:导入立即显示)
  const shownTools = localTools ?? tools ?? []
  const skillTools = shownTools.filter(
    (t) => t.name.startsWith('skill_') && !excludedSkills.includes(t.name.replace(/^skill_/, '')),
  )
  const createdSkills = skillTools.filter((t) => t.sourceKind === 'created')
  const importedSkills = skillTools.filter((t) => t.sourceKind === 'imported')
  const scannedSkills = skillTools.filter(
    (t) => t.sourceKind !== 'created' && t.sourceKind !== 'imported',
  )
  // 自我进化:进行中标记 + 日志(version = 候选版本号)
  const [evolving, setEvolving] = useState(false)
  const [evolutionLog, setEvolutionLog] = useState<Array<{ at: number; version: number; before: number; after: number; applied: boolean; summary: string }>>([])
  const [evolutionMsg, setEvolutionMsg] = useState('')
  // 配置到达后填充表单(config 未变时不覆盖用户正在编辑的内容)
  useEffect(() => {
    if (config) {
      setForm({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model,
        systemPrompt: config.systemPrompt,
        reasoningEffort: config.reasoningEffort || 'high',
        mcpServers: (config.mcpServers ?? []).map(fromConfigServer),
        skillsDirs: config.skillsDirs ?? [],
      })
      setExcludedSkills(config.excludedSkills ?? [])
    }
  }, [config])
  // 记忆与进化日志异步加载(挂载时);日志刷新抽成可复用回调——
  // 挂载加载 + 进化事件驱动实时刷新(用户反馈:进化完成后日志不更新)
  const refreshEvolutionLog = useCallback(() => {
    window.desktop
      ?.agentEvolutionLog?.()
      .then((logs) => {
        if (Array.isArray(logs)) setEvolutionLog(logs as typeof evolutionLog)
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    window.desktop?.agentMemoryGet?.()
      .then((list) => {
        if (Array.isArray(list)) setMemory(list as MemoryEntry[])
      })
      .catch(() => {})
    refreshEvolutionLog()
  }, [refreshEvolutionLog])
  // 进化进度事件订阅(evolution-progress / done,渲染端原本忽略):
  // 后台进化期间实时更新按钮状态(进化中…)、阶段消息与日志——
  // 停留在视图也能看到每轮评审/应用结果;done 任何路径都会发出
  // (正常完成/失败),evolving 状态可靠复位;卸载时取消订阅
  useEffect(() => {
    const off = window.desktop?.onAgentEvent?.((raw: unknown) => {
      const event = raw as { type?: string; phase?: string }
      if (event?.type !== 'evolution-progress' && event?.type !== 'evolution-done') return
      if (event.type === 'evolution-progress') {
        setEvolving(true)
        setEvolutionMsg(`进化中:${event.phase ?? ''}`)
        refreshEvolutionLog()
      } else {
        setEvolving(false)
        setEvolutionMsg('进化完成')
        refreshEvolutionLog()
        // 进化会修改记忆(应用/回滚):同步刷新记忆列表,与回滚同款
        window.desktop
          ?.agentMemoryGet?.()
          .then((list) => {
            if (Array.isArray(list)) setMemory(list as MemoryEntry[])
          })
          .catch(() => {})
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [refreshEvolutionLog])
  // 注意:配置刷新(LLM 自我配置后)由父组件在**进入本视图前**触发
  // (DynamicIsland 切 panelView 时调 agentConfig.onRefresh)——不能在
  // 本视图挂载后刷新:异步返回的 config 更新会触发下方填充 effect,
  // 在用户编辑表单过程中重置表单、丢失编辑(实测:对话里配置的 MCP
  // 反而被清空)

  const save = () => {
    onSave({
      apiKey: form.apiKey,
      baseURL: form.baseURL,
      model: form.model,
      systemPrompt: form.systemPrompt,
      reasoningEffort: form.reasoningEffort,
      mcpServers: form.mcpServers.map(toConfigServer),
      skillsDirs: form.skillsDirs.map((d) => d.trim()).filter(Boolean),
    })
    setSaved(true)
    window.clearTimeout(savedTimerRef.current)
    savedTimerRef.current = window.setTimeout(() => setSaved(false), 2000)
  }
  // 卸载时清理保存提示计时器
  useEffect(() => () => window.clearTimeout(savedTimerRef.current), [])

  // ---- MCP 服务行编辑 ----
  const patchServer = (idx: number, patch: Partial<McpServerForm>) => {
    setForm((f) => ({ ...f, mcpServers: f.mcpServers.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }))
  }
  /** MCP 服务分组:按服务名主段(第一个字母数字串)归组——
   * 同一程序的多个服务(如 siyuan-assets / siyuan-notes)归一个大类 */
  const mcpGroupOf = (name: string): string => {
    const m = /^([a-zA-Z0-9一-鿿]+)/.exec(name.trim())
    return m ? m[1] : name.trim() || '未命名'
  }
  // 分组渲染结构:组名 → 服务下标(按出现顺序)
  const mcpGroups: Array<{ group: string; indices: number[] }> = []
  for (let i = 0; i < form.mcpServers.length; i++) {
    const g = mcpGroupOf(form.mcpServers[i].name)
    const found = mcpGroups.find((x) => x.group === g)
    if (found) found.indices.push(i)
    else mcpGroups.push({ group: g, indices: [i] })
  }
  const toggleMcpGroup = (group: string) => {
    setMcpCollapsed((prev) => ({ ...prev, [group]: !prev[group] }))
  }
  const addServer = () => {
    setForm((f) => ({
      ...f,
      mcpServers: [...f.mcpServers, { name: '', type: 'stdio', command: '', args: [], env: [], url: '', headers: [] }],
    }))
    setTestResult(null)
  }
  const removeServer = (idx: number) => {
    // 删除 MCP 服务:先播卡片离场动画,再真正从表单移除(精致缓动)
    if (leavingMcp.includes(idx)) return
    setLeavingMcp((prev) => [...prev, idx])
    window.setTimeout(() => {
      setForm((f) => ({ ...f, mcpServers: f.mcpServers.filter((_, i) => i !== idx) }))
      setLeavingMcp((prev) => prev.filter((i) => i !== idx))
      setTestResult(null)
    }, 260)
  }
  // 逐条测试连通(独立连接 → 列工具 → 销毁,不进常驻缓存)
  const testServer = async (idx: number) => {
    const row = form.mcpServers[idx]
    if (!row) return
    setTestingIdx(idx)
    setTestResult(null)
    try {
      const res = await window.desktop?.agentTestMcp?.(toConfigServer(row))
      setTestResult(
        res?.ok
          ? { idx, ok: true, text: `连接成功,${res.toolCount ?? 0} 个工具` }
          : { idx, ok: false, text: res?.error || '连接失败' },
      )
    } catch {
      setTestResult({ idx, ok: false, text: '连接失败' })
    } finally {
      setTestingIdx(null)
    }
  }
  const addSkillsDir = () => {
    const d = skillsDirDraft.trim()
    if (!d) return
    setForm((f) => ({ ...f, skillsDirs: f.skillsDirs.includes(d) ? f.skillsDirs : [...f.skillsDirs, d] }))
    setSkillsDirDraft('')
  }
  const removeSkillsDir = (idx: number) => {
    setForm((f) => ({ ...f, skillsDirs: f.skillsDirs.filter((_, i) => i !== idx) }))
  }
  // 移除技能(加入排除列表,即时生效):扫描跳过,候选/工具列表不再出现;
  // 先播离场动画再提交(精致缓动);恢复 = 从排除列表移除
  const excludeSkill = (slug: string) => {
    if (leavingSkills.includes(slug) || excludedSkills.includes(slug)) return
    setLeavingSkills((prev) => [...prev, slug])
    window.setTimeout(() => {
      if (excludedSkills.includes(slug)) {
        setLeavingSkills((prev) => prev.filter((s) => s !== slug))
        return
      }
      const next = [...excludedSkills, slug]
      setExcludedSkills(next)
      setLeavingSkills((prev) => prev.filter((s) => s !== slug))
      window.desktop?.agentSetConfig?.({ excludedSkills: next }).catch(() => {})
    }, 260)
  }
  const includeSkill = (slug: string) => {
    const next = excludedSkills.filter((s) => s !== slug)
    setExcludedSkills(next)
    window.desktop?.agentSetConfig?.({ excludedSkills: next }).catch(() => {})
  }

  // ---- 记忆管理 ----
  const refreshMemory = (result: unknown) => {
    if (result && typeof result === 'object' && 'error' in result) {
      setMemoryError(String((result as { error: string }).error))
      return
    }
    if (Array.isArray(result)) {
      setMemory(result as MemoryEntry[])
      setMemoryError('')
    }
  }
  const addMemory = () => {
    const content = memoryDraft.content.trim()
    if (!content) return
    window.desktop?.agentMemorySet?.({ add: { content, type: memoryDraft.type } })
      .then(refreshMemory)
      .catch(() => setMemoryError('写入失败'))
    setMemoryDraft((d) => ({ ...d, content: '' }))
  }
  const removeMemory = (id: string) => {
    // 先播离场动画,再真正删除(精致缓动:收起后再移除)
    if (leavingMemory.includes(id)) return
    setLeavingMemory((prev) => [...prev, id])
    window.setTimeout(() => {
      window.desktop
        ?.agentMemorySet?.({ remove: id })
        .then((result) => {
          setLeavingMemory((prev) => prev.filter((x) => x !== id))
          refreshMemory(result)
        })
        .catch(() => setLeavingMemory((prev) => prev.filter((x) => x !== id)))
    }, 260)
  }
  const commitMemoryEdit = () => {
    if (!editingMemory || editSaving) return
    const content = editingMemory.content.trim()
    if (!content) return
    // 保存动画三段式(精致缓动):① 保存按钮反馈 ✓ → ② 编辑容器离场
    // 动画 → ③ 提交并退出编辑(行恢复显示新内容)
    setEditSaving(true)
    window.setTimeout(() => {
      setEditLeaving(true)
      window.setTimeout(() => {
        window.desktop
          ?.agentMemorySet?.({ update: { id: editingMemory.id, content } })
          .then(refreshMemory)
          .catch(() => {})
        setEditingMemory(null)
        setEditSaving(false)
        setEditLeaving(false)
      }, 260)
    }, 380)
  }
  // 导出记忆(保存对话框,主进程写文件;JSON 结构同 memory.json 可再导入)
  const exportMemory = async () => {
    setExportMsg('')
    const res = await window.desktop?.agentMemoryExport?.()
    if (!res) return
    if (res.canceled) return
    if (res.error) setExportMsg(`导出失败:${res.error}`)
    else setExportMsg(`已导出到 ${res.path ?? ''}`)
  }
  // 导入记忆(打开对话框选导出的记忆文件 → 主进程校验并合并去重);
  // 导入后立即刷新列表(合并结果立即可见)
  const importMemory = async () => {
    setImportMsg('')
    const res = await window.desktop?.agentMemoryImport?.()
    if (!res) return
    if (res.canceled) return
    if (res.error) {
      setImportMsg(`导入失败:${res.error}`)
      return
    }
    setImportMsg(`已导入 ${res.imported} 条${res.skipped ? `,跳过 ${res.skipped} 条(已存在)` : ''}`)
    window.desktop
      ?.agentMemoryGet?.()
      .then((list) => {
        if (Array.isArray(list)) setMemory(list as MemoryEntry[])
      })
      .catch(() => {})
  }

  // ---- 自我进化 ----
  const runEvolve = async () => {
    setEvolving(true)
    setEvolutionMsg('')
    try {
      const res = await window.desktop?.agentEvolve?.()
      setEvolutionMsg(res?.message ?? '已触发')
      // 触发失败(已在运行中/未配置)恢复按钮;成功则保持"进化中…",
      // 由 evolution-progress / done 事件驱动按钮状态与日志实时刷新
      if (res && res.started === false) setEvolving(false)
    } catch {
      setEvolutionMsg('触发失败')
      setEvolving(false)
    }
  }
  const rollbackEvolution = async () => {
    const msg = await window.desktop?.agentEvolutionRollback?.()
    setEvolutionMsg(msg ?? '')
    window.desktop?.agentMemoryGet?.()
      .then((list) => {
        if (Array.isArray(list)) setMemory(list as MemoryEntry[])
      })
      .catch(() => {})
  }
  // 清除全部版本(回到初始状态):清空日志与快照,展示初始化状态
  const resetEvolution = async () => {
    const msg = await window.desktop?.agentEvolutionReset?.()
    setEvolutionMsg(msg ?? '')
    setEvolutionLog([])
  }
  // 导入技能(文件夹技能包或单个 md):成功后**立即刷新工具清单**——
  // 导入的技能马上出现在列表(Bug 修复:此前提示"重进可见",用户停留在
  // 视图看不到)
  const importSkill = async () => {
    setSkillImportMsg('')
    const res = await window.desktop?.agentSkillImport?.()
    if (!res || res.canceled) return
    if (res.error) {
      setSkillImportMsg(`导入失败:${res.error}`)
      return
    }
    const imported = res.imported ?? []
    const skipped = res.skipped ?? []
    const parts: string[] = []
    if (imported.length > 0) parts.push(`已导入 ${imported.length} 个:${imported.join('、')}`)
    if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 个:${skipped.join('、')}`)
    setSkillImportMsg(parts.join(';') || '未选择内容')
    if (imported.length > 0) {
      try {
        const list = await window.desktop?.agentGetTools?.()
        if (Array.isArray(list)) setLocalTools(list as AgentToolInfo[])
      } catch {
        // 刷新失败:重进设置可见
      }
    }
  }

  // Provider 自动判定(与引擎 detectProvider 同规则):地址含 anthropic
  // → Anthropic Messages;含 chat → DeepSeek Chat Completions;
  // 否则(默认)→ DeepSeek Responses
  const base = form.baseURL.toLowerCase()
  const protocol = base.includes('anthropic')
    ? 'Anthropic Messages'
    : base.includes('chat')
      ? 'DeepSeek Chat'
      : 'DeepSeek Responses'

  return (
    <div className="island-panel-list island-agent-settings">
      <PanelHead title="Agent 设置" count={protocol} />
      <div className="island-agent-protocol">
        {protocol === 'Anthropic Messages'
          ? 'Anthropic 协议:填写含 anthropic 的地址自动切换(如 https://api.deepseek.com/anthropic,模型填 deepseek-chat 等)'
          : protocol === 'DeepSeek Chat'
            ? 'Chat 协议:地址含 chat 自动切换(模型 deepseek-v4-flash 或 deepseek-v4-pro)'
            : 'Responses 协议(默认):DeepSeek 官方端点,模型 deepseek-v4-flash'}
      </div>
      <div className="island-agent-form">
        <label className="island-agent-field">
          <span>API Key</span>
          <input
            type="text"
            value={form.apiKey}
            placeholder="sk-…(DeepSeek 平台创建)"
            spellCheck={false}
            onChange={(event) => setForm((f) => ({ ...f, apiKey: event.target.value }))}
          />
        </label>
        <label className="island-agent-field">
          <span>Base URL</span>
          <input
            type="text"
            value={form.baseURL}
            spellCheck={false}
            onChange={(event) => setForm((f) => ({ ...f, baseURL: event.target.value }))}
          />
        </label>
        <label className="island-agent-field">
          <span>模型</span>
          <input
            type="text"
            value={form.model}
            spellCheck={false}
            onChange={(event) => setForm((f) => ({ ...f, model: event.target.value }))}
          />
        </label>
        <label className="island-agent-field island-agent-field--grow">
          <span>自定义提示词(与长期记忆一起构成系统提示)</span>
          <textarea
            value={form.systemPrompt}
            rows={3}
            onChange={(event) => setForm((f) => ({ ...f, systemPrompt: event.target.value }))}
          />
        </label>
        <div className="island-agent-field">
          <span>思考强度(深度思考 vs 速度)</span>
          <div className="island-agent-scale-row">
            {(
              [
                ['none', '关'],
                ['low', '低(快)'],
                ['medium', '中'],
                ['high', '高(深)'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={`island-agent-scale-btn${form.reasoningEffort === v ? ' on' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  setForm((f) => ({ ...f, reasoningEffort: v }))
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="island-agent-field">
          <span>界面放大(仅面板尺寸,文字按钮不变)</span>
          <div className="island-agent-scale-row">
            {[100, 150, 200].map((v) => (
              <button
                key={v}
                type="button"
                className={`island-agent-scale-btn${scale === v ? ' on' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onScaleChange(v)
                }}
              >
                {v}%
              </button>
            ))}
            <input
              type="number"
              min={100}
              max={300}
              value={draftScale}
              spellCheck={false}
              onChange={(event) => setDraftScale(event.target.value)}
              onBlur={commitScale}
              onKeyDown={handleScaleKeyDown}
            />
            <span className="island-agent-scale-hint">%</span>
          </div>
        </div>

        {/* MCP 服务:stdio 进程 / sse 远程端点,每个服务暴露 mcp_<服务>_<工具> 工具 */}
        <div className="island-agent-section">
          <span className="island-agent-section-title">MCP 服务(MCP 服务端工具接入)</span>
          <span className="island-agent-section-hint">
            也可对话中说"添加一个 MCP 服务:…"让 Agent 自己配置;stdio 的 npx 命令自动经 cmd 启动,参数每行一个
          </span>
          {/* 按程序分组:同一程序的多个服务归一个大类(组头可折叠) */}
          {mcpGroups.map(({ group, indices }) => (
            <div key={group} className="island-mcp-group">
              <button
                type="button"
                className="island-mcp-group-head"
                onClick={(event) => {
                  event.stopPropagation()
                  toggleMcpGroup(group)
                }}
              >
                <span className="island-mcp-group-name">{group}</span>
                <span className="island-mcp-group-count">{indices.length} 个服务</span>
                <span className={`island-mcp-group-arrow${mcpCollapsed[group] ? '' : ' open'}`}>▾</span>
              </button>
              <div className={`island-mcp-group-body${mcpCollapsed[group] ? ' collapsed' : ''}`}>
                {indices.map((idx) => {
                  const server = form.mcpServers[idx]
                  return (
            <div
              key={idx}
              className={`island-mcp-card${leavingMcp.includes(idx) ? ' island-ui-leave' : ''}`}
            >
              <div className="island-mcp-head">
                <span className="island-mcp-name">服务 {idx + 1}</span>
                <div className="island-mcp-actions">
                  <button
                    type="button"
                    className="island-agent-scale-btn"
                    disabled={testingIdx === idx || !server.name.trim()}
                    onClick={(event) => {
                      event.stopPropagation()
                      void testServer(idx)
                    }}
                  >
                    {testingIdx === idx ? '测试中…' : '测试'}
                  </button>
                  <button
                    type="button"
                    className="island-agent-scale-btn island-mcp-remove"
                    onClick={(event) => {
                      event.stopPropagation()
                      removeServer(idx)
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
              <div className="island-mcp-type-row">
                <button
                  type="button"
                  className={`island-agent-scale-btn${server.type === 'stdio' ? ' on' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    patchServer(idx, { type: 'stdio' })
                  }}
                >
                  本地进程(stdio)
                </button>
                <button
                  type="button"
                  className={`island-agent-scale-btn${server.type === 'sse' ? ' on' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    patchServer(idx, { type: 'sse' })
                  }}
                >
                  远程端点(sse)
                </button>
              </div>
              <label className="island-agent-field">
                <span>服务名(工具名前缀)</span>
                <input
                  type="text"
                  value={server.name}
                  placeholder="如 filesystem"
                  spellCheck={false}
                  onChange={(event) => patchServer(idx, { name: event.target.value })}
                />
              </label>
              {server.type === 'sse' ? (
                <>
                  <label className="island-agent-field">
                    <span>端点 URL</span>
                    <input
                      type="text"
                      value={server.url}
                      placeholder="如 https://example.com/mcp/sse"
                      spellCheck={false}
                      onChange={(event) => patchServer(idx, { url: event.target.value, command: event.target.value })}
                    />
                  </label>
                  <label className="island-agent-field">
                    <span>请求头(每行 KEY=VALUE,可选)</span>
                    <textarea
                      rows={1}
                      value={server.headers.join('\n')}
                      placeholder="如 Authorization=Bearer xxx"
                      onChange={(event) => patchServer(idx, { headers: event.target.value.split('\n') })}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="island-agent-field">
                    <span>启动命令</span>
                    <input
                      type="text"
                      value={server.command}
                      placeholder="如 npx -y @modelcontextprotocol/server-filesystem"
                      spellCheck={false}
                      onChange={(event) => patchServer(idx, { command: event.target.value })}
                    />
                  </label>
                  <label className="island-agent-field">
                    <span>参数(每行一个;含空格路径按整行传)</span>
                    <textarea
                      rows={2}
                      value={server.args.join('\n')}
                      placeholder={'如\nC:/Users/asus/Documents'}
                      onChange={(event) => patchServer(idx, { args: event.target.value.split('\n') })}
                    />
                  </label>
                  <label className="island-agent-field">
                    <span>环境变量(每行 KEY=VALUE,可选)</span>
                    <textarea
                      rows={1}
                      value={server.env.join('\n')}
                      placeholder="如 GITHUB_TOKEN=ghp_xxx"
                      onChange={(event) => patchServer(idx, { env: event.target.value.split('\n') })}
                    />
                  </label>
                </>
              )}
              {testResult && testResult.idx === idx ? (
                <span className={`island-mcp-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
                  {testResult.ok ? '✓ ' : '✗ '}
                  {testResult.text}
                </span>
              ) : null}
            </div>
                  )
                })}
              </div>
            </div>
          ))}
          <button
            type="button"
            className="island-agent-scale-btn"
            onClick={(event) => {
              event.stopPropagation()
              addServer()
            }}
          >
            + 添加服务
          </button>
        </div>

        {/* 技能目录:扫描 SKILL.md,每个技能暴露 skill_<名字> 工具 */}
        <div className="island-agent-section">
          <span className="island-agent-section-title">技能目录(扫描 SKILL.md 注册为技能工具)</span>
          <span className="island-agent-section-hint">
            默认扫描 Claude Code / Codex / opencode 技能目录;对话中可发 /技能名 直接调用
          </span>
          {form.skillsDirs.map((dir, idx) => (
            <div key={idx} className="island-skills-dir-row">
              <span className="island-skills-dir-path">{dir}</span>
              <button
                type="button"
                className="island-agent-scale-btn island-mcp-remove"
                onClick={(event) => {
                  event.stopPropagation()
                  removeSkillsDir(idx)
                }}
              >
                删除
              </button>
            </div>
          ))}
          <div className="island-agent-scale-row">
            <input
              type="text"
              value={skillsDirDraft}
              placeholder="输入技能目录绝对路径"
              spellCheck={false}
              onChange={(event) => setSkillsDirDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addSkillsDir()
              }}
            />
            <button
              type="button"
              className="island-agent-scale-btn"
              onClick={(event) => {
                event.stopPropagation()
                addSkillsDir()
              }}
            >
              添加
            </button>
            <button
              type="button"
              className="island-agent-scale-btn"
              title="选择技能包文件夹(含 SKILL.md 与脚本等)或单个 .md 技能文件"
              onClick={(event) => {
                event.stopPropagation()
                void importSkill()
              }}
            >
              导入技能
            </button>
          </div>
          {skillImportMsg ? (
            <span className="island-mcp-test-result ok island-ui-enter">{skillImportMsg}</span>
          ) : null}
          {/* 已注册技能预览(agent:tools 异步加载;三区:灵动岛创建 / 手动导入 /
              扫描到的;排除列表本地过滤,移除即时生效) */}
          <div className="island-skills-registered">
            {shownTools.length === 0 ? (
              <span className="island-agent-section-hint">技能清单加载中…</span>
            ) : (
              <>
                {/* 灵动岛创建(引擎 create / 自然语言,userData/skills 无导入标记) */}
                {createdSkills.length > 0 ? (
                  <>
                    <span className="island-skills-reg-count">
                      灵动岛创建({createdSkills.length})
                    </span>
                    {createdSkills.map((t) => (
                      <SkillRow key={t.name} t={t} leaving={leavingSkills.includes(t.name.replace(/^skill_/, ''))} onExclude={excludeSkill} />
                    ))}
                  </>
                ) : null}
                {/* 手动导入(agent:skill-import,技能目录有 .island-imported 标记) */}
                {importedSkills.length > 0 ? (
                  <>
                    <span className="island-skills-reg-count">
                      手动导入({importedSkills.length})
                    </span>
                    {importedSkills.map((t) => (
                      <SkillRow key={t.name} t={t} leaving={leavingSkills.includes(t.name.replace(/^skill_/, ''))} onExclude={excludeSkill} />
                    ))}
                  </>
                ) : null}
                {/* 扫描到的外部技能(Claude Code/Codex/opencode 等目录) */}
                {scannedSkills.length > 0 ? (
                  <>
                    <span className="island-skills-reg-count">
                      扫描到的({scannedSkills.length})
                    </span>
                    {scannedSkills.map((t) => (
                      <SkillRow key={t.name} t={t} leaving={leavingSkills.includes(t.name.replace(/^skill_/, ''))} onExclude={excludeSkill} />
                    ))}
                  </>
                ) : null}
              </>
            )}
            {/* 已排除技能:可恢复 */}
            {excludedSkills.length > 0 ? (
              <div className="island-skills-excluded">
                <span className="island-skills-reg-count">已移除 {excludedSkills.length} 个技能(扫描跳过)</span>
                {excludedSkills.map((slug) => (
                  <div key={slug} className="island-skills-reg-row">
                    <span className="island-skills-reg-name">{slug}</span>
                    <span className="island-skills-reg-desc">已排除,对话中不可用</span>
                    <button
                      type="button"
                      className="island-agent-scale-btn"
                      onClick={(event) => {
                        event.stopPropagation()
                        includeSkill(slug)
                      }}
                    >
                      恢复
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {/* 记忆系统:长期记忆条目(偏好/事实/工作流/教训),对话中 LLM
            也会自动沉淀(remember 工具),此处人工增删改 */}
        <div className="island-agent-section">
          <span className="island-agent-section-title">长期记忆({memory.length} 条,自动附加到系统提示)</span>
          <span className="island-agent-section-hint">
            对话中可直接说"记住:…"让 Agent 写入;记忆条目也参与自我进化
          </span>
          {memory.map((entry) => (
            <div
              key={entry.id}
              className={`island-memory-row${leavingMemory.includes(entry.id) ? ' island-ui-leave' : ''}`}
            >
              {editingMemory?.id === entry.id ? (
                // 编辑态:进入回弹动画;保存 = ✓ 反馈 → 离场动画 → 提交退出
                <div
                  className={`island-memory-edit${editLeaving ? ' island-ui-leave' : ' island-ui-enter'}`}
                >
                  <input
                    type="text"
                    value={editingMemory.content}
                    spellCheck={false}
                    onChange={(event) => setEditingMemory({ id: entry.id, content: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitMemoryEdit()
                      if (event.key === 'Escape') setEditingMemory(null)
                    }}
                  />
                  <button type="button" className="island-agent-scale-btn" disabled={editSaving} onClick={commitMemoryEdit}>
                    {editSaving ? '✓' : '保存'}
                  </button>
                </div>
              ) : (
                <>
                  <span className={`island-memory-type t-${entry.type}`}>{MEMORY_TYPES.find(([v]) => v === entry.type)?.[1] ?? entry.type}</span>
                  <span className="island-memory-content" title={entry.content}>
                    {entry.content}
                  </span>
                  <button
                    type="button"
                    className="island-agent-scale-btn"
                    onClick={() => setEditingMemory({ id: entry.id, content: entry.content })}
                  >
                    改
                  </button>
                  <button
                    type="button"
                    className="island-agent-scale-btn island-mcp-remove"
                    onClick={() => removeMemory(entry.id)}
                  >
                    删
                  </button>
                </>
              )}
            </div>
          ))}
          <div className="island-agent-scale-row">
            <MemoryTypeSelect
              value={memoryDraft.type}
              onChange={(v) => setMemoryDraft((d) => ({ ...d, type: v }))}
            />
            <input
              type="text"
              value={memoryDraft.content}
              placeholder="如:我喜欢简洁的回答"
              spellCheck={false}
              onChange={(event) => setMemoryDraft((d) => ({ ...d, content: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addMemory()
              }}
            />
            <button type="button" className="island-agent-scale-btn" onClick={addMemory}>
              添加
            </button>
            <button
              type="button"
              className="island-agent-scale-btn"
              title="从导出的记忆文件合并导入"
              onClick={(event) => {
                event.stopPropagation()
                void importMemory()
              }}
            >
              导入
            </button>
            <button
              type="button"
              className="island-agent-scale-btn"
              disabled={memory.length === 0}
              onClick={(event) => {
                event.stopPropagation()
                void exportMemory()
              }}
            >
              导出
            </button>
          </div>
          {memoryError ? <span className="island-mcp-test-result fail">{memoryError}</span> : null}
          {exportMsg ? <span className="island-mcp-test-result ok">{exportMsg}</span> : null}
          {importMsg ? (
            <span className={`island-mcp-test-result ${importMsg.startsWith('导入失败') ? 'fail' : 'ok'}`}>
              {importMsg}
            </span>
          ) : null}
        </div>

        {/* 自我进化:版本化多轮候选循环(参考 penguin-harness)——每轮
            评估 → 带假说的改进 → 复评 → 评分严格提高才接受为新版本,
            拒绝自动恢复;可回滚到最近一个已接受版本 */}
        <div className="island-agent-section">
          <span className="island-agent-section-title">自我进化(记忆版本化优化)</span>
          <span className="island-agent-section-hint">
            后台运行:每轮评估 → 假说改进 → 复评 → 评分严格提高才存档为新版本,否则自动恢复;可连续多轮,完成发系统通知
          </span>
          <div className="island-agent-scale-row">
            <button
              type="button"
              className="island-agent-scale-btn"
              disabled={evolving}
              onClick={(event) => {
                event.stopPropagation()
                void runEvolve()
              }}
            >
              {evolving ? '进化中…' : '运行记忆进化(2 轮)'}
            </button>
            <button
              type="button"
              className="island-agent-scale-btn island-mcp-remove"
              disabled={evolutionLog.length === 0}
              onClick={(event) => {
                event.stopPropagation()
                void rollbackEvolution()
              }}
            >
              回滚到上一版本
            </button>
            <button
              type="button"
              className="island-agent-scale-btn island-mcp-remove"
              disabled={evolutionLog.length === 0}
              onClick={(event) => {
                event.stopPropagation()
                void resetEvolution()
              }}
            >
              清除所有版本
            </button>
          </div>
          {evolutionMsg ? (
            <span className="island-mcp-test-result ok island-ui-enter">{evolutionMsg}</span>
          ) : null}
          {evolutionLog.length > 0 ? (
            <div className="island-evolution-log">
              {evolutionLog.slice(0, 3).map((log, i) => (
                <div key={i} className="island-evolution-row island-ui-enter">
                  <span className={`island-evolution-badge ${log.applied ? 'ok' : 'fail'}`}>
                    {log.applied ? `已应用 v${log.version}` : '已回滚'}
                  </span>
                  <span className="island-evolution-summary">{log.summary}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="island-agent-section-hint island-ui-enter">暂无进化记录,点击"运行记忆进化"开始</span>
          )}
        </div>
      </div>
      <div className="island-agent-form-foot">
        <button
          type="button"
          className="island-ctl island-ctl--upload"
          onClick={(event) => {
            event.stopPropagation()
            save()
          }}
        >
          <svg
            className="island-ctl-svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          <span>保存配置</span>
        </button>
        <span className="island-agent-saved">{saved ? '已保存 ✓' : ''}</span>
      </div>
      <BackFoot onBack={onBack} />
    </div>
  )
}

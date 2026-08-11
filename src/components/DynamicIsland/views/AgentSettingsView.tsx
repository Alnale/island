/**
 * Agent 设置视图(设置视图"Agent 设置"入口,设置类视图:只能经返回键退出)
 *
 * 字段:API Key / Base URL / 模型 / 自定义提示词 / 思考强度 / 界面放大 /
 * MCP 服务列表(stdio 进程或 sse 远程端点,逐条"测试"连通)/
 * 技能目录列表(扫描 SKILL.md)/ **记忆系统**(结构化长期记忆:偏好/事实/
 * 工作流/教训,增删改)/ **自我进化**(一键触发记忆自主优化,日志 + 回滚)。
 * 保存经 onSave 走主进程 settings.json(agent 段),记忆与进化走独立 IPC。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentConfig, AgentToolInfo, McpServerConfig, MemoryEntry } from '../../../agent/types'
import { MIND_PERSONAS, SUMMARY_STYLES, providerLabel } from '../../../../electron/agent/constants'
import { useLeavingList } from '../../../hooks/useLeavingList'
import { BackFoot, PanelHead } from './shared'
import { QuickMenu } from './QuickMenu'

export interface AgentSettingsViewProps {
  config: AgentConfig | null
  onSave: (patch: Partial<AgentConfig>) => void
  /** 工具清单(已注册技能/MCP 的预览展示;agent:tools 异步加载) */
  tools?: AgentToolInfo[]
  /** 界面缩放(百分比 100-400,最低 100%) */
  scale: number
  onScaleChange: (scale: number) => void
  /** 媒体窗口默认宽(对话图片/视频窗口初始宽;localStorage 即时生效,
   * 2026-08-08) */
  mediaWindowWidth: number
  onMediaWindowWidthChange: (width: number) => void
  onBack: () => void
}

/** Agent 设置分组菜单(2026-08-07 布局重构:相似功能收进分组菜单,
 * 由整合按钮悬浮展开切换;保存脚全局共用。第 5 组「Sub Agent」=
 * 总结标题文风 + 心理揣测人格设置)。渲染用通用 QuickMenu 组件
 * (整合按钮 + 同行联通展开 + 滚轮 + 高亮滑块 + 宽度过渡,同款设计) */
const SETTINGS_TABS = ['账号', '行为与界面', '工具与能力', '记忆与进化', 'Sub Agent', '数据管理'] as const

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

/** MCP 服务卡片(表单编辑:名称/传输类型/命令或端点/参数与头;
 * 拆分自设置视图主组件,审计 P1 #7——原 ~123 行 JSX 嵌在分组 map 里
 * 4 层缩进,props 化后自包含可独立测试) */
function McpServerCard({
  idx,
  server,
  testing,
  testResult,
  leaving,
  onTest,
  onRemove,
  onPatch,
}: {
  idx: number
  server: McpServerForm
  /** 正在测试连通(按钮显示"测试中…") */
  testing: boolean
  /** 测试结果(仅显示本卡 idx 的) */
  testResult: { idx: number; ok: boolean; text: string } | null
  /** 离场动画中(挂 island-ui-leave) */
  leaving: boolean
  onTest(idx: number): void
  onRemove(idx: number): void
  onPatch(idx: number, patch: Partial<McpServerForm>): void
}) {
  const patch = (p: Partial<McpServerForm>) => onPatch(idx, p)
  return (
    <div
      className={`island-mcp-card${leaving ? ' island-ui-leave' : ''}`}
>
  <div className="island-mcp-head">
    <span className="island-mcp-name">服务 {idx + 1}</span>
    <div className="island-mcp-actions">
      <button
        type="button"
        className="island-agent-scale-btn"
        disabled={testing || !server.name.trim()}
        onClick={(event) => {
          event.stopPropagation()
          onTest(idx)
        }}
      >
        {testing ? '测试中…' : '测试'}
      </button>
      <button
        type="button"
        className="island-agent-scale-btn island-mcp-remove"
        onClick={(event) => {
          event.stopPropagation()
          onRemove(idx)
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
        patch({ type: 'stdio' })
      }}
    >
      本地进程(stdio)
    </button>
    <button
      type="button"
      className={`island-agent-scale-btn${server.type === 'sse' ? ' on' : ''}`}
      onClick={(event) => {
        event.stopPropagation()
        patch({ type: 'sse' })
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
      onChange={(event) => patch({ name: event.target.value })}
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
          onChange={(event) => patch({ url: event.target.value, command: event.target.value })}
        />
      </label>
      <label className="island-agent-field">
        <span>请求头(每行 KEY=VALUE,可选)</span>
        <textarea
          rows={1}
          value={server.headers.join('\n')}
          placeholder="如 Authorization=Bearer xxx"
          onChange={(event) => patch({ headers: event.target.value.split('\n') })}
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
          onChange={(event) => patch({ command: event.target.value })}
        />
      </label>
      <label className="island-agent-field">
        <span>参数(每行一个;含空格路径按整行传)</span>
        <textarea
          rows={2}
          value={server.args.join('\n')}
          placeholder={'如\nC:/Users/asus/Documents'}
          onChange={(event) => patch({ args: event.target.value.split('\n') })}
        />
      </label>
      <label className="island-agent-field">
        <span>环境变量(每行 KEY=VALUE,可选)</span>
        <textarea
          rows={1}
          value={server.env.join('\n')}
          placeholder="如 GITHUB_TOKEN=ghp_xxx"
          onChange={(event) => patch({ env: event.target.value.split('\n') })}
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
}


const MEMORY_TYPES: Array<[MemoryEntry['type'], string]> = [
  ['preference', '偏好'],
  ['fact', '事实'],
  ['workflow', '工作流'],
  ['lesson', '教训'],
]

/**
 * 记忆类型下拉(2026-08-07 重构:复用通用 QuickMenu——整合按钮 + 同行
 * 联通展开 + 滚轮逐格切换 + 高亮滑块 + 宽度过渡,与 Agent 设置菜单
 * 同款设计;替代原生 select)。**默认选中的类型是偏好**(用户要求)。
 * 输入框宽度联动:QuickMenu 展开时菜单占位,添加行是 flex 容器,
 * 输入框 flex:1 + min-width:0 自动实时收缩(无需 JS)
 */
function MemoryTypeSelect({
  value,
  onChange,
}: {
  value: MemoryEntry['type']
  onChange: (v: MemoryEntry['type']) => void
}) {
  // 类型徽标(按钮 WheelSwap 与菜单项共用;标签按类型查表)
  const typeBadgeNode = (v: MemoryEntry['type']) => (
    <span className={`island-memory-type t-${v}`}>{MEMORY_TYPES.find(([t]) => t === v)?.[1] ?? v}</span>
  )
  return (
    <QuickMenu
      items={MEMORY_TYPES.map(([v]) => v)}
      value={value}
      onChange={onChange}
      getLabel={typeBadgeNode}
      title="记忆类型(滚轮切换)"
      wheelWhenOpen
    />
  )
}

/** 输出预算 2 的幂预设(2026-08-08 定制步进器):与 set_output_budget
 * 工具同范围,常用档位一键设置;缺省 8192 即在预设中 */
const BUDGET_PRESETS = [8192, 16384, 32768, 65536, 131072, 262144]

/* ---- 2026-08-08 QuickMenu 化(用户要求:均采用 Agent 设置面板左上角
   快捷菜单的选取与滚轮切换;自定义值参考输出预算按钮,内联输入) ---- */

/** 思考强度档位(默认高):none 关闭思考模式,low/medium/high 递增强度 */
const REASONING_OPTIONS = ['none', 'low', 'medium', 'high'] as const
const REASONING_LABELS: Record<string, string> = {
  none: '关',
  low: '低(快)',
  medium: '中',
  high: '高(深)',
}

/** 主动陪伴触发间隔预设(默认 15,分钟单位;可自定义 5-480) */
const PROACTIVE_PRESETS = [15, 30, 60, 120]
/** 主动陪伴间隔单位(秒/分钟/小时;默认分钟,**数值不变仅换单位**) */
const PROACTIVE_UNITS = ['s', 'm', 'h'] as const
const PROACTIVE_UNIT_LABELS: Record<string, string> = { s: '秒', m: '分钟', h: '小时' }

/** 界面放大档位(默认 200;可自定义 100-400,仅面板/窗口尺寸放大,
 *  UI 元素不缩放;2026-08-11 用户要求 300% → 400%) */
const SCALE_PRESETS = [100, 150, 200, 300, 400]

/** Sub Agent 档位:默认(空串)+ 预设 id;自定义 ≤100 字直接存文本
 *  (值不在档位时按钮显示文本、无高亮,滚轮不切换) */
const SUMMARY_STYLE_ITEMS: string[] = ['', ...SUMMARY_STYLES.map((s) => s.id)]
const summaryStyleLabel = (id: string) =>
  id ? SUMMARY_STYLES.find((s) => s.id === id)?.name ?? id : '默认'
const MIND_PERSONA_ITEMS: string[] = ['', ...MIND_PERSONAS.map((p) => p.id)]
const mindPersonaLabel = (id: string) =>
  id ? MIND_PERSONAS.find((p) => p.id === id)?.name ?? id : '默认'

/** 媒体窗口默认宽档位(2026-08-08):QuickMenu 悬浮展开,可自定义 160-800 */
const MEDIA_WINDOW_PRESETS = [240, 320, 480, 640]

/** 预算显示格式:整 K 显示 8K/256K(按钮与菜单项用;编辑态仍原始数字) */
function formatBudget(v: number): string {
  if (v % 1024 === 0) return `${Math.round(v / 1024)}K`
  return String(v)
}

/** 技能行(设置技能区;移除 = 加入排除列表;leaving = 离场动画中;
 * canDelete = 彻底删除(2026-08-11 用户要求:灵动岛创建分区支持彻底删除,
 * 不进恢复区)——两段式确认(同清除数据:首次点击进入确认态 3.5s 自动
 * 复位,再次点击执行),删除即从磁盘消失,不可恢复) */
function SkillRow({
  t,
  leaving,
  canDelete,
  onExclude,
  onDelete,
}: {
  t: AgentToolInfo
  leaving: boolean
  canDelete?: boolean
  onExclude: (slug: string) => void
  onDelete?: (slug: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const confirmTimerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(confirmTimerRef.current), [])
  const requestDelete = (slug: string) => {
    if (!onDelete) return
    if (!confirming) {
      setConfirming(true)
      window.clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = window.setTimeout(() => setConfirming(false), 3500)
      return
    }
    window.clearTimeout(confirmTimerRef.current)
    setConfirming(false)
    onDelete(slug)
  }
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
      {canDelete ? (
        <button
          type="button"
          className={`island-agent-scale-btn island-data-clear${confirming ? ' confirming' : ''}`}
          title="彻底删除(从磁盘移除,不可恢复,不会进入下方已移除区)"
          onClick={(event) => {
            event.stopPropagation()
            requestDelete(t.name.replace(/^skill_/, ''))
          }}
        >
          {confirming ? '再次点击确认删除' : '删除'}
        </button>
      ) : null}
    </div>
  )
}

/** 技能注册区(灵动岛创建 / 手动导入 / 扫描到的三区共用;审计 P1 #7:
 * 原同一区块复制 3 遍,仅标签与条目谓词不同;canDelete = 该区技能支持
 * 彻底删除(应用自有副本,2026-08-11) */
function SkillsSection({
  label,
  skills,
  leavingIds,
  canDelete,
  onExclude,
  onDelete,
}: {
  label: string
  skills: AgentToolInfo[]
  leavingIds: readonly string[]
  canDelete?: boolean
  onExclude: (slug: string) => void
  onDelete?: (slug: string) => void
}) {
  if (skills.length === 0) return null
  return (
    <>
      <span className="island-skills-reg-count">
        {label}({skills.length})
      </span>
      {skills.map((t) => (
        <SkillRow
          key={t.name}
          t={t}
          leaving={leavingIds.includes(t.name.replace(/^skill_/, ''))}
          canDelete={canDelete}
          onExclude={onExclude}
          onDelete={onDelete}
        />
      ))}
    </>
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

export function AgentSettingsView({
  config,
  onSave,
  tools,
  scale,
  onScaleChange,
  mediaWindowWidth,
  onMediaWindowWidthChange,
  onBack,
}: AgentSettingsViewProps) {
  const [form, setForm] = useState({
    apiKey: '',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    systemPrompt: '',
    reasoningEffort: 'high',
    // 主对话输出预算(2026-08-08):缺省 8192(与 main 默认一致;
    // 预算只是上限,LLM 任务巨大时经 set_output_budget 按需调大)
    maxOutputTokens: 8192,
    // 主动陪伴(2026-08-07):默认开启;间隔 15、单位分钟(2026-08-08
    // 用户要求默认 15 分钟,与 main 默认一致;单位选择:数值不变仅换
    // 单位;exec_command 确认门设置已移除)
    proactiveEnabled: true,
    proactiveInterval: 15,
    proactiveIntervalUnit: 'm' as 's' | 'm' | 'h',
    // Sub Agent 设置(2026-08-07):文风/人格预设 id 或自定义 ≤100 字
    summaryStyle: '',
    mindPersona: '',
    mcpServers: [] as McpServerForm[],
    skillsDirs: [] as string[],
  })
  // 分组菜单(2026-08-07 布局重构):连接 / 行为与界面 / 工具与能力 /
  // 记忆与进化 / Sub Agent;切换只重挂载内容区,表单状态共享不丢失
  const [tab, setTab] = useState(0)
  // 菜单切换动画(2026-08-07 二次优化):**交叉切换**——离场动画(0.2s)
  // 播 60%(0.12s)即挂载新内容,入场(0.32s)与离场尾部重叠:旧内容上移
  // 淡出中,新内容下移淡入,无"慢一拍"停顿感(用户要求动画对齐);
  // leaving 期间忽略重复切换
  const [leaving, setLeaving] = useState(false)
  const [animSeq, setAnimSeq] = useState(0)
  const leavingRef = useRef(false)
  const switchTab = useCallback((next: number) => {
    if (next === tabRef.current || leavingRef.current) return
    leavingRef.current = true
    setLeaving(true)
    window.setTimeout(() => {
      leavingRef.current = false
      setLeaving(false)
      setTab(next)
      setAnimSeq((s) => s + 1)
    }, 120)
  }, [])
  const tabRef = useRef(0)
  useEffect(() => {
    tabRef.current = tab
  }, [tab])
  // 账号余额(2026-08-11 用户要求"Agent 设置里添加账号余额查询功能,
  // API 配置集成到账号功能"):进入账号 tab(0)自动查询一次,可手动
  // 刷新;数据源 = 引擎 get_deepseek_balance 同一实现(agent:balance IPC)
  const [balance, setBalance] = useState<{
    isAvailable: boolean
    balances: Array<{ currency: string; total: number; granted: number; toppedUp: number }>
  } | null>(null)
  const [balanceError, setBalanceError] = useState('')
  const [balanceLoading, setBalanceLoading] = useState(false)
  const queryBalance = useCallback(async () => {
    setBalanceLoading(true)
    setBalanceError('')
    try {
      const res = await window.desktop?.agentGetBalance?.()
      if (!res) {
        setBalanceError('余额查询不可用(请先配置 API Key)')
        return
      }
      if ('error' in res && typeof (res as { error?: unknown }).error === 'string') {
        setBalanceError(String((res as { error: string }).error))
        return
      }
      setBalance(res as { isAvailable: boolean; balances: Array<{ currency: string; total: number; granted: number; toppedUp: number }> })
    } catch (err) {
      setBalanceError((err as Error).message || String(err))
    } finally {
      setBalanceLoading(false)
    }
  }, [])
  // 进入账号 tab 自动查询一次(挂载 tab=0 也触发;余额反映当前配置)
  useEffect(() => {
    if (tab === 0) void queryBalance()
  }, [tab, queryBalance])
  const [saved, setSaved] = useState(false)
  const savedTimerRef = useRef(0)
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
  // 添加行默认类型 = 偏好(2026-08-07 用户要求:快捷菜单默认选中的类型是偏好)
  const [memoryDraft, setMemoryDraft] = useState({ type: 'preference' as MemoryEntry['type'], content: '' })
  const [editingMemory, setEditingMemory] = useState<{ id: string; content: string } | null>(null)
  // 导出状态(成功显示路径/取消/失败)
  const [exportMsg, setExportMsg] = useState('')
  // 导入状态(成功显示导入/跳过计数;失败显示错误)
  const [importMsg, setImportMsg] = useState('')
  // 离场动画中的条目 id(先播完收起动画,再真正移除)
  // 离场动画列表(记忆/技能/MCP 卡片;useLeavingList 收敛定时器模式,
  // 审计 P2;mcp 下标数字转字符串作 id)
  const memoryLeave = useLeavingList()
  const skillsLeave = useLeavingList()
  const mcpLeave = useLeavingList()
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
  // 数据管理(2026-08-10 用户要求):清除数据两段式确认——第一次点击
  // 进入确认态(3.5s 无操作自动复位),再次点击执行;scope = 'app' 灵动岛
  // 所有数据 / 'tools' 工具下载记录及源文件
  const [confirmClear, setConfirmClear] = useState<'app' | 'tools' | null>(null)
  const [clearMsg, setClearMsg] = useState('')
  const clearConfirmTimerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(clearConfirmTimerRef.current), [])
  const requestClear = (scope: 'app' | 'tools') => {
    if (confirmClear !== scope) {
      setConfirmClear(scope)
      setClearMsg('')
      window.clearTimeout(clearConfirmTimerRef.current)
      clearConfirmTimerRef.current = window.setTimeout(() => setConfirmClear(null), 3500)
      return
    }
    window.clearTimeout(clearConfirmTimerRef.current)
    setConfirmClear(null)
    void doClear(scope)
  }
  const doClear = async (scope: 'app' | 'tools') => {
    try {
      // 渲染端数据:localStorage(widget-* 全部:主题/缩放/背景/字体/歌词/
      // 消息/会话/标题/揣测/视频偏好/seek 记忆…) + IndexedDB 五个库
      // (上传音乐/背景与图片库/字体库/音频库/视频库)。
      // 删除请求在 blocked(页面自身连接)时直接放行——reload 销毁连接后
      // 浏览器自动完成删除;localStorage.clear 同步生效
      try {
        localStorage.clear()
      } catch {
        // 清除失败忽略(部分隐私模式)
      }
      const DB_NAMES = [
        'island-uploads',
        'island-background',
        'island-font',
        'island-audio-library',
        'island-video-library',
      ]
      for (const db of DB_NAMES) {
        await new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(db)
          req.onsuccess = () => resolve()
          req.onerror = () => resolve()
          req.onblocked = () => resolve() // reload 销毁连接后浏览器续删
        })
      }
      // 主进程文件(main.cjs agent:clear-data):app = 记忆/进化/settings.json;
      // tools = bili 下载与登录态 / xxt 登录态与截图
      const res = await window.desktop?.agentClearData?.(scope)
      if (res && typeof res === 'object' && typeof res.error === 'string') {
        setClearMsg(`清除失败:${res.error}(文件可能被占用,如 B站下载中——稍后重试)`)
        return
      }
      setClearMsg('已清除,正在重启界面…')
      window.setTimeout(() => window.location.reload(), 800)
    } catch {
      setClearMsg('清除失败,请重试')
    }
  }
  // 配置到达后填充表单(config 未变时不覆盖用户正在编辑的内容)
  useEffect(() => {
    if (config) {
      setForm({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model,
        systemPrompt: config.systemPrompt,
        reasoningEffort: config.reasoningEffort || 'high',
        maxOutputTokens: config.maxOutputTokens ?? 8192,
        // 主动陪伴:旧 settings.json 无字段时按默认(true/15/分钟)兜底
        proactiveEnabled: config.proactiveEnabled !== false,
        proactiveInterval: config.proactiveInterval ?? 15,
        proactiveIntervalUnit: config.proactiveIntervalUnit ?? 'm',
        // Sub Agent 设置:旧配置无字段 → 空(默认文风/人格)
        summaryStyle: config.summaryStyle ?? '',
        mindPersona: config.mindPersona ?? '',
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
  /** 拉取记忆列表(挂载/导入/回滚/进化完成共用;审计 P1 #7:
   * 原 4 处「agentMemoryGet().then(setMemory)」逐字重复) */
  const loadMemoryList = useCallback(() => {
    window.desktop?.agentMemoryGet?.()
      .then((list) => {
        if (Array.isArray(list)) setMemory(list as MemoryEntry[])
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadMemoryList()
    refreshEvolutionLog()
  }, [loadMemoryList, refreshEvolutionLog])
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
      maxOutputTokens: form.maxOutputTokens,
      proactiveEnabled: form.proactiveEnabled,
      proactiveInterval: form.proactiveInterval,
      proactiveIntervalUnit: form.proactiveIntervalUnit,
      summaryStyle: form.summaryStyle,
      mindPersona: form.mindPersona,
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
    if (mcpLeave.leavingIds.includes(String(idx))) return
    mcpLeave.beginLeave(String(idx), () => {
      setForm((f) => ({ ...f, mcpServers: f.mcpServers.filter((_, i) => i !== idx) }))
      setTestResult(null)
    })
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
    if (skillsLeave.leavingIds.includes(slug) || excludedSkills.includes(slug)) return
    skillsLeave.beginLeave(slug, () => {
      // 动画期间可能已被恢复(include):跳过提交
      if (excludedSkills.includes(slug)) return
      const next = [...excludedSkills, slug]
      setExcludedSkills(next)
      window.desktop?.agentSetConfig?.({ excludedSkills: next }).catch(() => {})
    })
  }
  const includeSkill = (slug: string) => {
    const next = excludedSkills.filter((s) => s !== slug)
    setExcludedSkills(next)
    window.desktop?.agentSetConfig?.({ excludedSkills: next }).catch(() => {})
  }
  // 彻底删除技能(2026-08-11 用户要求:灵动岛创建分区支持彻底删除,不进
  // 恢复区):主进程删 userData/skills/<slug> 目录(应用自有副本,扫描
  // 到的外部技能不在该目录不会误删)→ 立即刷新工具清单(技能马上消失);
  // 若该技能此前被排除,同步清掉排除标记
  const deleteSkill = async (slug: string) => {
    if (excludedSkills.includes(slug)) {
      const next = excludedSkills.filter((s) => s !== slug)
      setExcludedSkills(next)
      window.desktop?.agentSetConfig?.({ excludedSkills: next }).catch(() => {})
    }
    try {
      const res = await window.desktop?.agentSkillDelete?.(slug)
      if (res?.error) {
        setSkillImportMsg(`删除失败:${res.error}`)
        return
      }
      const list = await window.desktop?.agentGetTools?.()
      if (Array.isArray(list)) setLocalTools(list)
    } catch {
      // 刷新失败:重进设置可见
    }
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
    memoryLeave.beginLeave(id, () => {
      window.desktop
        ?.agentMemorySet?.({ remove: id })
        .then(refreshMemory)
        .catch(() => {})
    })
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
    loadMemoryList()
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
    // 失败返回 {error}(主进程 safeHandle 统一,审计 P1-1):展示错误,
    // 不再走 unhandled rejection
    try {
      const res = await window.desktop?.agentEvolutionRollback?.()
      setEvolutionMsg(typeof res === 'string' ? res : (res?.error ?? ''))
    } catch {
      setEvolutionMsg('回滚失败')
    }
    loadMemoryList()
  }
  // 清除全部版本(回到初始状态):清空日志与快照,展示初始化状态
  const resetEvolution = async () => {
    try {
      const res = await window.desktop?.agentEvolutionReset?.()
      setEvolutionMsg(typeof res === 'string' ? res : (res?.error ?? ''))
    } catch {
      setEvolutionMsg('清除失败')
    }
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
        if (Array.isArray(list)) setLocalTools(list)
      } catch {
        // 刷新失败:重进设置可见
      }
    }
  }

  // Provider 判定与引擎共用(垂直解耦:规则只存 constants.ts 一处)
  const protocol = providerLabel(form.baseURL)

  return (
    <div className="island-panel-list island-agent-settings">
      <PanelHead title="Agent 设置" count={protocol} />
      {/* 分组菜单(2026-08-07 布局重构,通用 QuickMenu):整合按钮 + 同行
          联通展开 + 滚轮逐格切换 + 高亮滑块;五组 = 连接 / 行为与界面 /
          工具与能力 / 记忆与进化 / Sub Agent */}
      <QuickMenu
        items={SETTINGS_TABS.map((_, i) => i)}
        value={tab}
        onChange={switchTab}
        getLabel={(i) => SETTINGS_TABS[i]}
        title="滚轮切换菜单"
        wheelWhenOpen
      />
      {/* 内容区切换动画(2026-08-07 二次优化):入场/离场走专用 keyframes
          (views-agent.css .island-agent-settings .island-agent-form),
          交叉时序由 switchTab 控制;表单状态共享不丢 */}
      <div className={`island-agent-form${leaving ? ' island-ui-out' : ''}`} key={animSeq}>
        {tab === 0 && (
          <>
            {/* 账号(2026-08-11 用户要求"添加账号余额查询功能,API 配置
                集成到账号功能"):余额卡片 + API Key / Base URL / 模型 /
                思考强度 / 输出预算。余额查询与 LLM 工具同一实现;
                **去充值(2026-08-11 用户问"能否支持充值"):DeepSeek 无
                充值 API,充值必须网页端(platform.deepseek.com/top_up,
                需登录+实名认证,支付宝/微信),按钮经 openExternal 跳转
                系统浏览器;余额不足时醒目提示 + 充值入口 */}
            <div className="island-agent-account">
              <div className="island-agent-account-head">
                <span>账户余额</span>
                <div className="island-agent-account-actions">
                  <button
                    type="button"
                    className="island-agent-account-topup"
                    onClick={(event) => {
                      event.stopPropagation()
                      // openExternal 校验 http/https 后 shell.openExternal
                      window.desktop?.openExternal?.('https://platform.deepseek.com/top_up')
                    }}
                  >
                    去充值
                  </button>
                  <button
                    type="button"
                    className="island-agent-account-refresh"
                    disabled={balanceLoading}
                    onClick={(event) => {
                      event.stopPropagation()
                      void queryBalance()
                    }}
                  >
                    {balanceLoading ? '查询中…' : '刷新'}
                  </button>
                </div>
              </div>
              {balanceError && (
                <div className="island-agent-account-error">{balanceError}</div>
              )}
              {!balanceError && balance && balance.balances.length > 0 && (
                <div className="island-agent-account-bal">
                  {balance.balances.map((b) => (
                    <div key={b.currency} className="island-agent-account-row">
                      <span className="island-agent-account-cur">{b.currency}</span>
                      <span className="island-agent-account-total">
                        ¥{b.total.toFixed(2)}
                        {b.total < 1 && <em className="island-agent-account-low">余额不足</em>}
                      </span>
                      <span className="island-agent-account-sub">
                        充值 {b.toppedUp.toFixed(2)} + 赠送 {b.granted.toFixed(2)}
                      </span>
                    </div>
                  ))}
                  {balance.balances.some((b) => b.total < 1) && (
                    <div className="island-agent-account-lowtip">
                      余额不足,点右上角「去充值」在 DeepSeek 平台网页端充值(支付宝/微信,需实名认证,单笔最低 ¥10)
                    </div>
                  )}
                </div>
              )}
              {!balanceError && !balance && !balanceLoading && (
                <div className="island-agent-account-empty">
                  未查询余额。填写下方 API Key 后点「刷新」(仅 DeepSeek API 支持余额查询)
                </div>
              )}
            </div>
            {/* 连接配置:协议提示 + API Key / Base URL / 模型 / 思考强度 */}
            <div className="island-agent-protocol">
              {protocol === 'Anthropic Messages'
                ? 'Anthropic 协议:填写含 anthropic 的地址自动切换(如 https://api.deepseek.com/anthropic,模型填 deepseek-chat 等)'
                : protocol === 'DeepSeek Chat'
                  ? 'Chat 协议:地址含 chat 自动切换(模型 deepseek-v4-flash 或 deepseek-v4-pro)'
                  : 'Responses 协议(默认):DeepSeek 官方端点,模型 deepseek-v4-flash'}
            </div>
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
        {/* 思考强度(2026-08-08 QuickMenu 化):默认高;none 关闭思考模式
            (设置页思考强度新增"关") */}
        <div className="island-agent-field">
          <span>思考强度(深度思考 vs 速度)</span>
          <div className="island-agent-scale-row">
            <QuickMenu<string>
              items={REASONING_OPTIONS}
              value={form.reasoningEffort}
              onChange={(v) => setForm((f) => ({ ...f, reasoningEffort: v }))}
              getLabel={(v) => REASONING_LABELS[v]}
              title="思考强度(滚轮切换)"
              wheelWhenOpen
            />
          </div>
        </div>
        {/* 输出预算(2026-08-08):主对话 max_output_tokens,含思维链;
            LLM 对话中也可经 set_output_budget 工具自主调整。
            单一 QuickMenu(与设置菜单同款):悬浮展开 2 的幂预设档位
            (一体胶囊 + 高亮滑块 + 错峰滑入,展开时滚轮照常逐格切换);
            单击按钮 = 内联编辑自定义值(Enter/失焦提交,Esc 取消);
            值不在档位时滚轮经 compare 切到相邻档位 */}
        <label className="island-agent-field">
          <span>输出预算(含思维链,4096-262144)</span>
          <QuickMenu<number>
            items={BUDGET_PRESETS}
            value={form.maxOutputTokens}
            onChange={(v) => setForm((f) => ({ ...f, maxOutputTokens: v }))}
            getLabel={formatBudget}
            title="预设档位(悬浮展开;点击输入自定义)"
            wheelWhenOpen
            allowCustom
            min={4096}
            max={262144}
            compare={(a, b) => a - b}
          />
        </label>
          </>
        )}
        {tab === 1 && (
          <>
            {/* 行为与界面:自定义提示词 / 主动陪伴 / 界面放大
                (exec_command 确认门设置已移除,2026-08-07 用户要求) */}
            <label className="island-agent-field island-agent-field--grow">
              <span>自定义提示词(与长期记忆一起构成系统提示)</span>
              <textarea
                value={form.systemPrompt}
                rows={3}
                onChange={(event) => setForm((f) => ({ ...f, systemPrompt: event.target.value }))}
              />
            </label>
        {/* 主动陪伴(2026-08-07):用户无操作满 N 后,由总结 Sub Agent
            独立判断语境是否需要主动开口(它有总结上下文的能力),是则
            主 Agent 完整回合主动回复;回复落定后以系统通知展示心理揣测。
            **关闭时折叠隐藏间隔设置**(2026-08-07 用户要求,折叠动画) */}
        <label className="island-agent-field island-agent-field--toggle">
          <span>主动陪伴(无操作满 N 后主动开口)</span>
          <button
            type="button"
            className={`island-toggle${form.proactiveEnabled ? ' on' : ''}`}
            aria-checked={form.proactiveEnabled}
            onClick={(event) => {
              event.stopPropagation()
              setForm((f) => ({ ...f, proactiveEnabled: !f.proactiveEnabled }))
            }}
          >
            <span className="island-toggle-track" aria-hidden="true">
              <span className="island-toggle-knob" />
            </span>
          </button>
        </label>
        <div className={`island-proactive-config${form.proactiveEnabled ? ' open' : ''}`}>
          <div className="island-proactive-config-inner">
          <div className="island-agent-field">
          {/* 触发间隔 + 单位(2026-08-08 QuickMenu 化,两个独立快捷按钮):
              间隔默认 15,单位默认分钟;**数值不变仅换单位**——切换只改
              单位状态,保存时按当前数值 × 单位换算落盘;自定义值参考
              输出预算按钮(点击快捷按钮内联输入,5-480 钳制) */}
          <span>触发间隔(Agent 判断是否需要主动开口)</span>
          <div className="island-agent-scale-row">
            <QuickMenu<number>
              items={PROACTIVE_PRESETS}
              value={form.proactiveInterval}
              onChange={(v) => setForm((f) => ({ ...f, proactiveInterval: v }))}
              getLabel={(v) => `${v}`}
              title="触发间隔(悬浮展开档位;点击输入自定义)"
              wheelWhenOpen
              allowCustom
              min={5}
              max={480}
              compare={(a, b) => a - b}
            />
            <QuickMenu<'s' | 'm' | 'h'>
              items={PROACTIVE_UNITS}
              value={form.proactiveIntervalUnit}
              onChange={(u) => setForm((f) => ({ ...f, proactiveIntervalUnit: u }))}
              getLabel={(u) => PROACTIVE_UNIT_LABELS[u]}
              title="间隔单位(滚轮切换)"
              wheelWhenOpen
            />
            <span className="island-agent-scale-hint">
              当前 {form.proactiveInterval} {PROACTIVE_UNIT_LABELS[form.proactiveIntervalUnit]}
            </span>
          </div>
          </div>
          </div>
        </div>
        {/* 界面放大(2026-08-08 QuickMenu 化):默认 200;自定义值参考
            输出预算按钮(点击快捷按钮内联输入,100-400 钳制,2026-08-11
            用户要求 300% → 400%) */}
        <div className="island-agent-field">
          <span>界面放大(仅面板尺寸,文字按钮不变)</span>
          <div className="island-agent-scale-row">
            <QuickMenu<number>
              items={SCALE_PRESETS}
              value={scale}
              onChange={onScaleChange}
              getLabel={(v) => `${v}%`}
              title="界面放大(悬浮展开档位;点击输入自定义)"
              wheelWhenOpen
              allowCustom
              min={100}
              max={400}
              compare={(a, b) => a - b}
            />
            <span className="island-agent-scale-hint">仅面板/窗口尺寸</span>
          </div>
        </div>
        {/* 媒体窗口默认宽(2026-08-08):对话图片/视频窗口初始宽,即时生效
            (localStorage widget-media-window);LLM 对话中也可经
            set_media_window_size 工具调整 */}
        <div className="island-agent-field">
          <span>媒体窗口默认宽(图片/视频,拖拽可临时缩放)</span>
          <div className="island-agent-scale-row">
            <QuickMenu<number>
              items={MEDIA_WINDOW_PRESETS}
              value={mediaWindowWidth}
              onChange={onMediaWindowWidthChange}
              getLabel={(v) => `${v}px`}
              title="媒体窗口默认宽(悬浮展开档位;点击输入自定义)"
              wheelWhenOpen
              allowCustom
              min={160}
              max={800}
              compare={(a, b) => a - b}
            />
            <span className="island-agent-scale-hint">初始宽,拖拽右下角缩放</span>
          </div>
        </div>
          </>
        )}
        {tab === 2 && (
          <>
            {/* 工具与能力:MCP 服务 / 技能目录 */}
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
                {indices.map((idx) => (
                  <McpServerCard
                    key={idx}
                    idx={idx}
                    server={form.mcpServers[idx]}
                    testing={testingIdx === idx}
                    testResult={testResult}
                    leaving={mcpLeave.leavingIds.includes(String(idx))}
                    onTest={(i) => void testServer(i)}
                    onRemove={removeServer}
                    onPatch={patchServer}
                  />
                ))}
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
                {/* 三区共用 SkillsSection(审计 P1 #7:原同一区块复制 3 遍);
                    灵动岛创建 = 应用自有副本,支持彻底删除(2026-08-11) */}
                <SkillsSection label="灵动岛创建" skills={createdSkills} leavingIds={skillsLeave.leavingIds} canDelete onExclude={excludeSkill} onDelete={deleteSkill} />
                <SkillsSection label="手动导入" skills={importedSkills} leavingIds={skillsLeave.leavingIds} onExclude={excludeSkill} />
                <SkillsSection label="扫描到的" skills={scannedSkills} leavingIds={skillsLeave.leavingIds} onExclude={excludeSkill} />
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
          </>
        )}
        {tab === 3 && (
          <>
            {/* 记忆与进化:长期记忆 / 自我进化 */}
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
              className={`island-memory-row${memoryLeave.leavingIds.includes(entry.id) ? ' island-ui-leave' : ''}`}
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
          </>
        )}
        {tab === 4 && (
          <>
            {/* Sub Agent(2026-08-07):总结标题文风 / 心理揣测人格。
                预设(各 4 种,共 8)存 id;自定义 ≤100 字直接存文本;
                引擎 resolveSubAgentStyle 解析注入系统提示。
                输入框在预设选中时显示空(placeholder 提示自定义)——
                输入即切换为自定义 */}
            <div className="island-agent-section">
              <span className="island-agent-section-title">总结标题文风(标题 Sub Agent 生成语气)</span>
              <span className="island-agent-section-hint">
                每轮回复后静默生成对话标题;文风影响标题的措辞风格
              </span>
              {/* 总结文风(2026-08-08 QuickMenu 化):默认 = 默认;
                  自定义文风在下方输入框(输入即切自定义) */}
              <div className="island-agent-scale-row">
                <QuickMenu<string>
                  items={SUMMARY_STYLE_ITEMS}
                  value={form.summaryStyle}
                  onChange={(v) => setForm((f) => ({ ...f, summaryStyle: v }))}
                  getLabel={summaryStyleLabel}
                  title="总结文风(滚轮切换)"
                  wheelWhenOpen
                />
              </div>
              <label className="island-agent-field">
                <span>自定义文风(≤100 字;留空 = 用预设/默认)</span>
                <input
                  type="text"
                  value={SUMMARY_STYLES.some((s) => s.id === form.summaryStyle) ? '' : form.summaryStyle}
                  maxLength={100}
                  placeholder="如:用一句有画面感的话概括主题"
                  spellCheck={false}
                  onChange={(event) => setForm((f) => ({ ...f, summaryStyle: event.target.value }))}
                />
              </label>
            </div>
            <div className="island-agent-section">
              <span className="island-agent-section-title">心理揣测人格(揣测 Sub Agent 的语气)</span>
              <span className="island-agent-section-hint">
                每轮回复后揣测助手心态,显示在紧凑态文字区与主动陪伴系统通知
              </span>
              {/* 心理揣测人格(2026-08-08 QuickMenu 化):默认 = 默认;
                  自定义人格在下方输入框(输入即切自定义) */}
              <div className="island-agent-scale-row">
                <QuickMenu<string>
                  items={MIND_PERSONA_ITEMS}
                  value={form.mindPersona}
                  onChange={(v) => setForm((f) => ({ ...f, mindPersona: v }))}
                  getLabel={mindPersonaLabel}
                  title="揣测人格(滚轮切换)"
                  wheelWhenOpen
                />
              </div>
              <label className="island-agent-field">
                <span>自定义人格(≤100 字;留空 = 用预设/默认)</span>
                <input
                  type="text"
                  value={MIND_PERSONAS.some((p) => p.id === form.mindPersona) ? '' : form.mindPersona}
                  maxLength={100}
                  placeholder="如:用深夜电台主播的语气揣测"
                  spellCheck={false}
                  onChange={(event) => setForm((f) => ({ ...f, mindPersona: event.target.value }))}
                />
              </label>
            </div>
          </>
        )}
        {tab === 5 && (
          <>
            {/* 数据管理(2026-08-10 用户要求):清除灵动岛所有数据 / 所有
                工具的下载记录及源文件。危险操作:两段式确认(第一次点击
                进入确认态,3.5s 无操作复位;再次点击执行),执行后清
                localStorage + IndexedDB + userData 文件并重启界面 */}
            <div className="island-agent-section">
              <span className="island-agent-section-title">清除灵动岛数据</span>
              <span className="island-agent-section-hint">
                主题色/背景/字体/歌词/界面设置、播放列表与上传音乐、多媒体库、对话历史与会话、长期记忆与进化版本、Agent 配置(API Key/模型/提示词)全部重置——操作不可恢复
              </span>
              <div className="island-agent-scale-row">
                <button
                  type="button"
                  className={`island-agent-scale-btn island-data-clear${confirmClear === 'app' ? ' confirming' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    requestClear('app')
                  }}
                >
                  {confirmClear === 'app' ? '再次点击确认清除' : '清除灵动岛数据'}
                </button>
              </div>
            </div>
            <div className="island-agent-section">
              <span className="island-agent-section-title">清除工具数据(下载记录及源文件)</span>
              <span className="island-agent-section-hint">
                B站下载的文件与登录态、超星答题登录态与截图等工具产物全部删除(不影响灵动岛本体数据)——操作不可恢复
              </span>
              <div className="island-agent-scale-row">
                <button
                  type="button"
                  className={`island-agent-scale-btn island-data-clear${confirmClear === 'tools' ? ' confirming' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    requestClear('tools')
                  }}
                >
                  {confirmClear === 'tools' ? '再次点击确认清除' : '清除工具数据'}
                </button>
              </div>
            </div>
            {clearMsg ? (
              <span className={`island-mcp-test-result ${clearMsg.startsWith('清除失败') ? 'fail' : 'ok'} island-ui-enter`}>
                {clearMsg}
              </span>
            ) : null}
          </>
        )}
      </div>
      <div className="island-agent-form-foot">
        {/* 保存配置(2026-08-07 用户要求:不再弹"已保存"绿勾气泡,改为
            按钮内联展示"已保存"——无绿勾,回弹淡入 + 平滑恢复;key 变化
            重挂载重放 island-ui-in 动画) */}
        <button
          type="button"
          className={`island-ctl island-ctl--upload island-save-btn${saved ? ' saved' : ''}`}
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
          <span key={saved ? 'saved' : 'save'} className={`island-save-label${saved ? ' saved' : ''}`}>
            {saved ? '已保存' : '保存配置'}
          </span>
        </button>
      </div>
      <BackFoot onBack={onBack} />
    </div>
  )
}

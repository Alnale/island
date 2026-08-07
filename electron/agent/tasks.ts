/**
 * 通用后台任务注册表(2026-08-07)
 *
 * 把 bili 工具的后台设计**泛化**为引擎级机制(参考:扫码登录生成二维码
 * → 后台轮询 → 完成发通知 + background-done 自动触发对话):
 * 任何需要人工介入或后台推进的任务(扫码登录、人工确认、下载……)都能
 * 注册一个任务,引擎据此:
 * - 把任务状态**实时注入系统提示**(LLM 对话中感知"还在等待用户扫码",
 *   回答"登录好了吗"时依据真实状态,不再惯性回复);
 * - 任务进入终态(完成/失败/取消)时经 done 回调 → background-done
 *   事件 → 渲染端自动触发一轮对话,LLM 主动告知用户结果(**反馈空间**,
 *   不依赖用户主动提问——失败同样有反馈,不再"通知完就结束")。
 *
 * 零 node 依赖(纯 TS),esbuild 打包进 agent.cjs。
 */

export type TaskStatus = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'

/** 后台任务(状态块展示 + 终态回调的载荷) */
export interface AgentTask {
  /** 唯一 id(同一任务重复注册按 id 覆盖;每次尝试应带独立 id,如 bili-login-<key>) */
  id: string
  /** 任务名(状态块与终态标题,如「B站扫码登录」「B站下载」) */
  title: string
  status: TaskStatus
  /** 状态细节(状态块与终态 message,如「等待用户扫码确认(二维码 2 分钟内有效)」) */
  detail: string
  /** 最近一次状态更新的时刻 */
  updatedAt: number
}

/** 终态:进入后不再变更、只触发一次 done 回调 */
const TERMINAL: ReadonlySet<TaskStatus> = new Set(['done', 'failed', 'cancelled'])

const tasks = new Map<string, AgentTask>()
/** 终态记录保留时长(状态块内继续展示 + 对话感知;超过清除防无限累积) */
const TASK_TTL_MS = 24 * 60 * 60 * 1000
/** 非终态任务失联阈值:超过仍无更新,进程可能已被外部终结(状态块标注) */
const STALE_MS = 6 * 60 * 60 * 1000

/** 任务进入终态的回调(createTools 接线 → onBackgroundDone → 对话反馈) */
let doneHandler: ((task: AgentTask) => void) | undefined

export function setTaskDoneHandler(handler: ((task: AgentTask) => void) | undefined): void {
  doneHandler = handler
}

/** 注册任务(同一 id 覆盖;缺省 status = running)。
 * at:更新时刻(测试注入用;缺省当前时间) */
export function registerTask(input: {
  id: string
  title: string
  status?: TaskStatus
  detail?: string
  at?: number
}): void {
  tasks.set(input.id, {
    id: input.id,
    title: input.title,
    status: input.status ?? 'running',
    detail: input.detail ?? '',
    updatedAt: input.at ?? Date.now(),
  })
}

/**
 * 更新任务状态(等待中 → 进行中 → 终态)。进入终态(完成/失败/取消)
 * 触发 done 回调**一次**;已终态的任务再更新被忽略(防重复回调)
 */
export function updateTask(id: string, patch: { status?: TaskStatus; detail?: string }): void {
  const task = tasks.get(id)
  if (!task || TERMINAL.has(task.status)) return
  if (patch.status) task.status = patch.status
  if (patch.detail !== undefined) task.detail = patch.detail
  task.updatedAt = Date.now()
  if (TERMINAL.has(task.status)) doneHandler?.(task)
}

/** 主动移除任务(状态块立即消失) */
export function removeTask(id: string): void {
  tasks.delete(id)
}

/** 全部任务快照(按更新时间排序;测试/调试用) */
export function listTasks(): AgentTask[] {
  pruneTasks()
  return [...tasks.values()].sort((a, b) => a.updatedAt - b.updatedAt)
}

/** 清理已终态且超 TTL 的旧记录(测试可注入 now) */
export function pruneTasks(now = Date.now()): void {
  for (const [id, t] of tasks) {
    if (TERMINAL.has(t.status) && now - t.updatedAt > TASK_TTL_MS) tasks.delete(id)
  }
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  waiting: '等待中',
  running: '进行中',
  done: '已完成',
  failed: '已失败',
  cancelled: '已取消',
}

/**
 * 全部任务的状态注入块(引擎/Sub Agent 追加到系统提示;无任务返回空串)。
 * 让 LLM 对"等待用户扫码/下载进行中"有真实感知,回答时依据真实状态。
 * **文案稳定**:只含任务名/状态/细节(状态不变时不产生序列化抖动,
 * 不破坏 DeepSeek 前缀缓存——更新时间戳不进文案)
 */
export function getTasksStatusBlock(): string {
  pruneTasks()
  if (tasks.size === 0) return ''
  const now = Date.now()
  const lines = [...tasks.values()]
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((t) => {
      const stale = !TERMINAL.has(t.status) && now - t.updatedAt > STALE_MS
      const detail = t.detail ? `,${t.detail}` : ''
      return `- ${t.title}:${STATUS_LABEL[t.status]}${detail}${stale ? '(已超时未更新,可能已失效)' : ''}`
    })
  return (
    '【后台任务状态(最新,以此为准)】\n' +
    lines.join('\n') +
    '\n对话中提及这些任务时按状态如实回答:已完成/已失败就直接说明结果,不要再"还在进行"或"完成后会通知";' +
    '等待人工操作的任务要提醒用户当前需要做什么(如扫码确认、确认授权);进行中才说还在进行。'
  )
}

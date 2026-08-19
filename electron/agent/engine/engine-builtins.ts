/**
 * 引擎内置专属工具业务
 *
 * 职责:引擎自带的工具(输出预算调整、记忆进化、余额查询)。
 * 本文件自包含所有需要的常量和逻辑,不依赖其他 engine-* 拆分文件。
 */

import { isMimoProvider } from '../providers/mimo-constants'
import { deepseekErrorMessage } from '../providers/deepseek-constants'
import { isLMStudioProvider } from '../providers/lmstudio-constants'
import type { AgentConfig, AgentTool, EvolutionLike, ToolParams } from '../types'

/** 主对话输出预算缺省值(含思维链 token) */
const MAIN_MAX_OUTPUT_TOKENS = 8_192
/** 输出预算钳制范围 */
const MIN_OUTPUT_TOKENS = 4096
const MAX_OUTPUT_TOKENS = 262144

/**
 * 预算不足提示
 * provider 报告响应被 max_output_tokens 截断时,向下一轮请求注入本条 system 提示
 */
const BUDGET_TRUNCATE_HINT =
  '【系统提示,非用户输入】上一轮回复因输出预算(max_output_tokens)不足被截断。' +
  '如果当前任务需要更长的输出:请调用 set_output_budget 工具(action=get 查看当前预算,' +
  'action=set 按需调大,不必顶满上限),然后继续完成被截断的回复;' +
  '若任务已基本完成,直接给出收尾回复即可。'

/**
 * DeepSeek 账户余额查询
 * GET {baseURL}/user/balance,Bearer 认证(15s 超时)
 */
async function fetchDeepseekBalance(config: {
  baseURL: string
  apiKey: string
}): Promise<{
  isAvailable: boolean
  balances: Array<{ currency: string; total: number; granted: number; toppedUp: number }>
}> {
  if (config.baseURL.includes('anthropic')) {
    throw new Error('当前 API 是 Anthropic 兼容端点,没有余额接口(余额查询仅支持 DeepSeek API)')
  }
  if (isMimoProvider(config.baseURL)) {
    throw new Error('当前 API 是小米 MiMo,MiMo 暂不支持余额查询,请前往 MiMo 平台查看余额')
  }
  if (isLMStudioProvider(config.baseURL)) {
    throw new Error('当前 API 是 LM Studio 本地部署,本地推理没有余额概念')
  }
  const base = config.baseURL.trim().replace(/\/+$/, '')
  const key = config.apiKey.trim()
  if (!key) throw new Error('尚未配置 API Key')
  const res = await fetch(`${base}/user/balance`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      // 忽略读失败
    }
    throw new Error(deepseekErrorMessage(res.status, detail))
  }
  const json = (await res.json()) as {
    is_available?: boolean
    balance_infos?: Array<{
      currency: string
      total_balance: string
      granted_balance: string
      topped_up_balance: string
    }>
  }
  const infos = Array.isArray(json.balance_infos) ? json.balance_infos : []
  return {
    isAvailable: json.is_available !== false,
    balances: infos.map((b) => ({
      currency: b.currency,
      total: Number(b.total_balance ?? 0),
      granted: Number(b.granted_balance ?? 0),
      toppedUp: Number(b.topped_up_balance ?? 0),
    })),
  }
}

/**
 * 创建内置专属工具组
 * @param outputBudgetRef 引用引擎的 outputBudget 可变状态
 * @param deps 窄依赖(仅本组工具实际用到的宿主能力;插件化重构后由
 *   builtinToolsPlugin 从 ctx 服务翻译注入,不再吃整个 EngineDeps)
 */
export function createBuiltinTools(
  outputBudgetRef: { get value(): number; set value(n: number) },
  deps: {
    getConfig(): AgentConfig
    getEvolution?(): EvolutionLike | null
    updateAgentConfig?(patch: Partial<AgentConfig>): void
  },
): AgentTool[] {
  /** 记忆自我进化工具 */
  const evolveTool: AgentTool = {
    name: 'evolve_memory',
    description:
      '触发记忆系统的版本化自我进化(后台,多轮候选循环):每轮 评估记忆质量 → 生成带假说的改进 → ' +
      '复评 → 只接受评分严格更高的候选(接受 = 新版本存档,拒绝 = 恢复原版本),最多 rounds 轮,达标提前停。' +
      '适合:用户说"整理一下记忆""进化一下"、或对话沉淀多后主动触发。完成后有系统通知。',
    parameters: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: '可选:本次进化的关注点(如"去重""补充偏好")' },
        rounds: { type: 'number', description: '候选轮数,缺省 2,最大 6(记忆条目多时会按需自动放大,约每 15 条一轮)' },
      },
    },
    async execute(params: ToolParams) {
      const evolution = deps.getEvolution?.() ?? null
      if (!evolution) throw new Error('自我进化不可用(未启用)')
      return (
        await evolution.requestEvolve(
          params.focus ? String(params.focus) : undefined,
          params.rounds ? Number(params.rounds) : undefined,
        )
      ).message
    },
  }

  /** 输出预算自我配置工具 */
  const outputBudgetTool: AgentTool = {
    name: 'set_output_budget',
    description:
      '查看/调整主对话的输出预算(max_output_tokens,**含思维链 token**)。' +
      '**按任务实际需要设值,不是越大越好**:预算只是输出上限,回复不会因此变长,' +
      '过大只会让失控的回复烧更多 token。' +
      '用法:先 action=get 查看当前预算与缺省值;任务确实需要超长输出(超长文档/大文件/长代码)时,' +
      '用 action=set 设一个**合理的目标值**(如 32768/65536,最大 262144),完成后可调回缺省。' +
      'persist=true 写入配置文件(重启后仍生效);缺省 false = 仅本次会话有效(重启恢复缺省)。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set'],
          description: 'get = 查询当前预算;set = 设置新预算(必填 maxOutputTokens)',
        },
        maxOutputTokens: {
          type: 'number',
          description: 'set 时的新输出预算(4096-262144,含思维链 token),按任务实际需要设值',
        },
        persist: { type: 'boolean', description: 'set 时是否持久化到配置文件,缺省 false(仅本次会话)' },
      },
      required: ['action'],
    },
    async execute(params: ToolParams) {
      const action = String(params.action ?? '')
      if (action === 'get') {
        return (
          `当前输出预算:${outputBudgetRef.value}(缺省 ${MAIN_MAX_OUTPUT_TOKENS},范围 4096-262144,官方上限 384K)。` +
          '预算只是输出上限:任务需要超长输出时用 action=set 按需调大,常规任务保持当前值即可。'
        )
      }
      if (action !== 'set') throw new Error('action 仅支持 get/set')
      const raw = Number(params.maxOutputTokens)
      if (!Number.isFinite(raw)) throw new Error('set 需要 maxOutputTokens(数字,4096-262144)')
      const n = Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.round(raw)))
      const prev = outputBudgetRef.value
      outputBudgetRef.value = n
      let persistedNote = '仅本次会话有效(重启恢复缺省)'
      if (params.persist === true) {
        if (!deps.updateAgentConfig) {
          persistedNote = '无法持久化(未注入配置写入),仅本次会话有效'
        } else {
          deps.updateAgentConfig({ maxOutputTokens: n })
          persistedNote = '已写入配置文件,重启后仍生效'
        }
      }
      return (
        `输出预算已从 ${prev} 调整为 ${n}(${persistedNote})。` +
        `常规任务可调回缺省 ${MAIN_MAX_OUTPUT_TOKENS};超长任务按需保持即可。`
      )
    },
  }

  /** DeepSeek 账户余额查询工具 */
  const balanceTool: AgentTool = {
    name: 'get_deepseek_balance',
    description:
      '查询 DeepSeek API 账户余额(按币种列出:总余额 = 充值余额 + 赠送余额,单位元/美元)。' +
      '适合:用户问"账户还有多少钱""余额够不够""快没钱了没"时调用。' +
      '仅 DeepSeek API 可用(Anthropic 兼容端点无余额接口)。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const config = deps.getConfig()
      const { balances } = await fetchDeepseekBalance({ baseURL: config.baseURL, apiKey: config.apiKey })
      if (balances.length === 0) return '(余额接口返回为空,可稍后重试)'
      return balances
        .map(
          (b) =>
            `${b.currency}:总余额 ${b.total.toFixed(2)}(充值 ${b.toppedUp.toFixed(2)} + 赠送 ${b.granted.toFixed(2)})` +
            (Number.isFinite(b.total) && b.total < 1 ? ',余额不足,请提醒用户及时充值' : ''),
        )
        .join('\n')
    },
  }

  return [evolveTool, outputBudgetTool, balanceTool]
}

/** 供引擎入口 queryBalance 使用 */
export { fetchDeepseekBalance, MAIN_MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, BUDGET_TRUNCATE_HINT }

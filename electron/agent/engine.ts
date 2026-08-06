/**
 * Agent 引擎 —— 单 agent 循环 + 工具执行
 *
 * 借鉴:
 * - opencode src/session/llm.ts 的流式调用编排(系统提示拼接、abort 贯穿);
 * - MS Agent 参考后端 toolkit/agent_loop.rs 的 ReAct 循环语义:
 *   ① 流式回复(文本/工具调用增量事件实时转发)→ ② 有工具调用则逐个执行、
 *      结果回填上下文 → ③ 继续下一轮,直到模型给出纯文本回复;
 *   - 迭代上限防死循环(工具重复/只思考不行动);
 *   - 工具失败结构化提示(错误信息回填,LLM 可自纠)。
 *
 * 引擎无状态:每轮由渲染端回传完整历史(参考后端"客户端持有历史"模式),
 * 主进程注入 getConfig / onEvent / onSwitchToMusic 依赖。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseToolArgs } from './deepseek'
import { streamByConfig } from './provider'
import { createTools, getBiliBackgroundStatus } from './tools'
import { createSettingsTools } from './settingsTools'
import { createMCPManager, type MCPManager } from './mcp'
import { createSkillLoader } from './skills'
import { createMemoryTools, formatMemoryBlock } from './memory'

// 测试用导出(工具执行链路直测)
export { createTools }
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentTool,
  EngineDeps,
  McpServerConfig,
  ToolParams,
} from './types'

/**
 * 工具循环迭代上限。
 * 用户要求**移除 25 轮限制**(复杂任务试错空间仍不足)——不再设实际
 * 上限:防失控由用户停止按钮(abort)/上下文预算(trimHistory 200K)
 * 兜底。1000 仅作程序级保险(引擎自身 bug 防无限循环烧 token),
 * 正常 LLM 行为不可能达到(每轮至少一次完整 API 往返)
 */
const MAX_STEPS = 1000
/** 单个工具执行兜底超时(ms);工具内部另有自己的超时参数 */
const TOOL_TIMEOUT_MS = 60_000
/**
 * 上下文预算治理(官方文档:deepseek-v4-flash 上下文 1M,超出返回 400):
 * 按 token 粗估裁剪历史,超限从最旧丢弃。
 * - 估算:中文 ≈1 token/字、英文 ≈4 字符/token,取 0.6 系数保守;
 * - 上限 200K(远低于 1M 窗口,工具结果/多轮累积的安全余量);
 * - 至少保留最近 10 条消息(不把对话裁没);
 * - 仅在超限时触发——正常对话不动历史,**不破坏缓存前缀**。
 */
const MAX_CONTEXT_TOKENS = 200_000
const MIN_KEEP_MESSAGES = 10

function estimateMessageTokens(m: AgentMessage): number {
  let n = 0
  for (const p of m.parts) {
    if (p.type === 'text' || p.type === 'reasoning') n += p.text.length * 0.6
    else if (p.type === 'tool-result') n += p.result.length * 0.6
    else if (p.type === 'tool-call') n += JSON.stringify(p.args ?? {}).length * 0.3
  }
  return Math.ceil(n)
}

/**
 * 总结标题清洗与截断:去首尾引号/书名号/空白(LLM 可能不遵守
 * "不要引号"的约束),按 code point 截断到岛体文字区显示容量。
 * 标题必须短:紧凑态文字区约 6-9 个汉字,8 字提示词 + 10 码元
 * 硬截断保证完整显示——长标题在岛体上被截成"开头几字",
 * 观感等同"总结失败、显示回复开头"
 */
function sanitizeTitle(raw: string): string {
  const text = raw
    .trim()
    .replace(/^[「『"'《<]+|[」』"'》>]+$/g, '')
    .trim()
  return Array.from(text).slice(0, 10).join('')
}

/**
 * 总结标题 JSON 解析(测试用导出;官方 json_mode 指南的配套兜底):
 * JSON 模式有概率返回空 content(官方明示),模型也可能不守规矩输出
 * markdown 代码块包裹 / 前导说明文本 / 尾随内容(实测)——逐级回退:
 * 空 → '';依次尝试 原文 / 剥离 ```json``` 代码块 / 从第一个 { 截取,
 * 任一解析出合法 title 字段即返回;其余 → 整串交给 sanitizeTitle
 * 清洗截断(标题不至于永久缺失)
 */
export function parseTitleJson(raw: string): string {
  const text = (raw ?? '').trim()
  if (!text) return ''
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim(),
    text.slice(text.indexOf('{')).trim(),
    // 取第一个 { 到最后一个 } 之间的子串(容忍尾随内容)
    text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1).trim(),
  ]
  for (const c of candidates) {
    if (!c) continue
    try {
      const obj = JSON.parse(c) as { title?: unknown }
      if (obj && typeof obj.title === 'string' && obj.title.trim()) return obj.title.trim()
    } catch {
      // 尝试下一个候选
    }
  }
  return text
}

/** prompt 示例词(模型可能照抄示例值当标题——实测"不超过8个汉字的
 * 简短标题"被原样输出;命中视为无效,进入下一级降级) */
const TITLE_LITERAL_EXAMPLES = new Set([
  '简短标题',
  '不超过8个汉字的简短标题',
  '标题',
  '对话标题',
  '<对话标题>',
  '根据对话内容概括的标题',
])

/**
 * JSON 模式的**严格**标题解析:JSON 模式尝试必须解析出合法 JSON 对象
 * 的字符串 title 才采信——解析失败(模型输出 Python 风格单引号 dict、
 * 代码字面量等垃圾)一律返回空串,由降级链进入下一措辞。
 * 与 parseTitleJson 的区别:后者解析失败会把原文整串兜底返回(纯文本
 * 措辞才允许);JSON 模式若也兜底,垃圾会被当成标题(实测标题变
 * "['data']"——模型在 json 模式输出了 Python 列表字面量,parseTitleJson
 * 全部解析失败后返回原文,成了岛上的标题)。
 * 额外容忍:先按原文解析,失败后把单引号替换为双引号再试一次
 * (模型在 json 模式常输出 Python 风格 dict:{'title': 'xxx'})
 */
export function extractJsonTitle(raw: string): string {
  const text = (raw ?? '').trim()
  if (!text) return ''
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim(),
    text.slice(text.indexOf('{')).trim(),
    text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1).trim(),
  ]
  for (const c of candidates) {
    if (!c) continue
    // 原文 → 单引号替换为双引号(容忍 Python 风格 dict)
    for (const candidate of [c, c.replace(/'/g, '"')]) {
      try {
        const obj = JSON.parse(candidate) as { title?: unknown }
        if (obj && typeof obj.title === 'string' && obj.title.trim()) return obj.title.trim()
      } catch {
        // 尝试下一个候选
      }
    }
  }
  return ''
}

/** 明显不是标题的代码字面量(模型输出垃圾时防串味):
 * 括号包裹的数组/元组字面量(如 ['data'])、空括号 */
function looksLikeCodeLiteral(title: string): boolean {
  return /^\[.*\]$/s.test(title) || /^\(.*\)$/s.test(title)
}

/** 历史裁剪:总估算超预算时从最旧丢弃(至少保留最近 MIN_KEEP_MESSAGES 条) */
function trimHistory(history: AgentMessage[]): AgentMessage[] {
  let total = 0
  for (const m of history) total += estimateMessageTokens(m)
  if (total <= MAX_CONTEXT_TOKENS) return history
  const keep: AgentMessage[] = []
  let sum = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(history[i])
    if (sum + t > MAX_CONTEXT_TOKENS && keep.length >= MIN_KEEP_MESSAGES) break
    keep.unshift(history[i])
    sum += t
  }
  return keep
}

export interface AgentEngine {
  /** 当前是否在运行一轮 */
  readonly busy: boolean
  /** 发送一轮对话(引擎无状态,history = 完整历史) */
  send(text: string, history: AgentMessage[]): void
  /** 中止当前轮(工具执行中的命令不强制杀,由各工具自身超时兜底) */
  abort(): void
  /** 工具清单(名称/描述/参数 schema,供 UI 展示;不含执行函数) */
  listTools(): Array<{ name: string; description: string; parameters: AgentTool['parameters'] }>
  /** 完整工具清单(内置 + MCP 服务工具 + 技能;MCP 未连接的服务跳过) */
  listAllTools(): Promise<Array<{ name: string; description: string; parameters: AgentTool['parameters'] }>>
  /** 测试 MCP 服务连通性(独立连接 → 列工具 → 销毁,不进入常驻) */
  testMCP(server: McpServerConfig): Promise<{ ok: boolean; error?: string; toolCount?: number }>
  /** 销毁外部工具资源(MCP 子进程),应用退出时调用 */
  dispose(): void
}

/**
 * 手动调用解析(测试用导出):输入以 / 开头 = 调技能(skill_<名>),
 * 以 @ 开头 = 调 MCP 工具(mcp_<服务>_<工具>)。引擎在循环前先执行
 * 工具,结果以 tool-call/tool-result parts 入历史,LLM 基于结果直接回复
 */
export function parseManualCall(text: string): { name: string; rest: string } | null {
  if (!text.startsWith('/') && !text.startsWith('@')) return null
  const m = /^[/@]\s*(\S+)\s*([\s\S]*)$/.exec(text.trim())
  if (!m || !m[1]) return null
  return { name: m[1], rest: m[2] ?? '' }
}

/** 手动调用匹配(测试用导出):精确 → 模糊唯一命中;多命中/未找到给可读提示 */
export function findManualTool(
  tools: AgentTool[],
  name: string,
): { tool: AgentTool | null; hint: string } {
  const exact = tools.find((t) => t.name === name)
  if (exact) return { tool: exact, hint: '' }
  const lower = name.toLowerCase()
  const matches = tools.filter((t) => t.name.includes(lower))
  if (matches.length === 1) return { tool: matches[0], hint: '' }
  if (matches.length > 1) {
    return {
      tool: null,
      hint: `「${name}」匹配到 ${matches.length} 个工具(${matches.map((t) => t.name).join('、')}),请指定完整工具名`,
    }
  }
  return {
    tool: null,
    hint: `未找到「${name}」。技能用 /技能名,如 /trump-perspective;MCP 工具用 @完整工具名,如 @mcp_filesystem_read_file(可用工具列表查看现有工具)`,
  }
}

/**
 * LLM 自我配置工具组(测试用导出):自然语言直接管理 MCP 服务与技能目录。
 * 写配置经 updateAgentConfig(主进程注入,同款校验);工具清单每轮刷新,
 * 新增服务/目录下一轮生效(结果里注明)。testMcp 依赖注入(mcpManager)
 */
export function createConfigTools(deps: {
  getConfig(): AgentConfig
  updateAgentConfig?(patch: Partial<AgentConfig>): void
  testMcp(server: McpServerConfig): Promise<{ ok: boolean; error?: string; toolCount?: number }>
  /** 技能扫描(exclude 校验技能存在;engine 注入 skillLoader.listTools) */
  listSkills?: (dirs: string[], excluded?: string[]) => Promise<AgentTool[]>
  /** 技能目录(create 写入;main.cjs 注入 userData/skills) */
  getSkillDir?(): string
}): AgentTool[] {
  return [
    {
      name: 'mcp_config',
      description:
        '管理 MCP 服务(自然语言自我配置):list 查看已配置服务 / add 添加服务(stdio 本地进程:' +
        'name+command+args;或 sse 远程端点:name+type=sse+url) / remove 删除服务 / test 测试连通。' +
        '新增服务后下一轮对话起生效,其工具名称为 mcp_<服务名>_<工具名>。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove', 'test'], description: '操作' },
          name: { type: 'string', description: '服务名(add/remove/test 用)' },
          command: { type: 'string', description: 'add(stdio):启动命令,如 npx -y @modelcontextprotocol/server-filesystem' },
          args: { type: 'array', items: { type: 'string' }, description: 'add(stdio):启动参数' },
          type: { type: 'string', enum: ['stdio', 'sse'], description: 'add:传输类型,缺省 stdio' },
          url: { type: 'string', description: 'add(sse):远程端点 URL' },
          env: { type: 'object', description: 'add(stdio):环境变量 KEY=VALUE' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        const cfg = deps.getConfig()
        const servers = [...(cfg.mcpServers ?? [])]
        if (action === 'list') {
          if (servers.length === 0) return '(未配置 MCP 服务)'
          return servers
            .map(
              (s, i) =>
                `${i + 1}. ${s.name}(${s.type === 'sse' ? 'sse' : 'stdio'}${
                  s.type === 'sse' ? ':' + (s.url ?? '') : ':' + s.command
                })`,
            )
            .join('\n')
        }
        if (action === 'add') {
          const name = String(params.name ?? '').trim()
          if (!name) throw new Error('add 需要 name(服务名)')
          if (servers.some((s) => s.name === name)) throw new Error(`服务 ${name} 已存在,可先 remove 再 add`)
          const type = params.type === 'sse' ? 'sse' : 'stdio'
          if (type === 'sse') {
            const url = String(params.url ?? '').trim()
            if (!/^https?:\/\//i.test(url)) throw new Error('sse 服务需要 url(http/https 端点)')
            servers.push({ name, type: 'sse', command: url, url })
          } else {
            const command = String(params.command ?? '').trim()
            if (!command) throw new Error('stdio 服务需要 command(启动命令)')
            servers.push({
              name,
              type: 'stdio',
              command,
              args: Array.isArray(params.args) ? params.args.map(String) : [],
              env:
                params.env && typeof params.env === 'object'
                  ? Object.fromEntries(Object.entries(params.env).map(([k, v]) => [k, String(v)]))
                  : undefined,
            })
          }
          if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
          deps.updateAgentConfig({ mcpServers: servers })
          return `已添加 MCP 服务 ${name}(${type})。下一轮对话起可用,工具名为 mcp_${name}_<工具名>`
        }
        if (action === 'remove') {
          const name = String(params.name ?? '').trim()
          const idx = servers.findIndex((s) => s.name === name)
          if (idx === -1) {
            throw new Error(
              `未找到服务 ${name}(list 可查看)` + (servers.length ? `,现有:${servers.map((s) => s.name).join('、')}` : ''),
            )
          }
          servers.splice(idx, 1)
          if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
          deps.updateAgentConfig({ mcpServers: servers })
          return `已删除 MCP 服务 ${name}`
        }
        if (action === 'test') {
          const name = String(params.name ?? '').trim()
          const target = servers.find((s) => s.name === name)
          if (!target) throw new Error(`未找到服务 ${name}(list 可查看)`)
          const r = await deps.testMcp(target)
          return r.ok ? `连接成功,${r.toolCount ?? 0} 个工具` : `连接失败:${r.error}`
        }
        throw new Error('action 仅支持 list/add/remove/test')
      },
    },
    {
      name: 'skills_config',
      description:
        '管理技能(自然语言自我配置):list 查看技能目录与全部已注册技能(含排除状态) / ' +
        '**create 创建新技能**(name+description+content,写入技能目录,下一轮起可 /技能名 调用——' +
        '用户说"帮我创建一个XX技能"或**解决完问题后把经验沉淀成可复用技能**时用它。' +
        '带脚本的技能:先 create(返回技能目录路径),再用 write_file 把脚本写到 ' +
        '`<技能目录>/scripts/` 下,并在 content 里写明脚本用法(用 exec_command 运行)——' +
        '完整的"经验+脚本"技能闭环) / add 添加目录(绝对路径,扫描其中的 SKILL.md) / ' +
        'remove 移除目录 / **exclude 移除某个技能**(扫描跳过,对话中不再可用,如用户说"把这个技能禁用") / ' +
        'include 恢复被移除的技能。技能名 = 工具名去 skill_ 前缀(list 可查)。' +
        '新增目录/创建/排除技能后下一轮对话起生效。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'create', 'add', 'remove', 'exclude', 'include'],
            description: '操作:list / create(创建技能) / add / remove(目录) / exclude(移除技能) / include(恢复技能)',
          },
          name: { type: 'string', description: 'create:技能名(英文/拼音,自动转小写连字符)' },
          description: { type: 'string', description: 'create:一句话描述(做什么 + 何时用,≤300 字符)' },
          content: { type: 'string', description: 'create:技能文档正文(使用说明/步骤,Markdown,≤50000 字符)' },
          overwrite: { type: 'boolean', description: 'create:同名技能已存在时覆盖,缺省 false' },
          dir: { type: 'string', description: '目录绝对路径(add/remove 用)' },
          skill: { type: 'string', description: '技能名(exclude/include 用,list 可查)' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        const cfg = deps.getConfig()
        const dirs = [...(cfg.skillsDirs ?? [])]
        const excluded = [...(cfg.excludedSkills ?? [])]
        if (action === 'list') {
          // 目录 + 各目录注册的技能(排除状态标注);扫描不带排除过滤,
          // 已排除的也列出并标注,供 include 恢复
          const lines: string[] = []
          if (dirs.length === 0) lines.push('(未配置技能目录)')
          for (const [i, d] of dirs.entries()) lines.push(`${i + 1}. ${d}`)
          const all = (await deps.listSkills?.(dirs, [])) ?? []
          if (all.length === 0) lines.push('(目录下未扫描到技能)')
          for (const t of all) {
            const slug = t.name.replace(/^skill_/, '')
            lines.push(`  - ${slug}${excluded.includes(slug) ? '(已排除)' : ''}`)
          }
          if (excluded.length > 0) {
            lines.push(`已排除技能:${excluded.join('、')}(可用 include 恢复)`)
          }
          return lines.join('\n')
        }
        if (action === 'create') {
          // 创建技能:LLM 提供名称/描述/正文,引擎规范化写入技能目录
          // (userData/skills,默认扫描源之一)→ 下一轮起 /技能名 可用
          const skillDir = deps.getSkillDir?.()
          if (!skillDir) throw new Error('技能创建不可用(未注入技能目录)')
          const name = String(params.name ?? '').trim()
          if (!name) throw new Error('create 需要 name(技能名)')
          const slug =
            name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '') || 'skill'
          const description = String(params.description ?? '').trim().replace(/\s+/g, ' ')
          if (!description) throw new Error('create 需要 description(一句话描述)')
          if (description.length > 300) throw new Error('description 过长(≤300 字符)')
          const content = String(params.content ?? '').trim()
          if (!content) throw new Error('create 需要 content(技能文档正文)')
          if (content.length > 50000) throw new Error('content 过长(≤50000 字符)')
          // 同名冲突:已注册同 slug 且未 overwrite → 报错
          const existing = (await deps.listSkills?.(dirs, [])) ?? []
          if (existing.some((t) => t.name === `skill_${slug}`) && !params.overwrite) {
            throw new Error(`技能 ${slug} 已存在(overwrite=true 可覆盖)`)
          }
          const targetDir = path.join(skillDir, slug)
          const mdPath = path.join(targetDir, 'SKILL.md')
          await fs.mkdir(targetDir, { recursive: true })
          const md = `---\nname: ${slug}\ndescription: ${description}\n---\n\n${content}\n`
          await fs.writeFile(mdPath, md, 'utf8')
          return (
            `已创建技能 ${slug}:\n${mdPath}\n` +
            `对话中可用 /${slug} 调用(下一轮起生效),也可在 设置 → 技能目录(userData/skills) 查看`
          )
        }
        if (action === 'add') {
          const dir = String(params.dir ?? '').trim()
          if (!dir) throw new Error('add 需要 dir(目录绝对路径)')
          if (dirs.includes(dir)) return `目录已存在:${dir}`
          dirs.push(dir)
          if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
          deps.updateAgentConfig({ skillsDirs: dirs })
          return `已添加技能目录 ${dir},下一轮对话起生效`
        }
        if (action === 'remove') {
          const dir = String(params.dir ?? '').trim()
          const idx = dirs.findIndex((d) => d === dir)
          if (idx === -1) throw new Error(`未找到目录 ${dir}(list 可查看)`)
          dirs.splice(idx, 1)
          if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
          deps.updateAgentConfig({ skillsDirs: dirs })
          return `已移除技能目录 ${dir}`
        }
        if (action === 'exclude') {
          const skill = String(params.skill ?? '').trim().replace(/^skill_/, '')
          if (!skill) throw new Error('exclude 需要 skill(技能名,list 可查)')
          // 校验技能存在(不在已注册列表里则报错提示)
          const all = (await deps.listSkills?.(dirs, [])) ?? []
          if (!all.some((t) => t.name.replace(/^skill_/, '') === skill)) {
            throw new Error(`技能 ${skill} 不存在(可用 list 查看全部技能)`)
          }
          if (!excluded.includes(skill)) excluded.push(skill)
          if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
          deps.updateAgentConfig({ excludedSkills: excluded })
          return `已移除技能 ${skill}(扫描跳过,对话中 /${skill} 不再可用;可用 include 恢复)`
        }
        if (action === 'include') {
          const skill = String(params.skill ?? '').trim().replace(/^skill_/, '')
          if (!skill) throw new Error('include 需要 skill(技能名)')
          const idx = excluded.indexOf(skill)
          if (idx === -1) throw new Error(`技能 ${skill} 不在排除列表(可用 list 查看)`)
          excluded.splice(idx, 1)
          if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
          deps.updateAgentConfig({ excludedSkills: excluded })
          return `已恢复技能 ${skill},下一轮对话起可用`
        }
        throw new Error('action 仅支持 list/add/remove/exclude/include')
      },
    },
  ]
}

/** 工具调用参数压缩(测试用导出):递归截断字符串值(大参数如
 * write_file 内容/exec_command 长命令是总结请求的隐藏大块,
 * 拖慢传输与处理导致超时) */
export function compressArgs(value: unknown, depth = 0): unknown {
  if (depth > 4) return '(参数已截断)'
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '…' : value
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => compressArgs(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = compressArgs(v, depth + 1)
    return out
  }
  return value
}

/**
 * 独立的总结后台 Sub Agent:与主对话引擎**零共享**——独立实例、
 * 独立 AbortController、每次调用独立读取配置。主对话的任何操作
 * (发送/中止/模式切换/清空)都无法打断它;它失败/超时也绝不
 * 外溢到主对话(失败返回空串,由调用方重试/补跑)。
 * 与 delegate 子代理同构:独立上下文、事件静默、单轮完成。
 */
export function createSummaryAgent(deps: { getConfig: () => AgentConfig }): {
  /** 静默总结对话标题(无工具单轮,事件不转发 UI);失败/未配置返回空串 */
  summarize(messages: AgentMessage[]): Promise<string>
} {
  return {
    async summarize(messages: AgentMessage[]) {
      const config = deps.getConfig()
      if (!config.apiKey.trim() || messages.length === 0) return ''
      try {
        // 静默总结:无工具、单轮、事件不转发 UI(标题生成不打扰用户);
        // 输入只取最近 12 条消息,并压缩 reasoning(500 字)/工具结果
        // (2000 字)/**工具调用参数(compressArgs)**——标题只需主题,
        // 细节无用,大请求是总结超时的隐藏原因(完整工具结果/长思维链
        // /大参数会拖慢传输与处理);
        // 90s 超时:思考模式 + 高峰期服务慢,45s 实测仍会超;
        // 每个 attempt 独立容错:调用失败(超时/网络)重试一次,仍失败
        // 进入下一个措辞——降级链同时覆盖"空 content"与"调用失败"
        // (旧实现调用失败直接跳出循环,整个总结放弃,是"经常没总结"
        // 的结构性原因)
        const recent = messages.slice(-12).map((m) => ({
          ...m,
          parts: m.parts.map((p) => {
            if (p.type === 'reasoning') return { ...p, text: p.text.slice(0, 500) }
            if (p.type === 'tool-result') return { ...p, result: p.result.slice(0, 2000) }
            if (p.type === 'tool-call') return { ...p, args: compressArgs(p.args) }
            return p
          }),
        }))
        // json_object 官方已知问题"有概率返回空 content"(实测约 60%
        // 空白、含工具历史时尤甚):三级降级链——JSON 模式两种措辞
        // (官方建议"尝试修改 prompt 缓解")→ 纯文本兜底(无
        // response_format,历史上可靠,sanitizeTitle 清洗引号)。
        // 措辞要点:格式示例值会被模型照抄当标题(实测"不超过8个汉字
        // 的简短标题"被原样输出)——示例只描述结构,明确禁止照抄示例词
        const attempts = [
          {
            jsonMode: true,
            system:
              '你是对话标题生成器。输出 JSON 对象:{"title": "<对话标题>"}。' +
              'title 的值是根据对话内容新生成的简短标题(不超过 8 个汉字),' +
              '**禁止照抄示例文字**。只输出这个 JSON,不要任何解释。',
          },
          {
            jsonMode: true,
            system:
              '你是对话标题生成器。直接输出 JSON:{"title": "根据对话内容概括的标题"}。' +
              'title 为不超过 8 个汉字的对话标题,必须来自对话内容,不要使用示例中的文字。' +
              '只输出 JSON。',
          },
          {
            jsonMode: false,
            system:
              '你是对话标题生成器。根据对话内容生成一个不超过 8 个汉字的简短标题,' +
              '直接返回标题文本,不要任何解释、标点或引号。',
          },
        ]
        for (const attempt of attempts) {
          // 每个 attempt 最多尝试 2 次(网络抖动/瞬时超时重试一次)
          for (let retry = 0; retry < 2; retry++) {
            try {
              const result = await streamByConfig({
                config: { ...config, reasoningEffort: 'low' },
                // JSON 模式 prompt 必须含 "json" 字样(官方 json_mode 指南);
                // noThinking——标题生成无需思考(effort 'none' 官方值),
                // 思维链不挤占输出预算(空 content 的典型场景)
                system: attempt.system,
                history: recent,
                tools: [],
                signal: AbortSignal.timeout(90000),
                onEvent: () => {},
                jsonMode: attempt.jsonMode,
                noThinking: true,
              })
              // JSON 措辞走**严格解析**(必须解析出合法 JSON 的 title,
              // 垃圾输出如 "['data']" 直接判无效进入下一级);纯文本措辞
              // 才允许 parseTitleJson 的原文兜底
              const parsed = attempt.jsonMode
                ? extractJsonTitle(result.text)
                : parseTitleJson(result.text)
              const title = sanitizeTitle(parsed)
              // 命中 prompt 示例词(模型照抄示例)/ 代码字面量垃圾
              // (如 ['data'])视为无效,进入下一级
              if (title && !TITLE_LITERAL_EXAMPLES.has(title) && !looksLikeCodeLiteral(title)) {
                return title
              }
              // 空/空白 content 或垃圾输出(官方已知问题):进入下一级尝试
              break
            } catch {
              // 调用失败(超时/网络):同措辞重试一次;仍失败进入下一级
              if (retry === 0) continue
              break
            }
          }
        }
        return ''
      } catch {
        return ''
      }
    },
  }
}

/** 单轮执行上下文 */
interface TurnCtx {
  config: AgentConfig
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
}

export function createAgentEngine(deps: EngineDeps): AgentEngine {
  let running = false
  let ctl: AbortController | null = null

  const emit = (event: AgentEvent) => deps.onEvent(event)

  /**
   * 外部工具源(MCP 服务工具 + 技能目录):每轮循环开始时拉取一次。
   * 配置读取走 getConfig(与引擎其余部分一致);MCP 服务连接失败/
   * 技能目录不存在都静默跳过(返回空数组),不影响对话——真正调用到
   * 该工具时才有错误信息回填 LLM。
   * 注意:技能每次重新扫描(配置变更即时生效,本地文件读取开销可忽略);
   * MCP 已连接的客户端缓存,不会反复握手;连接失败打日志不抛。
   */
  const mcpManager: MCPManager = createMCPManager()
  const skillLoader = createSkillLoader()
  async function getExternalTools(): Promise<AgentTool[]> {
    const cfg = deps.getConfig()
    const [mcpTools, skillTools] = await Promise.all([
      mcpManager.listTools(cfg.mcpServers ?? []).catch((err: Error) => {
        console.error('[agent] MCP 工具加载失败:', err.message)
        return []
      }),
      // 已排除技能(对话/设置里移除)扫描跳过;
      // ownDirs = userData/skills(自己创建的技能,设置界面分区展示)
      skillLoader.listTools(cfg.skillsDirs ?? [], cfg.excludedSkills ?? [], [
        deps.getSkillDir?.() ?? '',
      ]),
    ])
    return [...mcpTools, ...skillTools]
  }
  /** 已禁用工具集合(工具列表视图禁用;每轮实时读配置,禁用下一轮即生效) */
  function excludedToolSet(): Set<string> {
    return new Set(deps.getConfig().excludedTools ?? [])
  }

  /** 记忆存储(主进程注入;未注入时记忆功能禁用) */
  const memoryStore = deps.getMemoryStore?.() ?? null
  /** 记忆 → 系统提示块(静态段;按类型分组,变更才断缓存前缀) */
  async function getMemoryBlock(): Promise<string> {
    if (!memoryStore) return ''
    try {
      const entries = await memoryStore.list()
      return formatMemoryBlock(entries)
    } catch {
      return ''
    }
  }

  /**
   * 子代理:嵌套 agent 循环(独立上下文,事件静默,返回结果文本)。
   * 配合并行工具执行:LLM 一次发多个 delegate 调用即并行子代理。
   * - 可限制工具子集(tools 参数);
   * - reasoning 仍需累积(DeepSeek thinking 模式回传要求);
   * - 工具级 60s 超时兜底(execute 外层 race),内部每轮 55s 超时。
   */
  async function runSubAgent(params: ToolParams): Promise<string> {
    const task = String(params.task ?? '').trim()
    if (!task) throw new Error('delegate 的 task 参数不能为空')
    const config = deps.getConfig()
    if (!config.apiKey.trim()) throw new Error('尚未配置 DeepSeek API Key')
    const allowAll = !Array.isArray(params.tools) || params.tools.length === 0
    const allowed = new Set((Array.isArray(params.tools) ? params.tools : []).map(String))
    // 子代理继承外部工具(MCP + 技能):未限制工具子集时全量可用
    const subTools = [...tools, ...(await getExternalTools())].filter(
      // 已禁用工具不注入子代理(用户禁用的工具任何路径都不可用)
      (t) => !excludedToolSet().has(t.name) && (allowAll || allowed.has(t.name)),
    )
    const subMap = new Map(subTools.map((t) => [t.name, t]))
    const system = [
      config.systemPrompt,
      String(params.system ?? '').trim() ||
        '你是子代理,专注完成委派的子任务,只返回任务结果文本,不要多余解释。',
    ]
      .filter(Boolean)
      .join('\n')
    const historyIn: AgentMessage[] = [
      { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: task }] },
    ]
    const msgParts: AgentPart[] = []
    let reasoningText = ''
    let pushedParts = 0
    for (let step = 1; step <= MAX_STEPS; step++) {
      const result = await streamByConfig({
        config,
        system,
        history: historyIn,
        tools: subTools,
        signal: AbortSignal.timeout(55000),
        onEvent: (event) => {
          // 子代理静默执行(事件不转发 UI,过程由 delegate 卡片呈现)
          if (event.type === 'reasoning-delta') reasoningText += event.text
        },
      })
      if (result.aborted) break
      if (reasoningText) {
        msgParts.push({ type: 'reasoning', text: reasoningText })
        reasoningText = ''
      }
      const text = result.text
      if (text) msgParts.push({ type: 'text', text })
      if (result.calls.length === 0) break
      // 子代理内部工具也并行执行
      const batch = result.calls.map((c) => ({ id: c.id, name: c.name, args: parseToolArgs(c.args) }))
      const results = await executeToolBatch(batch, subMap, subTools)
      for (let i = 0; i < batch.length; i++) {
        const r = results[i]
        msgParts.push({ type: 'tool-call', id: r.id, name: r.name, args: batch[i].args })
        msgParts.push({
          type: 'tool-result',
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs,
        })
      }
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(pushedParts) })
      pushedParts = msgParts.length
    }
    const reply = msgParts
      .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
    return reply || '(子代理未返回文本结果)'
  }

  /** delegate 子代理工具(按需调用:LLM 决定何时委派) */
  const delegateTool: AgentTool = {
    name: 'delegate',
    description:
      '委派子任务给子 Agent 并行处理。适合把大任务拆成多个独立子任务:一次调用多个 delegate 即可并行执行,' +
      '每个子 Agent 有独立上下文,可用工具执行并返回结果文本。注意:子任务之间应尽量独立,避免互相等待。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务描述:要完成什么、期望的输出' },
        system: { type: 'string', description: '可选:子 Agent 专用系统提示(角色/约束/输出格式)' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: '可选:允许子 Agent 使用的工具名列表,缺省全部',
        },
      },
      required: ['task'],
    },
    async execute(params: ToolParams) {
      return runSubAgent(params)
    },
  }

  /**
   * LLM 自我配置工具组:自然语言直接管理 MCP 服务与技能目录。
   * 写配置经 deps.updateAgentConfig(主进程注入,同款校验);
   * 工具清单每轮刷新,新增服务/目录下一轮生效(结果里注明)
   */
  const configTools = createConfigTools({
    getConfig: deps.getConfig,
    updateAgentConfig: deps.updateAgentConfig,
    testMcp: (server) => mcpManager.test(server),
    // 技能扫描(排除校验:确认要排除的技能确实已注册)
    listSkills: (dirs, excluded) => skillLoader.listTools(dirs, excluded),
    // 技能创建写入目录(main.cjs 注入 userData/skills)
    getSkillDir: deps.getSkillDir,
  })

  /** 记忆自我进化工具(委托主进程创建的 harness;后台执行,立即返回) */
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
        rounds: { type: 'number', description: '候选轮数,缺省 2,最大 4(每轮一个候选版本)' },
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

  const tools = [
    ...createTools({
      onSwitchToMusic: deps.onSwitchToMusic,
      // 后台长任务完成(如 bili 下载)→ background-done 事件转发渲染端,
      // 渲染端自动触发一轮对话让 LLM 主动回复(用户无需提问)
      onBackgroundDone: (info) => emit({ type: 'background-done', ...info }),
    }),
    // 灵动岛设置工具(主题色/缩放/字体/背景图库):主进程注入了
    // runIslandSettings 才注册(挂件环境;Web 演示版无主进程)
    ...(deps.runIslandSettings
      ? createSettingsTools({ runIslandSettings: deps.runIslandSettings })
      : []),
    delegateTool,
    ...(memoryStore ? createMemoryTools(memoryStore) : []),
    ...configTools,
    evolveTool,
  ]

  /**
   * 并发执行一批工具调用(每个独立 60s 超时),按传入顺序返回结果。
   * 并行:DeepSeek 并行工具调用始终开启,互不依赖的调用并发跑;
   * 结果按序回填,UI 工具卡片顺序与 parts 顺序一致
   */
  async function executeToolBatch(
    batch: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    map: Map<string, AgentTool>,
    list: AgentTool[],
  ): Promise<Array<{ id: string; name: string; ok: boolean; out: string; durationMs: number }>> {
    return Promise.all(
      batch.map(async ({ id, name, args }) => {
        const tool = map.get(name)
        const started = Date.now()
        let out: string
        let ok: boolean
        if (!tool) {
          out = `未知工具:${name}(可用工具:${list.map((t) => t.name).join('、')})`
          ok = false
        } else {
          try {
            out = await Promise.race([
              Promise.resolve(tool.execute(args)),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`工具执行超时(${TOOL_TIMEOUT_MS / 1000}s)`)), TOOL_TIMEOUT_MS),
              ),
            ])
            ok = true
          } catch (err) {
            out = `工具执行失败:${(err as Error).message}`
            ok = false
          }
        }
        return { id, name, ok, out, durationMs: Date.now() - started }
      }),
    )
  }

  /** 单轮完整循环(每轮由 send 启动,异常/中止都在这里收敛) */
  async function runTurn(text: string, history: AgentMessage[], ctx: TurnCtx) {
    const { signal, onEvent, config } = ctx
    onEvent({ type: 'status', status: 'thinking' })

    // 本轮历史 = 预算裁剪后的完整历史 + 工具循环中追加的助手消息。
    // 约定:history 末尾已含本轮用户消息(渲染端 send 回传的 next 以刚
    // 加入/合并后的 user 消息结尾)——**不再追加**,否则用户消息重复
    // 出现(同一轮请求发两遍);且中止后渲染端把新输入合并进"未答复的
    // 用户消息"时,无脑追加会把合并结果再拆开,污染复现。
    // 防御:历史缺尾(如直接调用 send 的旧脚本)则按 text 补一条。
    // 注意必须复制数组:trimHistory 未超限时返回原引用,后续 push 助手
    // 消息会改到调用方(渲染端)的历史
    const historyIn: AgentMessage[] = [...trimHistory(history)]
    const lastMsg = historyIn[historyIn.length - 1]
    if (lastMsg?.role !== 'user') {
      historyIn.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] })
    }
    // 本轮助手消息的 parts(文本 / 工具调用 / 工具结果,按执行顺序累积)
    const msgParts: AgentPart[] = []
    // 已回填历史的 parts 数:每轮只把"新增部分"推给下一轮,
    // 避免整段累积 parts 重复回填(上下文成倍膨胀)
    let pushedParts = 0
    // reasoning 累积:流式事件旁路拦截(仅用于最终消息落定时展示)
    let reasoningText = ''
    let usage: { input: number; output: number; cached?: number } = { input: 0, output: 0 }

    // 手动调用:/技能名 或 @mcp工具名 —— 循环前先执行工具,结果以
    // tool-call/tool-result parts 入历史,LLM 基于结果直接回复
    // (事件照常转发,UI 工具卡片与自动调用一致)
    const manual = parseManualCall(text)
    if (manual) {
      // 已禁用工具同样不可手动调用(不注入,匹配不到给出提示)
      const turnTools = [...tools, ...(await getExternalTools())].filter(
        (t) => !excludedToolSet().has(t.name),
      )
      const found = findManualTool(turnTools, manual.name)
      if (!found.tool) {
        onEvent({ type: 'error', message: found.hint })
        onEvent({ type: 'status', status: 'idle' })
        return
      }
      onEvent({ type: 'status', status: 'running' })
      const id = randomUUID()
      // 剩余文本:是合法 JSON 对象则作为参数,否则空参数
      // (文本进用户消息,LLM 有上下文可理解意图)
      let args: Record<string, unknown> = {}
      const rest = manual.rest.trim()
      if (rest) {
        try {
          const parsed = JSON.parse(rest)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
        } catch {
          // 非 JSON:空参数
        }
      }
      onEvent({ type: 'tool-call', id, name: found.tool.name, args: JSON.stringify(args) })
      msgParts.push({ type: 'tool-call', id, name: found.tool.name, args })
      const started = Date.now()
      let ok = true
      let out = ''
      try {
        out = await Promise.race([
          Promise.resolve(found.tool.execute(args)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`工具执行超时(${TOOL_TIMEOUT_MS / 1000}s)`)), TOOL_TIMEOUT_MS),
          ),
        ])
      } catch (err) {
        ok = false
        out = `工具执行失败:${(err as Error).message}`
      }
      onEvent({ type: 'tool-result', id, name: found.tool.name, ok, result: out, durationMs: Date.now() - started })
      msgParts.push({ type: 'tool-result', id, name: found.tool.name, ok, result: out, durationMs: Date.now() - started })
      // 手动调用的执行结果入历史(在用户消息之后),LLM 第一步即看到
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(0) })
      pushedParts = msgParts.length
    }

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) return
      // 系统提示 = 配置提示词 + 长期记忆块 + 后台长任务状态块(记忆与
      // 状态都是静态/半静态段:记忆变更才断缓存前缀,状态块文案稳定)。
      // bili 下载等长任务完成信息若只靠一次性系统通知,后续对话中
      // LLM 对完成与否毫无感知,会惯性回复"还在下载/完成后会通知"
      // (实测 bug);状态注入后 LLM 可依据真实状态如实回答。
      const bgStatus = getBiliBackgroundStatus()
      const memoryBlock = await getMemoryBlock()
      const evolutionStatus = (await deps.getEvolution?.()?.getStatus()) ?? ''
      const system = [
        config.systemPrompt || '你是桌面灵动岛挂件里的个人助手。',
        memoryBlock,
        evolutionStatus,
        bgStatus,
      ]
        .filter(Boolean)
        .join('\n\n')
      // 本轮工具清单 = 内置 + MCP 服务工具 + 技能(每步刷新:
      // MCP 服务崩溃/配置变更即时反映;命中缓存时零开销)。
      // 已禁用工具(工具列表禁用)过滤掉,LLM 看不到也调不到
      const turnTools = [...tools, ...(await getExternalTools())].filter(
        (t) => !excludedToolSet().has(t.name),
      )
      const turnMap = new Map(turnTools.map((t) => [t.name, t]))
      const result = await streamByConfig({
        config,
        system,
        history: historyIn,
        tools: turnTools,
        signal,
        onEvent: (event) => {
          if (event.type === 'reasoning-delta') reasoningText += event.text
          onEvent(event)
        },
      })
      if (result.aborted || signal.aborted) return
      if (result.usage) {
        usage.input += result.usage.input_tokens
        usage.output += result.usage.output_tokens
        if (result.usage.cached_tokens) usage.cached = (usage.cached ?? 0) + result.usage.cached_tokens
      }

      // DeepSeek thinking 模式要求 reasoning_text 回传(缺失会 400
      // "The reasoning_text in the thinking mode must be passed back to the API"):
      // 每轮(含工具循环)都把思维链存入 parts,历史序列化时输出
      // reasoning item —— 工具调用后的下一轮请求必须带上上一轮的思维链
      if (reasoningText) {
        msgParts.push({ type: 'reasoning', text: reasoningText })
        reasoningText = ''
      }

      const text = result.text
      if (text) msgParts.push({ type: 'text', text })

      const calls = result.calls
      if (calls.length === 0) {
        // 纯文本回复:本轮结束,落定权威消息(reasoning 已在上方入列)
        onEvent({
          type: 'message',
          message: { id: randomUUID(), role: 'assistant', parts: msgParts },
          usage,
        })
        onEvent({ type: 'status', status: 'idle' })
        return
      }

      // 有工具调用:进入执行阶段(参数已全程可见:tool-call 事件先发)。
      // 并行执行:DeepSeek 并行工具调用始终开启,互不依赖的调用并发跑
      // (多个 delegate 即并行子代理);结果按调用顺序回填
      onEvent({ type: 'status', status: 'running' })
      const batch: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
      for (const call of calls) {
        if (signal.aborted) return
        const args = parseToolArgs(call.args)
        msgParts.push({ type: 'tool-call', id: call.id, name: call.name, args })
        batch.push({ id: call.id, name: call.name, args })
      }
      const results = await executeToolBatch(batch, turnMap, turnTools)
      for (const r of results) {
        if (signal.aborted) return
        onEvent({
          type: 'tool-result',
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs,
        })
        msgParts.push({
          type: 'tool-result',
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs,
        })
      }

      // 把本轮新增的助手 parts(思维链 + 文本 + 调用 + 结果)回填历史,
      // 供下一轮上下文
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(pushedParts) })
      pushedParts = msgParts.length
    }

    onEvent({ type: 'error', message: `工具循环超过 ${MAX_STEPS} 轮仍未完成,已停止(请拆解任务或换种思路再试)` })
    onEvent({ type: 'status', status: 'idle' })
  }

  return {
    get busy() {
      return running
    },
    send(text: string, history: AgentMessage[]) {
      if (running) {
        emit({ type: 'error', message: 'Agent 正在运行中,请先等待或中止' })
        return
      }
      const config = deps.getConfig()
      if (!config.apiKey.trim()) {
        emit({ type: 'error', message: '尚未配置 DeepSeek API Key(托盘菜单 → 设置 → Agent 设置)' })
        return
      }
      running = true
      ctl = new AbortController()
      void runTurn(text, history, { config, signal: ctl.signal, onEvent: emit })
        .catch((err: unknown) => {
          if ((err as Error).name !== 'AbortError') {
            emit({ type: 'error', message: (err as Error).message || String(err) })
          }
        })
        .finally(() => {
          running = false
          ctl = null
        })
    },
    abort() {
      if (!running) return
      ctl?.abort()
      emit({ type: 'status', status: 'idle' })
    },
    listTools() {
      // 只暴露描述(名称/说明/参数 schema),不含执行函数
      return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    },
    async listAllTools() {
      // 内置 + 外部(MCP 未连接的服务跳过;技能实时扫描)。
      // UI 工具列表视图展示用;MCP 服务启动失败不影响其他工具
      const external = await getExternalTools()
      return [...tools, ...external].map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        // 技能来源分区(自己创建 vs 扫描到;设置界面分区展示)
        sourceKind: t.sourceKind,
      }))
    },
    async testMCP(server: McpServerConfig) {
      return mcpManager.test(server)
    },
    dispose() {
      mcpManager.dispose()
    },
  }
}

// 自我进化 harness 与记忆存储(独立模块,provider 分发由 provider.ts
// 承担,无循环依赖;main.cjs 从同一打包产物取 createEvolution/createMemoryStore)
export { createEvolution } from './evolution'
export { createMemoryStore } from './memory'

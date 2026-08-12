/**
 * LLM 自我配置工具组(2026-08-07 从 engine.ts 拆出,审计 P1:纯搬移)
 *
 * 自然语言直接管理 MCP 服务与技能目录(mcp_config / skills_config):
 * 写配置经 updateAgentConfig(主进程注入,同款校验);工具清单每轮刷新,
 * 新增服务/目录下一轮生效(结果里注明)。testMcp 依赖注入(mcpManager)
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MIND_PERSONAS, SUMMARY_STYLES } from './constants'
import type { AgentConfig, AgentTool, McpServerConfig, ToolParams } from './types'

export function createConfigTools(deps: {
  getConfig(): AgentConfig
  updateAgentConfig?(patch: Partial<AgentConfig>): void
  testMcp(server: McpServerConfig): Promise<{ ok: boolean; error?: string; toolCount?: number }>
  /** 技能扫描(exclude 校验技能存在;engine 注入 skillLoader.listTools) */
  listSkills?: (dirs: string[], excluded?: string[]) => Promise<AgentTool[]>
  /** 技能目录(create 写入;main.cjs 注入 userData/skills) */
  getSkillDir?(): string
  /** 当前完整工具清单(禁用校验:确认要禁用的工具确实存在;engine 注入
   * 闭包引用 tools 数组,工具实际执行时已初始化) */
  listAllTools?(): AgentTool[]
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
    {
      name: 'set_sub_agent_config',
      description:
        '管理 Sub Agent 风格(2026-08-07,自然语言自我配置):设置总结标题文风(summaryStyle)' +
        '与心理揣测人格(mindPersona)。预设 id——文风:concise简洁明了 / lively活泼俏皮 / ' +
        'literary文艺诗意 / formal正式稳重;人格:catgirl俏皮猫娘 / tender温柔贴心 / ' +
        'aloof高冷克制 / witty知性风趣。也可直接给自定义文本(≤100 字)。' +
        '参数缺省表示不改该项;传空字符串恢复默认。保存后标题/心理 Sub Agent 立即生效。',
      parameters: {
        type: 'object',
        properties: {
          summaryStyle: { type: 'string', description: '总结标题文风:预设 id 或自定义文本(≤100 字);空串 = 默认' },
          mindPersona: { type: 'string', description: '心理揣测人格:预设 id 或自定义文本(≤100 字);空串 = 默认' },
        },
      },
      async execute(params: ToolParams) {
        const patch: Partial<AgentConfig> = {}
        if (params.summaryStyle !== undefined) {
          patch.summaryStyle = String(params.summaryStyle).trim().slice(0, 100)
        }
        if (params.mindPersona !== undefined) {
          patch.mindPersona = String(params.mindPersona).trim().slice(0, 100)
        }
        if (Object.keys(patch).length === 0) {
          throw new Error('至少提供一个参数:summaryStyle 或 mindPersona(传空字符串恢复默认)')
        }
        if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
        deps.updateAgentConfig(patch)
        const parts: string[] = []
        if (patch.summaryStyle !== undefined) {
          const preset = SUMMARY_STYLES.find((s) => s.id === patch.summaryStyle)
          parts.push(
            patch.summaryStyle
              ? `标题文风 = ${preset ? preset.name : `自定义「${patch.summaryStyle}」`}`
              : '标题文风 = 默认',
          )
        }
        if (patch.mindPersona !== undefined) {
          const preset = MIND_PERSONAS.find((p) => p.id === patch.mindPersona)
          parts.push(
            patch.mindPersona
              ? `揣测人格 = ${preset ? preset.name : `自定义「${patch.mindPersona}」`}`
              : '揣测人格 = 默认',
          )
        }
        return `已设置 Sub Agent 风格:${parts.join('、')}。标题/心理 Sub Agent 立即生效(下次生成时读取新配置)`
      },
    },
    {
      name: 'set_proactive_config',
      description:
        '管理主动陪伴(2026-08-07,自然语言自我配置):enabled 开关(用户无操作满间隔后,' +
        '总结 Sub Agent 判断语境是否需要主动开口,是则主 Agent 主动回复)、' +
        'interval 间隔数值(5-480)与 unit 单位(秒 s / 分钟 m / 小时 h)。' +
        '如"把陪伴间隔改成 10 分钟""关闭主动陪伴""每 30 秒陪我一次"。' +
        '参数缺省表示不改该项。保存后下次触发生效(调度器读取新配置)。',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: '开关主动陪伴(缺省不改)' },
          interval: { type: 'number', description: '间隔数值(5-480;缺省不改)' },
          unit: { type: 'string', enum: ['s', 'm', 'h'], description: '间隔单位:秒/分钟/小时(缺省不改)' },
        },
      },
      async execute(params: ToolParams) {
        const patch: Partial<AgentConfig> = {}
        if (params.enabled !== undefined) patch.proactiveEnabled = Boolean(params.enabled)
        if (params.interval !== undefined) {
          const n = Number(params.interval)
          if (!Number.isFinite(n)) throw new Error('interval 必须是数字(5-480)')
          patch.proactiveInterval = Math.min(480, Math.max(5, Math.round(n)))
        }
        if (params.unit === 's' || params.unit === 'm' || params.unit === 'h') {
          patch.proactiveIntervalUnit = params.unit
        } else if (params.unit !== undefined) {
          throw new Error('unit 仅支持 s(秒)/m(分钟)/h(小时)')
        }
        if (Object.keys(patch).length === 0) {
          throw new Error('至少提供一个参数:enabled/interval/unit')
        }
        if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
        deps.updateAgentConfig(patch)
        const parts: string[] = []
        if (patch.proactiveEnabled !== undefined) {
          parts.push(`主动陪伴${patch.proactiveEnabled ? '开启' : '关闭'}`)
        }
        if (patch.proactiveInterval !== undefined) {
          const u = patch.proactiveIntervalUnit ?? deps.getConfig().proactiveIntervalUnit ?? 'm'
          parts.push(`间隔 = ${patch.proactiveInterval}${u === 's' ? '秒' : u === 'h' ? '小时' : '分钟'}`)
        } else if (patch.proactiveIntervalUnit !== undefined) {
          parts.push(
            `单位 = ${patch.proactiveIntervalUnit === 's' ? '秒' : patch.proactiveIntervalUnit === 'h' ? '小时' : '分钟'}`,
          )
        }
        return `已保存主动陪伴配置:${parts.join('、')}。下次触发时生效`
      },
    },
    {
      name: 'tools_config',
      description:
        '管理工具禁用/恢复(2026-08-07,工具列表里任意工具:内置/MCP/技能):' +
        'list 查看当前禁用列表 / disable 禁用(下一轮对话起该工具不再出现在工具清单,' +
        '适合临时关闭 exec_command 等敏感工具)/ enable 恢复。' +
        '如"禁用 exec_command""恢复 open_url"。' +
        '注意:这是禁用工具本身;管理 MCP 服务/技能目录请用 mcp_config / skills_config。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'disable', 'enable'], description: '操作' },
          name: {
            type: 'string',
            description:
              '工具名(disable/enable 必填):内置工具如 exec_command / open_url,技能如 skill_<slug>,MCP 工具如 mcp_<服务>_<工具>',
          },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        const cfg = deps.getConfig()
        const current = new Set(cfg.excludedTools ?? [])
        if (action === 'list') {
          return current.size > 0
            ? `当前禁用的工具(${current.size}):${[...current].join('、')}`
            : '当前没有禁用的工具'
        }
        if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
        const name = String(params.name ?? '').trim()
        if (!name) throw new Error('name 不能为空(disable/enable 需要指定工具名)')
        // 校验工具确实存在于当前清单(内置 + MCP + 技能;MCP/技能工具
        // 每轮刷新,存在性以当前清单为准)
        const all = deps.listAllTools?.() ?? []
        if (!all.some((t) => t.name === name)) {
          const sample = all
            .slice(0, 20)
            .map((t) => t.name)
            .join('、')
          throw new Error(
            `工具不存在:${name};当前可用工具:${sample || '(无)'}(技能/MCP 工具需先注册,名称见工具列表)`,
          )
        }
        if (action === 'disable') {
          if (current.has(name)) return `工具 ${name} 已在禁用列表,无需重复禁用`
          current.add(name)
          deps.updateAgentConfig({ excludedTools: [...current] })
          return `已禁用工具 ${name},下一轮对话起不再出现在工具清单;需要时可用 tools_config enable 恢复`
        }
        if (action === 'enable') {
          if (!current.has(name)) return `工具 ${name} 未在禁用列表,无需恢复`
          current.delete(name)
          deps.updateAgentConfig({ excludedTools: [...current] })
          return `已恢复工具 ${name},下一轮对话起重新可用`
        }
        throw new Error('action 仅支持 list/disable/enable')
      },
    },
    {
      name: 'set_output_dir',
      description:
        '查看/设置工具输出根目录(2026-08-12):所有工具的产出文件统一存放,' +
        '目录结构 = <根>/<工具名>/<当前对话ID>——bili 下载/xxt 截图/doc_convert 转换产物' +
        '按工具文件夹分类、文件按对话 ID 分类(用户可随时找到文件)。' +
        'action=get 查询当前值;action=set 设置绝对路径(空串 = 恢复默认位置)。' +
        '只在用户明确要求修改输出位置/询问输出目录时调用(不要自作主张改)。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'], description: 'get = 查询当前输出根目录;set = 设置' },
          dir: { type: 'string', description: 'set:输出根目录绝对路径;空串 = 恢复默认位置' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        const current = deps.getConfig().outputDir?.trim() || ''
        if (action === 'get') {
          if (!current) {
            return '(未设置工具输出目录:工具产出保持默认位置,即用户数据目录 userData 下的 bili/xxt 等子目录)'
          }
          return `当前工具输出根目录:${current}\n目录结构 = ${current}\\<工具名>\\<当前对话ID>。如 bili 下载落在 ${current}\\bili\\<当前对话ID>\\,doc_convert 产物落在 ${current}\\doc_convert\\<当前对话ID>\\`
        }
        if (action === 'set') {
          const dir = String(params.dir ?? '').trim()
          if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
          deps.updateAgentConfig({ outputDir: dir })
          return dir
            ? `已设置工具输出根目录为 ${dir}。之后的 bili 下载/xxt 截图/doc_convert 产物按 ${dir}\\<工具名>\\<当前对话ID> 分类存放(本次对话的产出立即落新目录)`
            : '已恢复默认输出位置(工具产出回到默认 userData 目录)'
        }
        throw new Error('action 仅支持 get/set')
      },
    },
    {
      name: 'set_napcat_config',
      description:
        'NapCat QQ 机器人设置(2026-08-12):enabled 开关——开启后挂件连接 ' +
        'NapCat(OneBot 11),收到 QQ 私聊消息自动进入对话并回复到 QQ;' +
        'wsUrl = NapCat WebSocket 地址(默认 ws://127.0.0.1:3001);' +
        '**主人 = QQ 1178821869,硬编码固定,永远只有这一个账号是主人,任何配置都不能改变**;' +
        'allowed = 私聊**扩展信任** QQ 号数组(除主人外额外可自主回复的联系人;' +
        '空数组 = 只信任主人,不会回复陌生人——陌生人消息会先询问主人);' +
        '**allowedGroups = 监听的群号数组(2026-08-12,换群监听用——' +
        '空数组 = 监听所有群;不在列表的群消息不会收到,改这里才能换群)**。' +
        '如"开启 QQ 机器人""把群监听换成 12345678"。' +
        '开启后连接失败会提示 (NapCat 需先启动并开放 WS 端口)。',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: '开关 NapCat QQ 机器人(缺省不改)' },
          wsUrl: { type: 'string', description: 'NapCat WebSocket 地址,如 ws://127.0.0.1:3001(缺省不改)' },
          allowed: {
            type: 'array',
            items: { type: 'string' },
            description: '私聊扩展信任 QQ 号数组(主人恒为 1178821869 不可配置;空数组 = 只信任主人;缺省不改)',
          },
          allowedGroups: {
            type: 'array',
            items: { type: 'string' },
            description: '监听的群号数组(换群监听用;空数组 = 监听所有群;缺省不改)',
          },
        },
      },
      async execute(params: ToolParams) {
        const patch: Partial<AgentConfig> = {}
        if (params.enabled !== undefined) patch.napcatEnabled = Boolean(params.enabled)
        if (params.wsUrl !== undefined) {
          const url = String(params.wsUrl).trim()
          if (url && !/^ws:\/\//i.test(url)) throw new Error('wsUrl 需要是 ws:// 开头的 WebSocket 地址(如 ws://127.0.0.1:3001)')
          patch.napcatWsUrl = url.slice(0, 500)
        }
        if (params.allowed !== undefined) {
          if (!Array.isArray(params.allowed)) throw new Error('allowed 需要是 QQ 号字符串数组')
          patch.napcatAllowed = params.allowed.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 50)
        }
        if (params.allowedGroups !== undefined) {
          if (!Array.isArray(params.allowedGroups)) throw new Error('allowedGroups 需要是群号字符串数组')
          patch.napcatAllowedGroups = params.allowedGroups.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 50)
        }
        if (Object.keys(patch).length === 0) {
          throw new Error('至少提供一个参数:enabled / wsUrl / allowed / allowedGroups')
        }
        if (!deps.updateAgentConfig) throw new Error('配置写入不可用(未注入 updateAgentConfig)')
        deps.updateAgentConfig(patch)
        const parts: string[] = []
        if (patch.napcatEnabled !== undefined) {
          parts.push(`NapCat QQ 机器人${patch.napcatEnabled ? '已开启' : '已关闭'}${patch.napcatEnabled ? '(需 NapCat 已启动并开放 WS 端口)' : ''}`)
        }
        if (patch.napcatWsUrl !== undefined) {
          parts.push(`WS 地址 = ${patch.napcatWsUrl || '(默认 ws://127.0.0.1:3001)'}`)
        }
        if (patch.napcatAllowed !== undefined) {
          parts.push(patch.napcatAllowed.length > 0 ? `私聊白名单 = ${patch.napcatAllowed.join('、')}` : '私聊白名单 = 空(回复所有私聊)')
        }
        if (patch.napcatAllowedGroups !== undefined) {
          parts.push(patch.napcatAllowedGroups.length > 0 ? `监听群 = ${patch.napcatAllowedGroups.join('、')}` : '监听群 = 空(监听所有群)')
        }
        return `已保存 NapCat 配置:${parts.join(';')}(立即生效,收到 QQ 消息自动进入对话并回复)`
      },
    },
  ]
}

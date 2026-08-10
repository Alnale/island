/**
 * 后台标签 Sub Agent —— 总结标题 + 心理揣测
 * (2026-08-07 从 engine.ts 拆出,审计 P1:纯搬移零行为变化;
 * 依赖仅 provider/types/memory/tools,零引擎状态,可独立测试)
 *
 * 与主对话引擎**零共享**:独立实例、独立 AbortController、每次调用
 * 独立读取配置。主对话的任何操作(发送/中止/模式切换/清空)都无法
 * 打断它们;失败/超时也绝不外溢到主对话(返回空串,由调用方重试/
 * 回退)。事件静默,不转发 UI。
 */

import { streamByConfig } from './provider'
import { formatMemoryBlock } from './memory'
import { getTasksStatusBlock } from './tasks'
import { MIND_PERSONAS, SUMMARY_STYLES } from './constants'
import type { AgentConfig, AgentMessage, AgentPart, EvolutionLike, MemoryStoreLike } from './types'

/**
 * 工具调用参数压缩(测试用导出):递归截断字符串值(大参数如
 * write_file 内容/exec_command 长命令是总结请求的隐藏大块,
 * 拖慢传输与处理导致超时)
 */
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
 * 总结标题清洗与截断(测试用导出):去首尾引号/书名号/空白(LLM 可能
 * 不遵守"不要引号"的约束)、剥「标题:」「对话标题是」等前缀与尾随
 * 句末标点(纯文本措辞下模型常输出"标题:xxx"/"xxx。",不剥会得到
 * "标题:怎样配置M"这类错标题),按 code point 截断到岛体文字区
 * 显示容量(2026-08-07 用户要求放宽:推荐 10 字左右、**严格不超过
 * 20 字**——紧凑态文字区随字数扩展岛宽,20 字约 420px < MAX_WIDTH_PX;
 * 原 8 字太短,长话题被压成"开头几字",观感等同"总结失败")
 */
export function sanitizeTitle(raw: string): string {
  const text = raw
    .trim()
    .replace(/^[「『"'《<]+|[」』"'》>]+$/g, '')
    .replace(/^(?:对话)?标题\s*[:：是]?\s*/, '')
    .replace(/[。！？!?…]+$/, '')
    .trim()
  return Array.from(text).slice(0, 20).join('')
}

/**
 * 确定性兜底标题(测试用导出):LLM 总结全部失败(空 content / 调用
 * 超时 / 垃圾输出)时,从对话内容本地派生——取**首条用户消息**文本
 * (标题只需主题,截 10 码元)。保证标题永不为空:文字区不会因总结
 * 失败永久停在"回复开头预览",观感等同"没有总结"
 */
export function fallbackTitle(messages: AgentMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = m.parts
      .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
    if (text.trim()) return sanitizeTitle(text)
  }
  return ''
}

/**
 * 后台标签 Sub Agent(总结标题 / 心理揣测)共用的输入压缩:
 * 最近 12 条,reasoning 截 500、工具结果截 2000、工具参数压缩
 * (compressArgs)——标签只需主题与最后回复,细节无用,大请求是
 * 这类单轮任务超时/变慢的隐藏原因
 */
function recentMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.slice(-12).map((m) => ({
    ...m,
    parts: m.parts.map((p) => {
      if (p.type === 'reasoning') return { ...p, text: p.text.slice(0, 500) }
      if (p.type === 'tool-result') return { ...p, result: p.result.slice(0, 2000) }
      if (p.type === 'tool-call') return { ...p, args: compressArgs(p.args) as Record<string, unknown> }
      return p
    }),
  }))
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
 * 简短标题"被原样输出;命中视为无效,进入下一级降级;2026-08-07
 * 措辞放宽为推荐 10 字/上限 20 字,示例词同步更新,旧词保留兼容) */
const TITLE_LITERAL_EXAMPLES = new Set([
  '简短标题',
  '不超过8个汉字的简短标题',
  '不超过20个汉字的简短标题',
  '推荐10字左右的简短标题',
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
  const obj = extractJsonObject(raw)
  if (obj && typeof obj.title === 'string' && obj.title.trim()) return obj.title.trim()
  return ''
}

/**
 * 通用严格 JSON 对象解析(测试用导出;extractJsonTitle 与主动陪伴判断
 * 共用):依次尝试 原文 / 剥离 ```json``` 代码块 / 从第一个 { 截取 /
 * 第一个 { 到最后一个 } 截取(容忍尾随内容),每档再试单引号→双引号
 * 归一化(模型常输出 Python 风格 dict:{'key': 'value'})。解析出合法
 * JSON 对象即返回,全部失败返回 null——调用方按自己的语义兜底(标题
 * 返回空、主动陪伴判断按 should:false 处理,安全侧)
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim(),
    text.slice(text.indexOf('{')).trim(),
    // 取第一个 { 到最后一个 } 之间的子串(容忍尾随内容)
    text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1).trim(),
  ]
  for (const c of candidates) {
    if (!c) continue
    // 原文 → 单引号替换为双引号(容忍 Python 风格 dict)
    for (const candidate of [c, c.replace(/'/g, '"')]) {
      try {
        const obj = JSON.parse(candidate) as unknown
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          return obj as Record<string, unknown>
        }
      } catch {
        // 尝试下一个候选
      }
    }
  }
  return null
}

/** 明显不是标题的代码字面量(模型输出垃圾时防串味):
 * 括号包裹的数组/元组字面量(如 ['data'])、空括号(测试用导出) */
export function looksLikeCodeLiteral(title: string): boolean {
  return /^\[.*\]$/s.test(title) || /^\(.*\)$/s.test(title)
}

/**
 * Sub Agent 风格配置解析(测试用导出):预设 id → 提示词片段(查表,
 * SUMMARY_STYLES / MIND_PERSONAS 定义在 constants.ts——渲染端设置界面
 * 可安全 import);自定义文本(≤100 字)原样返回;空返回 ''。
 * 设置存 id 或自定义文本,与 UI 预设按钮/输入一致
 */
export function resolveSubAgentStyle(kind: 'summary' | 'mind', value: string | undefined): string {
  if (!value || !value.trim()) return ''
  const v = value.trim()
  const table = kind === 'summary' ? SUMMARY_STYLES : MIND_PERSONAS
  const preset = table.find((s) => s.id === v)
  if (preset) return preset.desc
  return v.length > 100 ? v.slice(0, 100) : v
}

// 预设表 re-export(engine.ts 再导出保持测试/UI 导入路径;定义在
// constants.ts:渲染端零 node 依赖可安全 import)
export { MIND_PERSONAS, SUMMARY_STYLES } from './constants'

/** 主动陪伴判断系统提示(JSON 措辞;json_mode 要求 prompt 含 "json" 字样;
 * 明确列举判 false 的情形——判断偏保守 = 不打扰,是安全侧;
 * 2026-08-10 用户要求"对工具调用更积极、更拟人":适合的情形增加
 * "值得用工具动手/查证的事"——人是会用工具的,主动开口时顺手把事办了
 * 比单纯问候更自然) */
const JUDGE_SYSTEM_PROMPT = (idleMinutes: number) =>
  '你是灵动岛的「主动陪伴判断师」。用户已连续 ' +
  idleMinutes +
  ' 分钟没有与助手互动。根据对话语境独立判断:现在是否是助手主动开启对话的好时机?' +
  '适合:① 对话留有未竟话题、用户在等结果(后台任务状态块中有等待人工操作的任务' +
  '(如扫码登录)或进行中的下载/转换时尤其适合——用户可能正等着,主动告知进度是贴心);' +
  '② 有值得动手帮忙或查证的事——用户之前提过想做的事、话题需要实时信息(助手可用 ' +
  'web_search 查证后再开口,不要凭空猜)、可以用灵动岛设置工具帮用户改善体验' +
  '(如用户抱怨过字太小/背景看不清/主题色不喜欢);③ 用户表现出需要关心/陪伴。' +
  '不适合:对话刚自然结束、用户明确表示不想被打扰、没有值得跟进或动手的内容、' +
  '上下文太短无法判断。' +
  '只输出 JSON 对象:{"should": true或false, "hint": "建议话题或动作(可选,should为true时给,不超过20字)"}。' +
  'hint 可包含"该用什么工具做什么"(如"用 web_search 查一下…"),让主动开口不只是问候而是行动。' +
  '不要解释,不要照抄示例文字。'

/**
 * 主动陪伴判断系统提示拼装(测试用导出):**与主对话引擎同源上下文**——
 * 自定义提示词 + 长期记忆块 + 进化状态 + 后台任务状态 + 当前时间,
 * 再接判断指令。判断必须知道助手"是谁、记得什么、在忙什么、现在几点"
 * (记忆说"用户在开会别打扰" → should:false),否则判断是猜的空气
 */
export function buildJudgeSystem(context: string[], idleMinutes: number): string {
  const blocks = [context.filter(Boolean).join('\n\n'), JUDGE_SYSTEM_PROMPT(idleMinutes)]
  return blocks.filter(Boolean).join('\n\n')
}

/** 主动陪伴判断 JSON 解析(测试用导出):必须解析出合法 {should: boolean};
 * 解析失败/垃圾输出返回 null(调用方按 should:false 处理,安全侧) */
export function parseJudgeJson(raw: string): { should: boolean; hint?: string } | null {
  const obj = extractJsonObject(raw)
  if (!obj) return null
  if (obj.should !== true && obj.should !== false) return null
  const hint = typeof obj.hint === 'string' ? obj.hint.trim().slice(0, 200) : undefined
  return hint ? { should: obj.should, hint } : { should: obj.should }
}

/**
 * 独立的总结后台 Sub Agent:与主对话引擎**零共享**——独立实例、
 * 独立 AbortController、每次调用独立读取配置。主对话的任何操作
 * (发送/中止/模式切换/清空)都无法打断它;它失败/超时也绝不
 * 外溢到主对话(失败返回空串,由调用方重试/补跑)。
 * 与 delegate 子代理同构:独立上下文、事件静默、单轮完成。
 * 2026-08-07 起兼任**主动陪伴判断师**(judgeProactive):它有总结上下文
 * 的能力,用户无操作满 N 分钟后独立判断当前语境是否需要主动开口,
 * 是则主 Agent 完整回合主动回复
 */
export function createSummaryAgent(deps: {
  getConfig: () => AgentConfig
  /** 长期记忆(与主引擎同源:记忆块进判断上下文,判断才知道助手记得什么) */
  getMemoryStore?(): MemoryStoreLike | null
  /** 自我进化 harness(状态块进判断上下文;未注入则省略) */
  getEvolution?(): EvolutionLike | null
}): {
  /** 静默总结对话标题(无工具单轮,事件不转发 UI);失败/未配置返回空串 */
  summarize(messages: AgentMessage[]): Promise<string>
  /**
   * 主动陪伴判断(2026-08-07):用户无操作满 idleMinutes 分钟时,根据当前
   * 语境判断是否需要主动开口。失败/未配置返回 {should:false}(安全侧,
   * 零 LLM 调用);should:true 时 hint 为建议话题(≤200 字)
   */
  judgeProactive(messages: AgentMessage[], idleMinutes: number): Promise<{ should: boolean; hint?: string }>
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
        const recent = recentMessages(messages)
        // Sub Agent 设置(2026-08-07):总结标题文风(预设 id 或自定义 ≤100 字)
        // 注入三级措辞,全部生效
        const styleBlock = resolveSubAgentStyle('summary', config.summaryStyle)
        const withStyle = (sys: string) => (styleBlock ? `${sys}\n${styleBlock}` : sys)
        // json_object 官方已知问题"有概率返回空 content"(实测约 60%
        // 空白、含工具历史时尤甚):三级降级链——JSON 模式两种措辞
        // (官方建议"尝试修改 prompt 缓解")→ 纯文本兜底(无
        // response_format,历史上可靠,sanitizeTitle 清洗引号)。
        // 措辞要点:格式示例值会被模型照抄当标题(实测"不超过8个汉字
        // 的简短标题"被原样输出)——示例只描述结构,明确禁止照抄示例词;
        // 2026-08-07 用户要求放宽:推荐 10 字左右,严格不超过 20 字
        const attempts = [
          {
            jsonMode: true,
            system: withStyle(
              '你是对话标题生成器。输出 JSON 对象:{"title": "<对话标题>"}。' +
                'title 的值是根据对话内容新生成的简短标题,**推荐 10 字左右,严格不超过 20 字**,' +
                '**禁止照抄示例文字**。只输出这个 JSON,不要任何解释。',
            ),
          },
          {
            jsonMode: true,
            system: withStyle(
              '你是对话标题生成器。直接输出 JSON:{"title": "根据对话内容概括的标题"}。' +
                'title 为对话标题,**推荐 10 字左右,严格不超过 20 字**,必须来自对话内容,不要使用示例中的文字。' +
                '只输出 JSON。',
            ),
          },
          {
            jsonMode: false,
            system: withStyle(
              '你是对话标题生成器。根据对话内容生成一个简短标题,**推荐 10 字左右,严格不超过 20 字**,' +
                '直接返回标题文本,不要任何解释、标点或引号。',
            ),
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
        // 全部尝试失败(空 content / 调用失败 / 垃圾输出):本地确定性
        // 兜底——取首条用户消息作标题。LLM 偶尔全挂(高峰超时/API 波动),
        // 空标题 = 文字区永远显示回复开头,观感等同"没有总结"
        return fallbackTitle(messages)
      } catch {
        return fallbackTitle(messages)
      }
    },
    async judgeProactive(messages: AgentMessage[], idleMinutes: number) {
      const config = deps.getConfig()
      if (!config.apiKey.trim() || messages.length === 0) return { should: false }
      try {
        const recent = recentMessages(messages)
        // 与主引擎同源上下文(自定义提示词 + 记忆块 + 进化状态 + 后台
        // 状态)+ 当前时间——判断需要知道助手"是谁、记得什么、在忙什么、
        // 现在几点"。块缺失/读取失败静默跳过,不杀判断
        let memoryBlock = ''
        try {
          const entries = (await deps.getMemoryStore?.()?.list()) ?? []
          memoryBlock = formatMemoryBlock(entries)
        } catch {
          // 记忆读取失败:省略记忆块,继续判断
        }
        let evolutionStatus = ''
        try {
          evolutionStatus = (await deps.getEvolution?.()?.getStatus()) ?? ''
        } catch {
          // 进化状态读取失败:省略
        }
        const bgStatus = getTasksStatusBlock()
        const now = new Date()
        const nowText =
          `当前时间:${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ` +
          `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        const system = buildJudgeSystem(
          [config.systemPrompt, memoryBlock, evolutionStatus, bgStatus, nowText],
          idleMinutes,
        )
        // 单措辞 + 一次重试;60s 超时,noThinking 低强度——判断是廉价决策,
        // 失败按 should:false 处理(不主动打扰是安全侧,一次都不打扰用户)
        for (let retry = 0; retry < 2; retry++) {
          try {
            const result = await streamByConfig({
              config: { ...config, reasoningEffort: 'low' },
              system,
              history: recent,
              tools: [],
              signal: AbortSignal.timeout(60000),
              onEvent: () => {},
              jsonMode: true,
              noThinking: true,
            })
            const verdict = parseJudgeJson(result.text)
            if (verdict) return verdict
            // 空 content / 垃圾输出(json_mode 已知问题):重试一次
          } catch {
            if (retry === 0) continue
            break
          }
        }
        return { should: false }
      } catch {
        return { should: false }
      }
    },
  }
}

/**
 * 心理揣测系统提示:单轮无工具,直接输出 ≤16 汉字俏皮话(推荐 10 字左右,
 * 2026-08-07 放宽:用户要求 15 字左右、最多 16 字)。
 * **措辞强化(2026-08-07 用户要求"一轮过不返工")**:明确"必须严格控制在
 * 16 个汉字以内 + 输出前先数一遍字数,超过就删减"——原措辞"最多不超过"
 * 模型常不遵守,输出 17-20 字被截断显示残片(实测"知道了喵～人家刚才在
 * 装乖,其实已"每次都截断);示例仅示风格(照抄命中 MIND_LITERAL_EXAMPLES 判无效)
 */
const MIND_SYSTEM_PROMPT =
  '你是灵动岛的「心理揣测师」。根据最近对话,揣测 AI 助手回复用户时的心态,' +
  '用一句俏皮话描述,推荐 10 个字左右、**必须严格控制在 16 个汉字以内**——' +
  '输出前先数一遍字数,超过就删减到 16 字以内,要幽默、拟人、有画面感' +
  '(如「表面淡定,内心在慌」)。直接输出这句话,不要引号、不要前缀、不要解释,也不要照抄示例。'

/** 心理揣测码元上限(2026-08-07 放宽:15 字左右,最多 16;紧凑态文字区
 * 随字数扩展岛宽,超出会截断——展示前自查超长则重新组织,直到不截断,
 * 上限 MIND_MAX_RETRIES 次防死循环) */
const MIND_MAX_LEN = 16

/** 超长自查重试上限(2026-08-07 用户要求:截断则重新组织直到不截断;
 * 措辞已强化一轮过,5 次是防 LLM 持续不守约束的死循环兜底) */
const MIND_MAX_RETRIES = 5

/** 模型可能照抄的示例词(照抄 = 无效,重试) */
const MIND_LITERAL_EXAMPLES = new Set(['表面淡定,内心在慌', '表面淡定内心在慌'])

/**
 * 心理揣测清洗(测试用导出):去引号/「心理揣测:」前缀/尾随标点、
 * **剥离任意位置的 [揣测：xxx] / 【揣测：xxx】 括号标注**(2026-08-07
 * 实测:模型输出"喵～我已经瞄到主人了哦[揣测：表情…]"——标注在中段,
 * 原只剥开头前缀,截 16 码元后残留"[揣测：表",用户要求去掉"["与
 * "揣测："残片;闭合缺失也剥(截断输入安全侧)),
 * 按码元截 16(2026-08-07 放宽:用户要求"15 字左右,最多 16 字"——
 * 紧凑态文字区随字数扩展岛宽,不再像素截断;渲染端兜底同值)
 */
export function sanitizeMind(raw: string): string {
  const text = raw
    .trim()
    .replace(/^[「『"'《<]+|[」』"'》>]+$/g, '')
    .replace(/^(?:心理揣测|揣测|心态)\s*[:：]?\s*/, '')
    .replace(/[[【]\s*(?:心理揣测|揣测|心态)\s*[:：]?[^\]】]*[\]】]?/g, '')
    .replace(/[。！？!?…]+$/, '')
    .trim()
  return Array.from(text).slice(0, 16).join('')
}

/**
 * 心理揣测系统提示拼装(测试用导出):**与主对话引擎同源上下文**——
 * 自定义提示词 + 长期记忆块 + 进化状态 + 后台任务状态,再接揣测指令。
 * 揣测必须知道助手"是谁、记得什么、在忙什么",否则心理是猜的空气
 * (用户提示词要求冷淡,猜"热情洋溢"就串味;记忆说讨厌重复,猜
 * "偷懒复读"才对味)。空块/未注入静默跳过
 */
export function buildMindSystem(context: string[]): string {
  const blocks = [context.filter(Boolean).join('\n\n'), MIND_SYSTEM_PROMPT]
  return blocks.filter(Boolean).join('\n\n')
}

/**
 * 独立的心理揣测后台 Sub Agent:与主对话引擎、总结标题 Agent 均零共享。
 * 根据当前对话,揣测 LLM 回复时的心态,输出 ≤15 汉字俏皮话
 * (推荐 10 字左右,如「表面淡定,内心在慌」),显示在灵动岛紧凑态文字区——替代直接
 * 显示对话标题,文字区更有"人味"。失败/超时返回空串,由调用方回退
 * (标题 → 回复预览)。与 createSummaryAgent 同构:独立实例、独立
 * AbortController、事件静默、单轮完成
 */
export function createMindAgent(deps: {
  getConfig: () => AgentConfig
  /** 长期记忆(与主引擎同源:记忆块进系统提示,揣测才知道助手记得什么) */
  getMemoryStore?(): MemoryStoreLike | null
  /** 自我进化 harness(状态块进系统提示;未注入则省略) */
  getEvolution?(): EvolutionLike | null
}): {
  /** 静默揣测(无工具单轮,事件不转发 UI);失败/未配置返回空串 */
  guess(messages: AgentMessage[]): Promise<string>
} {
  return {
    async guess(messages: AgentMessage[]) {
      const config = deps.getConfig()
      if (!config.apiKey.trim() || messages.length === 0) return ''
      try {
        const recent = recentMessages(messages)
        // 与主对话引擎同源的上下文(自定义提示词 + 长期记忆块 + 进化
        // 状态 + 后台任务状态)——揣测必须知道助手"是谁、记得什么、在忙
        // 什么",否则心理是猜的空气。块缺失/读取失败静默跳过,不杀揣测
        let memoryBlock = ''
        try {
          const entries = (await deps.getMemoryStore?.()?.list()) ?? []
          memoryBlock = formatMemoryBlock(entries)
        } catch {
          // 记忆读取失败:省略记忆块,继续揣测
        }
        let evolutionStatus = ''
        try {
          evolutionStatus = (await deps.getEvolution?.()?.getStatus()) ?? ''
        } catch {
          // 进化状态读取失败:省略
        }
        const bgStatus = getTasksStatusBlock()
        // Sub Agent 设置(2026-08-07):心理揣测人格(预设 id 或自定义 ≤100 字)
        // 拼进同源上下文,块为空时 buildMindSystem 静默跳过
        const personaBlock = resolveSubAgentStyle('mind', config.mindPersona)
        const system = buildMindSystem([
          config.systemPrompt,
          memoryBlock,
          evolutionStatus,
          bgStatus,
          personaBlock,
        ])
        // 单措辞 + 重试:心理揣测是增强显示,失败由调用方回退
        // (标题/回复预览),不值得总结标题的三级降级链;
        // 60s 超时(短输出任务,低于总结的 90s),noThinking 提速。
        // **超长自查重试直到不截断**(2026-08-07 用户要求):生成结果超
        // 16 码元 = 文字区截断残片(实测"知道了喵～…其实已"每次都截断),
        // 重新组织更短的,上限 MIND_MAX_RETRIES 次;空/垃圾(代码字面量)/
        // 照抄示例同样重试;全部失败返回空串(调用方回退,不显示残片)
        for (let retry = 0; retry < MIND_MAX_RETRIES; retry++) {
          try {
            const result = await streamByConfig({
              config,
              system,
              history: recent,
              tools: [],
              signal: AbortSignal.timeout(60000),
              onEvent: () => {},
              noThinking: true,
            })
            const raw = result.text.trim()
            const guess = sanitizeMind(raw)
            const tooLong = Array.from(raw).length > MIND_MAX_LEN
            if (guess && !looksLikeCodeLiteral(guess) && !MIND_LITERAL_EXAMPLES.has(guess) && !tooLong) {
              return guess
            }
            // 超长/空/垃圾:重试(重新组织)
          } catch {
            if (retry < MIND_MAX_RETRIES - 1) continue
            break
          }
        }
        return ''
      } catch {
        return ''
      }
    },
  }
}

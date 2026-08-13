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
import type { AgentConfig, AgentMessage, AgentPart, EvolutionLike, MemoryEntry, MemoryStoreLike } from './types'

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
    // 剥对话回应词前缀(2026-08-12,措辞兜底:模型不守规矩时把回复
    // 原句当标题,实测"是的,exec_command 默认有执行确认门"——剥掉
    // "是的," 后至少不再以回应词开头)
    .replace(/^(?:是的|好的|可以的|没问题|嗯|对|可以|行|好|有的)[,，:：、\s]*/, '')
    // 句子式兜底(2026-08-12 二轮):含中文逗号的标题 = 摘抄/续写的
    // 对话原句(短语标题不会用逗号,实测"开心的事倒是有,中午食堂的
    // 土豆牛肉特别好"整句被 20 码元截断)——取首个逗号前的前半短语,
    // 宁可短短语,不要"整句截断"的观感
    .replace(/[,，].*$/, '')
    .replace(/[。！？!?…]+$/, '')
    // 剥开头终止标点(2026-08-12 三轮:回应词剥离后残留"。xxx"残串,
    // 实测"好。下面开始正式内容"→ 剥"好"后以"。"开头)
    .replace(/^[。！？!?…～~]+/, '')
    .trim()
  // 终止标点截断(2026-08-12 三轮,历史标题修复实测:兜底标题取自首条
  // 用户消息,长句无逗号时 20 码元硬截 = 残句观感,如"哈喽主人～看我
  // 干啥呀?我刚才一直陪你看视")——取第一个终止标点(。！？…～~)前的
  // 完整段,结果 ≥4 码元才采用(过短如"好。"不切,保持原样交给 20 截断)
  const seg = text.split(/[。！？!?…～~]/)[0].trim()
  return Array.from(seg.length >= 4 ? seg : text).slice(0, 20).join('')
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
    // 跳过过短消息(2026-08-12 三轮,历史标题修复实测:首条用户消息
    // 是"你?"这类短句时 fallback 得到单字"你"的垃圾标题)——取第一条
    // ≥4 码元的实质内容,如"我要听二哥王力宏的需要你陪"
    if (text.trim() && Array.from(text).length >= 4) return sanitizeTitle(text)
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
      // 长文本截断(2026-08-12 实机修复:助手回复常 300+ 字长段,模型
      // 看多长的回复就模仿写多长的揣测——标签只需"最近在聊什么",
      // 截 200 字足够语义,过长是揣测输出超长的诱因之一)
      if (p.type === 'text' && p.text.length > 200) return { ...p, text: p.text.slice(0, 200) + '…' }
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
 * 句子式标题判定(2026-08-12,测试用导出):模型把回复原句/续写内容当
 * 标题(实测「公司楼下新开了一家火锅店」「开心的事倒是有,中午食堂的
 * 土豆牛肉特别好」「文言文里有没有轻松好玩的句子」)——名词短语标题
 * 几乎不含完成体"了"、不以"X的"结尾、不带疑问词(吗/呢/有没有…)
 * (短标题如「我的」不计);命中 = 判无效进入下一级/兜底,防止整句
 * 被 20 码元截断的观感
 */
export function looksLikeSentenceTitle(title: string): boolean {
  const t = title.trim()
  if (!t) return false
  if (Array.from(t).length <= 6) return false
  // 疑问词补全(2026-08-12 实测漏网:"哈喽主人～看我干啥呀?我刚才一直
  // 陪你看视"含"干啥"却判不坏,20 码元截断残句)——加口语疑问词
  return (
    /了/.test(t) ||
    /.+的$/.test(t) ||
    /(吗|呢|有没有|能不能|怎么|怎样|如何|为什么|啥|干嘛|干啥|谁|哪里|哪儿|是不是|会不会|要不要|好不好)/.test(t)
  )
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
  '(如用户抱怨过字太小/背景看不清/主题色不喜欢);③ 用户表现出需要关心/陪伴;' +
  '④ **群里已经安静很久且助手也好久没在群里说过话(见【群聊状态】块)时,' +
  '偶尔冒个泡活跃气氛也适合**(2026-08-13 用户要求"群聊里没人说话也偶尔冒个泡")——' +
  'hint 写明「用 send_group 在群里发一条…」(轻松、短、自然,贴合群内氛围与话题,' +
  '不要频繁,只有当群与助手都安静超过陪伴间隔时才考虑)。' +
  '不适合:对话刚自然结束、用户明确表示不想被打扰、没有值得跟进或动手的内容、' +
  '上下文太短无法判断、群里刚有活跃对话或助手刚发过言。' +
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
 * 记忆提取 JSON 解析(测试用导出):必须解析出合法 {memories: [...]} 数组,
 * 逐条校验(只收 content/type,非法条目丢弃),单次最多 10 条;解析失败/
 * 垃圾输出返回空数组(安全侧:不污染记忆)
 */
export function parseMemoriesJson(
  raw: string,
): { content: string; type: MemoryEntry['type'] }[] {
  const obj = extractJsonObject(raw)
  if (!obj || !Array.isArray(obj.memories)) return []
  const out: { content: string; type: MemoryEntry['type'] }[] = []
  for (const m of obj.memories) {
    if (!m || typeof m !== 'object') continue
    const item = m as Record<string, unknown>
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, 200) : ''
    const type = item.type
    if (!content) continue
    out.push({
      content,
      type: type === 'preference' || type === 'workflow' || type === 'lesson' ? type : 'fact',
    })
  }
  return out.slice(0, 10)
}

/** 用户风格 JSON 解析(测试用导出):解析出合法 {style: string} 才采信,
 * 空/垃圾输出返回 ''(调用方不注入风格指令,安全侧) */
export function parseStyleJson(raw: string): string {
  const obj = extractJsonObject(raw)
  if (!obj) return ''
  return typeof obj.style === 'string' ? obj.style.trim().slice(0, 120) : ''
}

/** 记忆提取系统提示(2026-08-10 用户要求"总结 Sub Agent 自动从对话提取
 * 值得记住的内容入长期记忆,静默,仅主动陪伴开启时"):适合沉淀的类别
 * 明确列举(preference/fact/workflow/lesson),不适合的类别也列举(一次性
 * 细节/临时状态/已有记忆),避免把对话噪声写进长期记忆 */
const MEMORY_EXTRACT_PROMPT = (memoryBlock: string) =>
  '你是灵动岛的「记忆沉淀师」。从对话中提取**值得长期记住**的信息,写入助手的长期记忆。' +
  '适合沉淀:① 用户偏好(喜欢的风格/称呼/习惯/雷点);② 稳定事实(用户身份/环境/常用工具/平台);' +
  '③ 工作流(用户常做的操作流程、工具组合);④ 教训(踩过的坑、用户纠正过的事,未来不再犯);' +
  '⑤ **对话中出现的人物/联系人信息**(2026-08-12,QQ 群聊/私聊里别人的称呼、身份、喜好、' +
  '与主人的关系——如"QQ 群友阿白,喜欢猫,群里叫他鲸鱼娘的主人"——记入长期记忆,' +
  '类型用 fact)。' +
  '**对话中【】包裹的内容是系统指令/来源标注(如【群聊消息(QQ 123)】),不是对话内容,忽略**。' +
  '不适合:一次性请求的细节、本次对话的临时状态、与现有记忆重复的内容。' +
  (memoryBlock ? `现有记忆(不要重复,只提取新增):\n${memoryBlock}` : '') +
  '每条 content 不超过 200 字,独立可理解(不依赖对话上下文)。' +
  '只输出 JSON 对象:{"memories": [{"content": "<记忆内容>", "type": "preference|fact|workflow|lesson"}]}。' +
  '没有值得记的输出 {"memories": []}。不要解释,不要照抄示例文字。'

/** 记忆提取系统提示拼装(测试用导出):与主引擎同源上下文(自定义提示词 +
 * 现有记忆块)——提取必须知道助手已记得什么,否则重复沉淀;块为空静默跳过 */
export function buildMemoryExtractSystem(context: string[]): string {
  const memoryBlock = context[1] ?? ''
  const blocks = [context.filter(Boolean).join('\n\n'), MEMORY_EXTRACT_PROMPT(memoryBlock)]
  return blocks.filter(Boolean).join('\n\n')
}

/** 用户风格分析系统提示(2026-08-10 用户要求"主动回复有时模仿用户嘴癖"):
 * 只描述可模仿的表达特征(口头禅/语气词/句式/标点/称呼/emoji),不评价
 * 内容;无明显风格或语境不适合(正式/严肃)时输出空 style——"有时"由
 * 调用方措辞引导,分析本身只做客观描述 */
const USER_STYLE_PROMPT =
  '你是灵动岛的「风格观察师」。分析用户在这段对话中的**说话风格与习惯**:' +
  '口头禅/语气词、句式长短、标点与表情习惯、对助手的称呼、emoji 使用等,' +
  '输出简短的可模仿特征描述(不超过 120 字,只描述表达方式,不要评价对话内容)。' +
  '如果用户没有明显个人风格,或对话语境严肃正式不适合模仿,输出 {"style": ""}。' +
  '只输出 JSON 对象:{"style": "<风格描述>"}。不要解释。'

/** 用户风格分析系统提示拼装(测试用导出):接自定义提示词(助手"是谁"),
 * 分析只依赖对话文本本身 */
export function buildUserStyleSystem(context: string[]): string {
  const blocks = [context.filter(Boolean).join('\n\n'), USER_STYLE_PROMPT]
  return blocks.filter(Boolean).join('\n\n')
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
  /** 群聊状态块(2026-08-13 群聊冒泡:群安静时长/助手上次群发言/
   * 最近群消息——进判断上下文,判断才知道"群该不该冒个泡";未注入省略) */
  getGroupStatus?(): Promise<string>
}): {
  /** 静默总结对话标题(无工具单轮,事件不转发 UI);失败/未配置返回空串 */
  summarize(messages: AgentMessage[]): Promise<string>
  /**
   * 主动陪伴判断(2026-08-07):用户无操作满 idleMinutes 分钟时,根据当前
   * 语境判断是否需要主动开口。失败/未配置返回 {should:false}(安全侧,
   * 零 LLM 调用);should:true 时 hint 为建议话题(≤200 字)
   */
  judgeProactive(messages: AgentMessage[], idleMinutes: number): Promise<{ should: boolean; hint?: string }>
  /**
   * 静默记忆提取(2026-08-10 用户要求"自动根据对话全上下文提取值得记住
   * 的内容入长期记忆,静默,仅主动陪伴开启时"):从对话中提取偏好/事实/
   * 工作流/教训,JSON 输出 {memories:[...]}。输入为**完整历史**(记忆
   * 提取需要全文语境,与总结的"最近 12 条"不同);失败/未配置返回 []
   * (安全侧,零 LLM 调用,绝不外溢)
   */
  extractMemories(messages: AgentMessage[]): Promise<{ content: string; type: MemoryEntry['type'] }[]>
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
        // 空白、含工具历史时尤甚):**2026-08-13 精简重构**——原三级降级
        // 链(JSON 措辞 A/B → 纯文本)把大量措辞经验分散在三份近似
        // 提示词里,每份还各重试一次(最多 6 次调用);实测 Responses
        // 路径的 json_object 空返回率远低,二级链足够:① JSON 主措辞
        // (全部措辞经验合成一份)② 纯文本兜底(无 response_format,
        // 历史上可靠,sanitizeTitle 清洗)。判效链(严格解析/示例词/
        // 代码字面量/句子式/超长/过短)全部保留——本地确定性判定,
        // 零 LLM 成本,是成功率的主要来源
        const attempts = [
          {
            jsonMode: true,
            system: withStyle(
              '你是对话标题生成器。title = 对话主题的名词短语。' +
                '要求:推荐 10 字左右,**严格不超过 20 字**;' +
                '是短语不是句子——不以「是的/好的/可以/没问题/用户/我」开头,' +
                '不引用或改写对话原句(尤其最后一条消息);' +
                '不用「指南/介绍/讨论/分析/了解/询问/关于/如何」等套话;' +
                '纯闲聊/情感对话 = 场景或情绪短语(如「深夜加班闲聊」),不续写对话内容。' +
                '只输出 JSON 对象 {"title": "..."},不要解释。',
            ),
          },
          {
            jsonMode: false,
            system: withStyle(
              '你是对话标题生成器。输出一个主题名词短语作标题,如「字体导入」「深夜加班闲聊」。' +
                '要求:推荐 10 字左右、严格不超过 20 字;短语不是句子(不以回应词开头、不摘抄对话原句);' +
                '不用「指南/讨论/如何/关于」等套话;闲聊 = 场景/情绪短语,不续写。' +
                '直接返回标题文本,不要引号、标点或解释。',
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
              // 超长判废(2026-08-12 二轮,用户实测"历史记录标题还是
              // 有问题"——"哈喽主人～看我干啥呀?我刚才一直陪你看视"
              // 20 码元截断残句):模型输出长句被 sanitizeTitle 截 20 码元
              // = 截断观感,判废进下一级措辞,直到模型输出 ≤20 的短语
              const truncated = Array.from(parsed ?? '').length > 20
              // 过短判废(2026-08-12 三轮,实测引擎对历史会话输出单字
              // "你"——1 码元垃圾通过全部判效):标题 <2 码元 = 垃圾
              const tooShort = Array.from(title).length < 2
              // 命中 prompt 示例词(模型照抄示例)/ 代码字面量垃圾
              // (如 ['data'])/ 句子式标题(摘抄回复原句)/ 超长截断/
              // 过短垃圾视为无效,进入下一级
              if (
                title &&
                !tooShort &&
                !truncated &&
                !TITLE_LITERAL_EXAMPLES.has(title) &&
                !looksLikeCodeLiteral(title) &&
                !looksLikeSentenceTitle(title)
              ) {
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
        // 群聊状态(2026-08-13 群聊冒泡:群安静时长/助手上次群发言进判断
        // 上下文);读取失败静默省略(不影响窗口向主动陪伴)
        let groupStatus = ''
        try {
          groupStatus = (await deps.getGroupStatus?.()) ?? ''
        } catch {
          // 群状态读取失败:省略
        }
        const now = new Date()
        const nowText =
          `当前时间:${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ` +
          `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        const system = buildJudgeSystem(
          [config.systemPrompt, memoryBlock, evolutionStatus, bgStatus, groupStatus, nowText],
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
    async extractMemories(messages: AgentMessage[]) {
      const config = deps.getConfig()
      if (!config.apiKey.trim() || messages.length === 0) return []
      try {
        // 输入:完整历史(最多 40 条),reasoning/工具结果/工具参数压缩
        // ——记忆提取需要全文语境,但细节(长思维链/大参数)无用
        const history = messages
          .slice(-40)
          .map((m) => ({
            ...m,
            parts: m.parts.map((p) => {
              if (p.type === 'reasoning') return { ...p, text: p.text.slice(0, 500) }
              if (p.type === 'tool-result') return { ...p, result: p.result.slice(0, 800) }
              if (p.type === 'tool-call') return { ...p, args: compressArgs(p.args) as Record<string, unknown> }
              return p
            }),
          }))
        // 与主引擎同源上下文:自定义提示词 + **现有记忆块**(提取必须知道
        // 已记得什么,否则重复沉淀)。块读取失败静默跳过,不杀提取
        let memoryBlock = ''
        try {
          const entries = (await deps.getMemoryStore?.()?.list()) ?? []
          memoryBlock = formatMemoryBlock(entries)
        } catch {
          // 记忆读取失败:省略记忆块,继续提取
        }
        const system = buildMemoryExtractSystem([config.systemPrompt, memoryBlock])
        // 单措辞 + 一次重试;60s 超时,noThinking 低强度——静默后台任务,
        // 失败返回 [] 不打扰(不写错记忆是安全侧)
        for (let retry = 0; retry < 2; retry++) {
          try {
            const result = await streamByConfig({
              config: { ...config, reasoningEffort: 'low' },
              system,
              history,
              tools: [],
              signal: AbortSignal.timeout(60000),
              onEvent: () => {},
              jsonMode: true,
              noThinking: true,
            })
            const memories = parseMemoriesJson(result.text)
            if (memories.length > 0) return memories
            // 空数组/垃圾输出:重试一次
          } catch {
            if (retry === 0) continue
            break
          }
        }
        return []
      } catch {
        return []
      }
    },
  }
}

/**
 * 心理揣测系统提示(2026-08-13 精简重构):历次措辞经验(预演回复判废/
 * 旁观者视角/16 字硬约束/完整句收尾/示例照抄判废)压缩成四条规则——
 * 原长段"不要…不要…"叙述被精简为结构化编号,约束信息不丢、可读性
 * 提升;判效与重试机制(反馈注入/语义截取/人格回退)不变
 */
const MIND_SYSTEM_PROMPT =
  '你是灵动岛的「心理揣测师」。写 AI 助手此刻心里的内心 OS(第一人称心里话,如「嘴上客气,心里在偷乐」),要幽默、有画面感。' +
  '规则:① 是它心里的想法,**不是给用户的回复**——不复述、不预演对话内容;' +
  '② 旁观者视角,不模仿助手自己的口吻/自称(如「主人/鲸鱼」);' +
  '③ **严格 ≤16 汉字,且必须是说完的完整一句**——宁可 8 字说完整,不要 16 字说一半,不要以逗号、连词收尾;' +
  '④ 直接输出这句话,不要引号、前缀、解释,不要照抄示例。'

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
 * 超长 raw 的语义截取(2026-08-12 实机修复,测试用导出):模型输出超
 * 16 码元时通常是「完整小句 + 续写」的结构(实机样本"好,李文亚教授
 * 是吧!刚才那列表里正好看到…我直接给你抓下来播放 🐳"、"主人这是
 * 又陷进旋律里了吧～那我不吵你…")——取**第一个句子终止标点
 * (。！？；…～)前**的完整小句,语义完整、无截断观感。
 * 结果 4-16 码元且非残句结尾才采用;否则返回 null(判废进重试)。
 * 与 sanitizeMind 的硬截 16 区别:本函数按语义边界截,不切半句
 */
export function cutMindSentence(raw: string): string | null {
  // 终止标点:全角(。！？；…～)+ 半角(!.?)(实机模型常输出半角感叹号)
  const m = /^[\s\S]{0,30}?[。！？；…～!?.]/.exec(raw)
  if (!m) return null
  const head = m[0].slice(0, -1).trim()
  const len = Array.from(head).length
  if (len < 4 || len > MIND_MAX_LEN) return null
  if (looksLikeIncompleteMind(head)) return null
  return head
}

/**
 * 超长且无句末标点的 raw 二级兜底截取(2026-08-14 实机修复,测试用导出):
 * 人格风格(粤语/猫娘等)持续输出逗号串长句、全程无句末标点(实机样本
 * "收到,以后我答嘢快狠准,唔会再长篇大论")——cutMindSentence 无从截取,
 * 盲重试 5 次同风格同病,耗尽返回空。取 **≤16 码元范围内、以逗号/顿号
 * 收尾的最长前缀小句**(实机样本 → "收到,以后我答嘢快狠准"),首段小句
 * 语义完整、无截断观感;4-16 码元且非残句才采用,否则返回 null 判废重试
 */
export function salvageMindClause(raw: string): string | null {
  const chars = Array.from(raw)
  let best: string | null = null
  // 逐码元扫描前 16 码元内的逗号/顿号,保留最后一个(= 最长)合规前缀小句
  for (let i = 0; i < Math.min(chars.length, MIND_MAX_LEN); i++) {
    if (/[,，、]/.test(chars[i])) {
      const head = chars.slice(0, i).join('').trim()
      if (Array.from(head).length >= 4) best = head
    }
  }
  if (!best) return null
  if (looksLikeIncompleteMind(best)) return null
  return best
}

/**
 * 心理揣测残句判定(2026-08-12,测试用导出):以逗号/顿号/冒号等未完成
 * 标点结尾、或收在连词上(你那/就是/因为/但是/然后/所以/还有…) =
 * 句子没说完——模型把 16 字配额用满但话只说一半(实测"收到,以后给你
 * 最精简的干货。你那"16 码元整却以"你那"收尾);过短(<4 码元,如
 * "哈哈,")同样判废。命中 = 判无效重试,防止"16 码元整却半句"的截断观感
 */
export function looksLikeIncompleteMind(guess: string): boolean {
  const t = guess.trim()
  if (!t) return true
  if (Array.from(t).length < 4) return true
  return /[,，、;；:：]$/.test(t) || /(你那|就是|因为|但是|然后|所以|还有|这边|之后|接着|反正)$/.test(t)
}

/**
 * 心理揣测清洗(测试用导出):去引号/首尾括号/「心理揣测:」前缀/尾随标点、
 * **剥离任意位置的 [揣测：xxx] / 【揣测：xxx】 括号标注**(2026-08-07
 * 实测:模型输出"喵～我已经瞄到主人了哦[揣测：表情…]"——标注在中段,
 * 原只剥开头前缀,截 16 码元后残留"[揣测：表",用户要求去掉"["与
 * "揣测："残片;闭合缺失也剥(截断输入安全侧)),
 * 按码元截 16(2026-08-07 放宽:用户要求"15 字左右,最多 16 字"——
 * 紧凑态文字区随字数扩展岛宽,不再像素截断;渲染端兜底同值)。
 * 首尾括号含 2026-08-14 实机样本"（这下总该明白了吧"——开头全角左括号
 * 无闭合,原字符类不含括号直接透传显示
 */
export function sanitizeMind(raw: string): string {
  const text = raw
    .trim()
    .replace(/^[「『"'《<（(【[]+|[」』"'》>）)】\]]+$/g, '')
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
  /**
   * 用户风格分析(2026-08-10 用户要求"主动回复有时模仿用户嘴癖"):
   * 从对话中提炼用户可模仿的说话风格特征(口头禅/句式/称呼/emoji 等),
   * 供主动回复的 hint 内部指令注入。无明显风格/语境不适合返回 ''(安全侧,
   * 零 LLM 调用);失败同样返回 ''
   */
  analyzeUserStyle(messages: AgentMessage[]): Promise<string>
} {
  return {
    async guess(messages: AgentMessage[]) {
      const config = deps.getConfig()
      if (!config.apiKey.trim() || messages.length === 0) return ''
      try {
        // 输入特化:心理揣测只需要文本语义,剥离工具调用/结果 parts——
        // ① 工具语法噪音干扰揣测(心态在文本里,不在参数里);
        // ② 模型看到历史里的 <tool_calls>/<invoke> 格式会**模仿输出**
        // 工具调用幻觉(2026-08-12 实测诊断:重试时大量 raw 是
        // "<tool_calls><invoke name=…>",清洗后乱码残片全废)
        const recent = recentMessages(messages).map((m) => ({
          ...m,
          parts: m.parts.filter((p) => p.type === 'text' || p.type === 'reasoning'),
        }))
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
        // 人格风格与 16 字硬约束冲突时,持续重试只会持续失败(实测粤语/
        // 猫娘风格偶发连续 5 次超长/残句耗尽返回空)——重试 3 次后**退回
        // 无人格版本**(2026-08-12):先保证有正常揣测输出(无风格但有内容),
        // 好过空揣测让文字区回退标题
        const personaSystem = buildMindSystem([
          config.systemPrompt,
          memoryBlock,
          evolutionStatus,
          bgStatus,
          personaBlock,
        ])
        const baseSystem = buildMindSystem([
          config.systemPrompt,
          memoryBlock,
          evolutionStatus,
          bgStatus,
        ])
        // 单措辞 + 重试:心理揣测是增强显示,失败由调用方回退
        // (标题/回复预览),不值得总结标题的三级降级链;
        // 60s 超时(短输出任务,低于总结的 90s),noThinking 提速。
        // **超长自查重试直到不截断**(2026-08-07 用户要求):生成结果超
        // 16 码元 = 文字区截断残片(实测"知道了喵～…其实已"每次都截断),
        // 重新组织更短的,上限 MIND_MAX_RETRIES 次;空/垃圾(代码字面量)/
        // 照抄示例/残句同样重试;全部失败返回空串(调用方回退,不显示残片)。
        // **重试反馈注入(2026-08-12)**:盲重试对模型固有模式无效(人格
        // 风格下模型持续输出超长,实测 tender 连续 5 次超长耗尽返回空;
        // 粤语风格输出 19-20 码元语义完整句,差 3 个字)——重试时把**上次
        // 输出原文**给模型,让它精确删减(比"写短点"有效,模型看到自己的
        // 句子会删到 16 字内保留核心意思)
        let lastRaw = ''
        // **次优揣测兜底(2026-08-14)**:语义有效但细节判废(残句收尾/照抄
        // 示例)的结果留档,重试耗尽后优先回退它——空串让文字区退回标题,
        // 观感比略带瑕疵的内心独白更差
        let bestGuess = ''
        // **精确判废原因(2026-08-14)**:注入重试反馈——笼统措辞"超过 16 字
        // 或句子没说完"实测无效(模型持续重复同一错误模式,5 次全废)
        let lastReason = ''
        for (let retry = 0; retry < MIND_MAX_RETRIES; retry++) {
          try {
            // 重试 3 次仍失败 → 去掉人格块(风格与长度约束持续冲突,
            // 先保证有输出;反馈注入照常)
            const currentSystem = retry >= 3 ? baseSystem : personaSystem
            const result = await streamByConfig({
              config,
              system:
                retry === 0
                  ? currentSystem
                  : currentSystem +
                    `\n(你上次的输出「${lastRaw.slice(0, 60)}」不合格——${lastReason || '超过 16 字或句子没说完'}。` +
                    '请重新写一句:**严格 ≤16 汉字、说完的完整一句**,不要逗号/连词收尾、不要照抄示例)',
              history: recent,
              tools: [],
              signal: AbortSignal.timeout(60000),
              onEvent: () => {},
              noThinking: true,
            })
            const raw = result.text.trim()
            lastRaw = raw
            // 超长时先语义截取(取第一个句末标点前的完整小句,实机
            // 2026-08-12:模型超长输出 = 完整小句+续写,第一小句直接可用,
            // 省掉重试);无句末标点(逗号串长句)再走逗号小句兜底截取
            // (2026-08-14);都截取失败判废进重试
            const tooLong = Array.from(raw).length > MIND_MAX_LEN
            const guess = tooLong
              ? sanitizeMind(cutMindSentence(raw) ?? salvageMindClause(raw) ?? '')
              : sanitizeMind(raw)
            // 工具调用幻觉(2026-08-12 实测诊断):失败重试时模型可能输出
            // "<tool_calls>/<invoke>" 工具调用语法,清洗后是乱码残片——
            // 直接判废,不进入判效链
            const toolCallHalluc = /<[\s\S]{0,200}(?:tool_calls|invoke|command)[\s\S]{0,60}>/i.test(raw)
            // 判效:空/垃圾/照抄示例/残句都重试(重新组织);tooLong 时
            // guess 已是语义截取结果(≤16 或空),不再单列超长条件。
            // 判废同时记录精确原因供下轮反馈注入;语义有效但细节不合格的
            // 留档次优兜底(首个,重试耗尽后优先回退)
            if (guess && !toolCallHalluc && !looksLikeCodeLiteral(guess)) {
              if (MIND_LITERAL_EXAMPLES.has(guess)) {
                lastReason = '照抄了示例原句,要写全新的'
                bestGuess = bestGuess || guess
              } else if (looksLikeIncompleteMind(guess)) {
                lastReason = '句子没说完(以逗号/连词收尾)'
                bestGuess = bestGuess || guess
              } else {
                return guess
              }
            } else if (!guess) {
              lastReason = tooLong ? '超过 16 字且截取不出完整小句' : '输出为空'
            } else {
              lastReason = '输出是工具调用语法或代码字面量,不是内心独白'
            }
            // 超长/空/垃圾/残句/工具调用幻觉:重试(重新组织)。**不在
            // 循环内打日志**(2026-08-12 用户实测反馈:每次重试都打
            // console.warn 刷屏,观感像功能坏了)——只在全部重试耗尽后
            // 打一条摘要,便于诊断且不打扰
          } catch {
            if (retry < MIND_MAX_RETRIES - 1) continue
            break
          }
        }
        if (bestGuess) {
          console.warn(
            `[mind-guess] 重试 ${MIND_MAX_RETRIES} 次均不合格(${lastReason}),回退次优揣测:${JSON.stringify(bestGuess)}`,
          )
          return bestGuess
        }
        console.warn(
          `[mind-guess] 重试 ${MIND_MAX_RETRIES} 次均不合格,返回空(文字区回退标题;原因=${lastReason};lastRaw=${JSON.stringify(
            lastRaw.slice(0, 60),
          )})`,
        )
        return ''
      } catch {
        return ''
      }
    },
    async analyzeUserStyle(messages: AgentMessage[]) {
      const config = deps.getConfig()
      if (!config.apiKey.trim() || messages.length === 0) return ''
      try {
        const recent = recentMessages(messages)
        const system = buildUserStyleSystem([config.systemPrompt])
        // 单措辞 + 一次重试;60s 超时,noThinking——风格分析是廉价决策,
        // 失败返回 ''(不注入风格指令,主动回复照常,安全侧)
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
            const style = parseStyleJson(result.text)
            if (style) return style
            // 空 style/垃圾输出:重试一次
          } catch {
            if (retry === 0) continue
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

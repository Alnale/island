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

import { getDefaultLlmRuntime, type LlmStreamParams } from '../plugin/llm'
import { formatMemoryBlock } from '../memory'
import { getTasksStatusBlock } from '../tasks'
import type { ReplyIntent } from '../napcat/napcat-session'
import {
  buildClassifierSystem,
  buildJudgeSystem,
  buildMemoryExtractSystem,
  buildMindSystem,
  buildMonologueJudgeSystem,
  buildUserStyleSystem,
  compressArgs,
  cutMindSentence,
  extractJsonTitle,
  fallbackTitle,
  looksLikeCodeLiteral,
  looksLikeIncompleteMind,
  looksLikeSentenceTitle,
  MIND_LITERAL_EXAMPLES,
  MIND_MAX_LEN,
  MIND_MAX_RETRIES,
  parseClassifierJson,
  parseJudgeJson,
  parseMonologueJson,
  parseMemoriesJson,
  parseStyleJson,
  parseTitleJson,
  resolveSubAgentStyle,
  salvageMindClause,
  sanitizeMind,
  sanitizeTitle,
  TITLE_LITERAL_EXAMPLES,
} from './subagents-helpers'
import type { AgentConfig, AgentMessage, EvolutionLike, MemoryEntry, MemoryStoreLike, ProviderOutcome } from '../types'

// 纯辅助函数簇已拆至 subagents-helpers.ts(barrel 兼容 re-export,engine.ts 既有路径不变)
export * from './subagents-helpers'

/**
 * LLM 流式调用默认实现(经 LLM 接缝默认运行时,与兼容层 streamByConfig
 * 同源);两个工厂均支持经 deps.stream 注入替换(测试/定制装配用)
 */
const defaultStream = (params: LlmStreamParams): Promise<ProviderOutcome> =>
  getDefaultLlmRuntime().stream(params)


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
  /** LLM 流式调用(可注入;缺省经 LLM 接缝默认运行时) */
  stream?(params: LlmStreamParams): Promise<ProviderOutcome>
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
  const stream = deps.stream ?? defaultStream
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
              const result = await stream({
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
            const result = await stream({
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
            const result = await stream({
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
  /** LLM 流式调用(可注入;缺省经 LLM 接缝默认运行时) */
  stream?(params: LlmStreamParams): Promise<ProviderOutcome>
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
  const stream = deps.stream ?? defaultStream
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
            const result = await stream({
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
            const result = await stream({
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

/**
 * 独立的回复意图判定 Sub Agent(2026-08-16 兜底路由):QQ 机器人落定
 * 路由对**指纹缺失/歧义**的轮次调用它判定回复的发送意图(master/other/
 * hold)——主 Agent 边生成边记指纹服从性不稳定(用户实测:该发给主人的
 * 消息因忘带主人指纹没发出、发给别人的消息被发到主人 QQ),判定器只做
 * 单一分类任务,比主 Agent 可靠;失败/未配置返回 null,调用方回退原行为
 * (扣留或直发,不引入新的错误路径)。
 * 与 createSummaryAgent 同构:独立实例、事件静默、单轮完成、每次调用
 * 独立读取配置、低强度无思考加速(20s 超时——路由等待,不宜过长)
 */
export function createReplyClassifier(deps: {
  getConfig: () => AgentConfig
  /** LLM 流式调用(可注入;缺省经 LLM 接缝默认运行时) */
  stream?(params: LlmStreamParams): Promise<ProviderOutcome>
}): {
  /** 判定回复发送意图;失败/未配置/垃圾输出返回 null(调用方回退) */
  classify(input: {
    /** 回合类型标签(如「主人指示执行轮」「主人日常对话轮」) */
    kindLabel: string
    /** 回复对象标签(如「QQ 222」「群 1045765371」「主人 QQ」) */
    targetLabel: string
    /** 触发消息原文(判定关键:主人是否指示了发消息给别人) */
    trigger: string
    /** 助手落定回复文本 */
    reply: string
  }): Promise<{ intent: ReplyIntent; reason?: string } | null>
  /** 判定一段文本是否为内部思维链/独白泄漏(2026-08-17):true = 拦截不发,
   * false = 放行, null = 判定失败(调用方按放行处理,避免误删正常内容) */
  judgeMonologue(reply: string): Promise<boolean | null>
} {
  const stream = deps.stream ?? defaultStream
  return {
    async classify(input) {
      const config = deps.getConfig()
      if (!config.apiKey.trim()) return null
      try {
        const system = buildClassifierSystem(input.kindLabel, input.targetLabel, input.trigger)
        // 单措辞 + 一次重试;20s 超时,noThinking 低强度——路由等待判定,
        // 快速返回优先;JSON 模式(prompt 含 "JSON" 字样满足官方要求)
        for (let retry = 0; retry < 2; retry++) {
          try {
            const result = await stream({
              config: { ...config, reasoningEffort: 'low' },
              system,
              history: [
                {
                  id: 'cls-' + Date.now(),
                  role: 'user',
                  parts: [{ type: 'text', text: `【助手回复】\n${input.reply.slice(0, 2000)}` }],
                },
              ],
              tools: [],
              signal: AbortSignal.timeout(20000),
              onEvent: () => {},
              jsonMode: true,
              noThinking: true,
            })
            const verdict = parseClassifierJson(result.text)
            if (verdict) return verdict
            // 空 content / 垃圾输出(json_mode 已知问题):重试一次
          } catch {
            if (retry === 0) continue
            break
          }
        }
        return null
      } catch {
        return null
      }
    },
    async judgeMonologue(reply) {
      const config = deps.getConfig()
      if (!config.apiKey.trim()) return null
      try {
        const system = buildMonologueJudgeSystem()
        // 与 classify 同款:低强度无思考 + JSON + 20s 超时 + 一次重试;
        // **失败/垃圾输出返回 null → 调用方按放行处理**(审核拿不准不拦截)
        for (let retry = 0; retry < 2; retry++) {
          try {
            const result = await stream({
              config: { ...config, reasoningEffort: 'low' },
              system,
              history: [
                {
                  id: 'mono-' + Date.now(),
                  role: 'user',
                  parts: [{ type: 'text', text: `【待发送文本】\n${String(reply ?? '').slice(0, 2000)}` }],
                },
              ],
              tools: [],
              signal: AbortSignal.timeout(20000),
              onEvent: () => {},
              jsonMode: true,
              noThinking: true,
            })
            const verdict = parseMonologueJson(result.text)
            if (verdict) return verdict.isInternal
            // 空 content / 垃圾输出:重试一次
          } catch {
            if (retry === 0) continue
            break
          }
        }
        return null
      } catch {
        return null
      }
    },
  }
}

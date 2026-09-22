/**
 * 小米 MiMo 专项工具簇(2026-09-22 官网接入文档专项适配)
 *
 * 两个工具(凭据走 mimo 供应商桶,与当前激活供应商无关——主 Agent 用
 * DeepSeek 也能调,只要设置里 MiMo 桶配了 Key;同 GLM 工具簇先例):
 * - mimo_media:多模态理解(听音频/看视频/看图)——**Responses API 第一
 *   优先**(/v1/responses 原生 input_image/input_audio/input_video,编码复用
 *   providers/mimo-media.ts;Chat Completions 过旧,不再走);对话直接发/
 *   拖的附件在 MiMo 协议下**原生理解**,无需本工具——本工具管"指定路径/
 *   URL"的任意媒体;
 * - mimo_batch:批量文本生成(官网 Batch API)——离线批量跑 N 条提示词
 *   (价格为实时 50%,闲时调度,completion_window 1-14 天),action =
 *   create/status/result/cancel;输入 JSONL 按 **Responses 格式**
 *   (url:/v1/responses,body {model, input, reasoning}),结果 JSONL 落盘
 *   工具输出目录。
 *
 * 与相邻工具的分工(description 同步注入 LLM):
 * - glm_ocr:图片**提取文字**(任何供应商可调);
 * - mimo_media:图片/音频/视频的**内容理解**(听懂语音、描述画面、转写);
 * - napcat send voice:发语音条(输出方向),不是理解。
 *
 * 官方文档:
 * - Responses(多模态 input 首选)https://mimo.mi.com/docs/zh-CN/api/chat/responses
 * - 多模态 https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/*
 * - Batch https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/batch-api
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { mimoResponsesContentPart, mimoMimeOf } from '../providers/mimo-media'
import {
  mimoBatchBaseUrl,
  mimoErrorMessage,
  MIMO_BATCH_DEFAULT_REGION,
  MIMO_DEFAULT_MODEL,
  MIMO_MODEL_V26_FLASH,
  MIMO_MODEL_V26_PRO,
} from '../providers/mimo-constants'
import { toolOutputDir, userDataDir } from './tools-env'
import type { AgentTool, ToolParams } from '../types'

/** MiMo 桶凭据(引擎注入:providers.mimo 的 apiKey/baseURL/model,实时读取) */
export interface MimoCreds {
  apiKey: string
  baseURL: string
  model: string
}

/** 批量推理官方模型(仅此二者,模型名小写) */
const MIMO_BATCH_MODELS = [MIMO_MODEL_V26_FLASH, MIMO_MODEL_V26_PRO] as const

/** 单次 create 提示条数上限(防 LLM 一次塞爆输出预算;官网单文件 128MB) */
const MIMO_BATCH_MAX_REQUESTS = 500

/** Batch 文件上传上限(官网 128MB;JSONL 取 48MB 防 OOM,超限让 LLM 拆批) */
const MIMO_BATCH_MAX_JSONL_BYTES = 48 * 1024 * 1024

/** 结果摘要单条内容截断(引擎工具回填还有 8000 总截断,留余量) */
const MIMO_BATCH_ITEM_LIMIT = 600

export interface MimoBatchRequest {
  prompt: string
  system?: string
  custom_id?: string
}

/**
 * 批量请求清单 → 输入 JSONL(官网 Batch **Responses 格式**——第一优先,
 * Chat Completions 格式过旧:一行一请求 `url:/v1/responses`,body 与实时
 * /v1/responses 请求体一致 {model, instructions?, input, max_output_tokens,
 * reasoning})。纯函数,可 node 直测。
 */
export function buildMimoBatchJsonl(
  requests: MimoBatchRequest[],
  opts: { model: string; maxCompletionTokens?: number; thinking?: boolean },
): string {
  const seen = new Set<string>()
  const lines = requests.map((req, i) => {
    const customId = String(req.custom_id ?? '').trim() || `request-${i + 1}`
    if (seen.has(customId)) throw new Error(`custom_id 重复:${customId}(批量请求的 custom_id 必须唯一)`)
    seen.add(customId)
    const prompt = String(req.prompt ?? '').trim()
    if (!prompt) throw new Error(`第 ${i + 1} 条请求 prompt 为空`)
    const system = String(req.system ?? '').trim()
    return JSON.stringify({
      custom_id: customId,
      method: 'POST',
      url: '/v1/responses',
      body: {
        model: opts.model,
        ...(system ? { instructions: system } : {}),
        input: prompt,
        max_output_tokens: opts.maxCompletionTokens ?? 2048,
        reasoning: { effort: opts.thinking ? 'high' : 'none' },
      },
    })
  })
  return lines.join('\n') + '\n'
}

/** completion_window 校验(官网:1-14 天;示例 '24h')→ 统一小时数 */
function parseWindowHours(value: string): number {
  const m = /^(\d{1,4})(h|d)$/i.exec(value.trim())
  if (!m) throw new Error(`completion_window 格式如 "24h" / "7d"(1-14 天),收到:${value}`)
  const n = parseInt(m[1], 10) * (m[2].toLowerCase() === 'd' ? 24 : 1)
  if (n < 24 || n > 336) throw new Error(`completion_window 超出范围(官网 1-14 天):${value}`)
  return n
}

/** 实时理解端点 URL(Responses 第一优先;baseURL 自动补 /v1,与 mimo-responses 同款) */
function responsesUrl(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, '')
  if (!base) return `https://api.xiaomimimo.com/v1/responses`
  return base.includes('/v1') ? `${base}/responses` : `${base}/v1/responses`
}

/** 批量端点解析:显式 batch_base_url 优先,否则按 region 拼官方主机 */
function batchBaseOf(params: ToolParams): string {
  const override = String(params.batch_base_url ?? '').trim().replace(/\/+$/, '')
  if (override) {
    if (!/^https?:\/\//i.test(override)) throw new Error(`batch_base_url 需要 http(s) 地址:${override}`)
    return override
  }
  const region = String(params.region ?? '').trim() || MIMO_BATCH_DEFAULT_REGION
  return mimoBatchBaseUrl(region)
}

/** 批量端点请求(JSON;非 2xx 走官方错误码映射 + 批量常见坑提示) */
async function batchFetch(
  base: string,
  apiKey: string,
  endpoint: string,
  init: { method?: string; body?: string | FormData; timeoutMs?: number; form?: boolean } = {},
): Promise<Record<string, unknown>> {
  const url = `${base}${endpoint}`
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        ...(init.form ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') {
      throw new Error(`MiMo 批量推理请求超时(${endpoint});网络慢可稍后用 status 查询`)
    }
    throw new Error(
      `无法连接 MiMo 批量推理端点(${url}):${(err as Error).message}` +
        `——批量主机与实时对话不同(batch-api-<region>.xiaomimimo.com),region 从控制台「批量推理」页获取,或传 batch_base_url 完整地址`,
    )
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      // 忽略读失败
    }
    const hint =
      res.status === 402
        ? '(批量只消耗现金余额、不与 Token Plan 互通;余额为 0 时任务创建失败)'
        : res.status === 403
          ? '(批量需完成实名认证,否则会跳转认证页)'
          : ''
    throw new Error(mimoErrorMessage(res.status, detail) + hint)
  }
  return (await res.json()) as Record<string, unknown>
}

/** 批量任务对象 → 可读摘要 */
function summarizeBatch(d: Record<string, unknown>): string {
  const counts = (d.request_counts ?? {}) as Record<string, unknown>
  const pick = (k: string) => (typeof d[k] === 'string' ? String(d[k]) : '')
  return [
    `batch_id:${String(d.id ?? '')}`,
    `状态:${String(d.status ?? '未知')}`,
    `请求:总数 ${String(counts.total ?? '?')} / 已完成 ${String(counts.completed ?? 0)} / 失败 ${String(counts.failed ?? 0)}`,
    `endpoint:${String(d.endpoint ?? '')}`,
    `输入文件:${String(d.input_file_id ?? '')}`,
    `输出文件:${pick('output_file_id') || '(未生成)'}`,
    `错误文件:${pick('error_file_id') || '(无)'}`,
    pick('expires_at') ? `过期时间:${pick('expires_at')}` : '',
    pick('completed_at') ? `完成时间:${pick('completed_at')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 小米 MiMo 专项工具组(mimo_media + mimo_batch)。
 * getMimoCreds 每次执行实时读取(配置变更即时生效);null = 未配置 Key,
 * 工具执行时报错引导用户去设置页填写(不隐藏工具,同 GLM 先例)。
 */
export function createMimoTools(getMimoCreds: () => MimoCreds | null): AgentTool[] {
  const requireCreds = (): MimoCreds => {
    const creds = getMimoCreds()
    if (!creds || !creds.apiKey.trim()) {
      throw new Error(
        '小米 MiMo API Key 未配置:请在 灵动岛设置 → Agent 设置 → 账号 → 供应商选择「小米 MiMo」填写 API Key(与当前对话供应商无关,mimo 桶配好即可)',
      )
    }
    return creds
  }

  return [
    {
      name: 'mimo_media',
      description:
        '多模态理解(小米 MiMo):听懂音频、看懂视频、看懂图片内容。' +
        '适合:用户给语音/录音/音乐问"说了什么/唱了什么"(给出尽量完整的转写);' +
        '给视频问"视频里有什么"(描述画面内容);给图片问"图里是什么"(看图理解,与 glm_ocr 的**提取文字**不同)。' +
        'path 支持本地绝对路径或公网 URL(音频/视频/图片均可)。' +
        '注意:用户直接发/拖进对话的附件,在 MiMo 供应商下已原生理解,不需要本工具;' +
        '本工具用于指定任意路径/URL 的媒体。图片**只想抄文字**用 glm_ocr 更准。',
      timeoutMs: 120_000,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              '媒体文件本地绝对路径或公网 URL(音频 mp3/wav/flac/m4a/ogg;视频 mp4/mov/avi/wmv;图片 jpg/png/gif/webp/bmp)',
          },
          question: {
            type: 'string',
            description: '要理解的问题,缺省"完整理解并描述内容,音频给出尽量完整的转写"',
          },
          thinking: { type: 'boolean', description: '是否开启深度思考(复杂分析更准但更慢),缺省 false' },
        },
        required: ['path'],
      },
      async execute(params: ToolParams) {
        const creds = requireCreds()
        const raw = String(params.path ?? '').trim()
        if (!raw) throw new Error('path 不能为空')
        // kind 纯按扩展名判定(img/video/audio 三表互斥),构造 media part 走严格编码
        const kind = mimoMimeOf('video', raw) ? 'video' : mimoMimeOf('audio', raw) ? 'audio' : mimoMimeOf('img', raw) ? 'img' : null
        if (!kind) {
          throw new Error(
            `无法从路径判断媒体类型:${raw}(需要可识别的扩展名:音频 mp3/wav/flac/m4a/ogg;视频 mp4/mov/avi/wmv;图片 jpg/png/gif/webp/bmp)`,
          )
        }
        const mediaPart = await mimoResponsesContentPart(
          { type: 'media', kind, url: raw, name: path.basename(raw.split(/[?#]/)[0]) },
          { strict: true },
        )
        const question = String(params.question ?? '').trim() || '请完整理解并描述这段内容,音频请给出尽量完整的转写'
        // Responses 第一优先:message item + input_text/多模态 part
        const body = {
          model: creds.model.trim() || MIMO_DEFAULT_MODEL,
          input: [{ type: 'message', role: 'user', content: [mediaPart, { type: 'input_text', text: question }] }],
          reasoning: { effort: params.thinking === true ? 'high' : 'none' },
          max_output_tokens: 2048,
          stream: false,
        }
        const url = responsesUrl(creds.baseURL)
        let res: Response
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': creds.apiKey.trim(),
              Authorization: `Bearer ${creds.apiKey.trim()}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(110_000),
          })
        } catch (err) {
          if ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') {
            throw new Error('MiMo 多模态理解超时(110s);大视频可截取片段或降低提问复杂度')
          }
          throw new Error(`无法连接 MiMo API(${url}):${(err as Error).message}`)
        }
        if (!res.ok) {
          let detail = ''
          try {
            detail = (await res.text()).slice(0, 500)
          } catch {
            // 忽略读失败
          }
          throw new Error(mimoErrorMessage(res.status, detail))
        }
        const data = (await res.json()) as Record<string, unknown>
        // Responses output items:message.content[].output_text 为正文;
        // reasoning/summary 类 part 归思考(官网:勿默认取 output[0])
        let content = ''
        let reasoning = ''
        for (const rawItem of Array.isArray(data.output) ? data.output : []) {
          const item = (rawItem ?? {}) as Record<string, unknown>
          for (const rawPart of Array.isArray(item.content) ? item.content : []) {
            const part = (rawPart ?? {}) as Record<string, unknown>
            const t = typeof part.text === 'string' ? part.text : ''
            if (!t) continue
            if (part.type === 'output_text') content += t
            else if (part.type === 'reasoning_text' || part.type === 'summary_text') reasoning += t
          }
        }
        const text = content.trim() || reasoning.trim()
        if (!text) {
          if (data.status === 'incomplete') return '(MiMo 响应不完整被截断;可换 thinking=true 重试或缩短提问)'
          return '(MiMo 返回为空;可换 thinking=true 重试,或确认媒体文件可被识别)'
        }
        const usage = (data.usage ?? {}) as Record<string, unknown>
        const outDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>
        const inDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>
        const reasoningTokens = typeof outDetails.reasoning_tokens === 'number' ? outDetails.reasoning_tokens : 0
        const cached = typeof inDetails.cached_tokens === 'number' ? inDetails.cached_tokens : 0
        const usageLine =
          `【用量】输入 ${String(usage.input_tokens ?? '?')}${cached > 0 ? `(缓存 ${cached})` : ''} / ` +
          `输出 ${String(usage.output_tokens ?? '?')}${reasoningTokens > 0 ? `(思考 ${reasoningTokens})` : ''}`
        return content.trim()
          ? `${content.trim()}\n${usageLine}`
          : `(仅有思考过程,无正文输出)\n${reasoning.trim().slice(0, 1500)}\n${usageLine}`
      },
    },
    {
      name: 'mimo_batch',
      description:
        '批量文本生成(小米 MiMo Batch API):把 N 条独立提示词提交成**离线批量任务**,' +
        '价格为实时 API 的 50%,闲时调度(几小时内出结果,completion_window 内完成)。' +
        'action=create 提交(返回 batch_id)→ 之后用 status 轮询 → 完成后 result 取结果(全文落盘工具输出目录)→ 需要时 cancel 取消。' +
        '适合:大批量翻译/改写/摘要/分类/数据打标等**不着急**的批量活;单条即时问答不要用(直接对话即可)。' +
        '注意:批量只消耗现金余额(不与 Token Plan 互通);需完成实名认证;仅支持 mimo-v2.6-flash / mimo-v2.6-pro;' +
        'region 从 MiMo 控制台「批量推理」页获取(缺省 cn),连不上时传 batch_base_url 完整地址。',
      timeoutMs: 120_000,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'status', 'result', 'cancel'], description: '操作类型' },
          requests: {
            type: 'array',
            description: 'create:批量请求清单(≤500 条),每条 {prompt, system?, custom_id?}——请求互相独立,相同提示词需逐条写',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: '该条提示词(必填)' },
                system: { type: 'string', description: '该条 system 提示(可选)' },
                custom_id: { type: 'string', description: '自定义请求标识(可选,缺省 request-N,用于对齐结果)' },
              },
              required: ['prompt'],
            },
          },
          model: {
            type: 'string',
            enum: [...MIMO_BATCH_MODELS],
            description: `create:批量模型(官网仅此两个,小写),缺省 ${MIMO_MODEL_V26_FLASH}(便宜;复杂任务用 ${MIMO_MODEL_V26_PRO})`,
          },
          completion_window: {
            type: 'string',
            description: 'create:任务超时窗口,如 "24h" / "7d"(官网 1-14 天),缺省 24h;闲时调度,窗口别卡太紧',
          },
          max_completion_tokens: { type: 'number', description: 'create:单条输出上限,缺省 2048' },
          thinking: { type: 'boolean', description: 'create:是否开启深度思考(批量默认关闭省额度)' },
          batch_id: { type: 'string', description: 'status / result / cancel:任务 id(batch_ 开头)' },
          include_errors: { type: 'boolean', description: 'result:同时下载错误文件明细,缺省 false' },
          limit: { type: 'number', description: 'result:摘要最多列出几条结果,缺省 20(全文在落盘文件里)' },
          region: { type: 'string', description: `批量推理区域(控制台「批量推理」页获取),缺省 ${MIMO_BATCH_DEFAULT_REGION}` },
          batch_base_url: { type: 'string', description: '批量端点完整地址覆盖(https://batch-api-<region>.xiaomimimo.com),连不上时用' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const creds = requireCreds()
        const action = String(params.action ?? '').trim()
        const base = batchBaseOf(params)

        if (action === 'create') {
          const rawList = Array.isArray(params.requests) ? (params.requests as MimoBatchRequest[]) : []
          if (rawList.length === 0) throw new Error('requests 不能为空:批量请求清单 [{prompt, system?, custom_id?}, ...]')
          if (rawList.length > MIMO_BATCH_MAX_REQUESTS) {
            throw new Error(`单次最多 ${MIMO_BATCH_MAX_REQUESTS} 条请求(收到 ${rawList.length}),请拆批提交`)
          }
          const model = String(params.model ?? '').trim().toLowerCase() || MIMO_MODEL_V26_FLASH
          if (!(MIMO_BATCH_MODELS as readonly string[]).includes(model)) {
            throw new Error(`model 仅支持 ${MIMO_BATCH_MODELS.join(' / ')}(批量推理官网支持清单)`)
          }
          const window = String(params.completion_window ?? '').trim() || '24h'
          parseWindowHours(window)
          const jsonl = buildMimoBatchJsonl(rawList, {
            model,
            maxCompletionTokens: typeof params.max_completion_tokens === 'number' ? params.max_completion_tokens : undefined,
            thinking: params.thinking === true,
          })
          if (jsonl.length > MIMO_BATCH_MAX_JSONL_BYTES) {
            throw new Error(`批量输入 JSONL 过大(${(jsonl.length / 1024 / 1024).toFixed(1)}MB,上限 48MB;官网单文件 128MB),请拆批或缩短提示词`)
          }
          // 上传输入文件(purpose 固定 batch;multipart,undici 自动带 boundary)
          const form = new FormData()
          form.append('purpose', 'batch')
          form.append('file', new Blob([jsonl]), 'input.jsonl')
          const file = await batchFetch(base, creds.apiKey, '/v1/files', { method: 'POST', body: form, form: true, timeoutMs: 90_000 })
          const fileId = String(file.id ?? '')
          if (!fileId) throw new Error(`上传输入文件失败(响应无 id):${JSON.stringify(file).slice(0, 300)}`)
          // 创建批处理任务(Responses 第一优先:endpoint /v1/responses)
          const batch = await batchFetch(base, creds.apiKey, '/v1/batches', {
            method: 'POST',
            body: JSON.stringify({ input_file_id: fileId, endpoint: '/v1/responses', completion_window: window }),
          })
          return `已提交批量任务(闲时调度,通常几小时内完成;价格 = 实时 50%)\n${summarizeBatch(batch)}\n下一步:action=status 查进度(batch_id 填 ${String(batch.id ?? '返回的 id')});完成后 action=result 取结果`
        }

        const batchId = String(params.batch_id ?? '').trim()
        if (!batchId) throw new Error('batch_id 不能为空(status / result / cancel 都需要)')

        if (action === 'status') {
          const batch = await batchFetch(base, creds.apiKey, `/v1/batches/${encodeURIComponent(batchId)}`)
          return `批量任务状态:\n${summarizeBatch(batch)}${
            batch.status === 'completed' ? '\n已完成——用 action=result 取结果' : batch.status === 'in_progress' || batch.status === 'validating' ? '\n进行中——过会儿再用 status 查询(闲时调度,无需频繁轮询)' : ''
          }`
        }

        if (action === 'cancel') {
          const batch = await batchFetch(base, creds.apiKey, `/v1/batches/${encodeURIComponent(batchId)}/cancel`, { method: 'POST' })
          return `已发起取消(异步;取消前已完成的请求照常计费):\n${summarizeBatch(batch)}\n稍后用 status 确认 cancelled;已完成部分可用 result 取回`
        }

        if (action === 'result') {
          const batch = await batchFetch(base, creds.apiKey, `/v1/batches/${encodeURIComponent(batchId)}`)
          const status = String(batch.status ?? '')
          const outputId = String(batch.output_file_id ?? '')
          if (!outputId) {
            return `暂无结果文件(状态:${status || '未知'})\n${summarizeBatch(batch)}\n${status === 'failed' || status === 'expired' ? '任务已失败/过期——失败的请求不计费,可修正后重新 create' : '任务未完成——稍后再用 result 查询'}`
          }
          // 下载并解析输出 JSONL(一行一结果,custom_id 对齐输入)
          const outRes = await fetch(`${base}/v1/files/${encodeURIComponent(outputId)}/content`, {
            headers: { Authorization: `Bearer ${creds.apiKey.trim()}` },
            signal: AbortSignal.timeout(60_000),
          })
          if (!outRes.ok) throw new Error(mimoErrorMessage(outRes.status, (await outRes.text().catch(() => '')).slice(0, 300)))
          const rawText = await outRes.text()
          // 全文落盘(工具输出目录:输出根/mimo_batch/[会话ID];未配置则 userData/mimo-batch)
          const outDir = toolOutputDir('mimo_batch') ?? path.join(userDataDir(), 'mimo-batch')
          await fs.mkdir(outDir, { recursive: true })
          const outFile = path.join(outDir, `${batchId}-output.jsonl`)
          await fs.writeFile(outFile, rawText, 'utf8')
          let errFile = ''
          const errId = String(batch.error_file_id ?? '')
          const includeErrors = params.include_errors === true
          if (errId && includeErrors) {
            const errRes = await fetch(`${base}/v1/files/${encodeURIComponent(errId)}/content`, {
              headers: { Authorization: `Bearer ${creds.apiKey.trim()}` },
              signal: AbortSignal.timeout(60_000),
            })
            if (errRes.ok) {
              errFile = path.join(outDir, `${batchId}-errors.jsonl`)
              await fs.writeFile(errFile, await errRes.text(), 'utf8')
            }
          }
          const entries = rawText
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l) as Record<string, unknown>
              } catch {
                return null
              }
            })
            .filter((d): d is Record<string, unknown> => !!d)
          const limit = Math.max(1, Math.min(entries.length || 1, typeof params.limit === 'number' ? params.limit : 20))
          const lines: string[] = []
          let okCount = 0
          let failCount = 0
          for (const d of entries) {
            const resp = (d.response ?? null) as Record<string, unknown> | null
            const err = (d.error ?? null) as Record<string, unknown> | null
            const cid = String(d.custom_id ?? '')
            if (resp && typeof resp.status_code === 'number' && resp.status_code < 400) {
              okCount++
              if (lines.length < limit) {
                const body = (resp.body ?? {}) as Record<string, unknown>
                // Responses 格式 output[].content[].output_text(第一优先);
                // 兼容旧 chat 格式 choices[].message.content
                let content = ''
                for (const rawItem of Array.isArray(body.output) ? body.output : []) {
                  const item = (rawItem ?? {}) as Record<string, unknown>
                  for (const rawPart of Array.isArray(item.content) ? item.content : []) {
                    const part = (rawPart ?? {}) as Record<string, unknown>
                    if (part.type === 'output_text' && typeof part.text === 'string') content += part.text
                    else if (!content && (part.type === 'reasoning_text' || part.type === 'summary_text') && typeof part.text === 'string') {
                      content = `[思考型输出] ${part.text}`
                    }
                  }
                }
                if (!content) {
                  const choice = (Array.isArray(body.choices) ? body.choices[0] : undefined) as Record<string, unknown> | undefined
                  const message = (choice?.message ?? {}) as Record<string, unknown>
                  if (typeof message.content === 'string') content = message.content
                  else if (typeof message.reasoning_content === 'string') content = `[思考型输出] ${message.reasoning_content}`
                }
                if (content.length > MIMO_BATCH_ITEM_LIMIT) content = content.slice(0, MIMO_BATCH_ITEM_LIMIT) + '…'
                lines.push(`【${cid}】${content || '(空输出)'}`)
              }
            } else {
              failCount++
              if (lines.length < limit) {
                lines.push(`【${cid}】失败:${String(err?.message ?? `HTTP ${String(resp?.status_code ?? '?')}`)}`)
              }
            }
          }
          const head = `批量任务 ${batchId} 结果:成功 ${okCount} / 失败 ${failCount}\n全文文件:${outFile}${errFile ? `\n错误明细:${errFile}` : ''}`
          if (entries.length === 0) return `${head}\n(输出文件为空)`
          const more = entries.length > limit ? `\n…共 ${entries.length} 条,已列前 ${limit} 条(全文见文件)` : ''
          return `${head}\n${lines.join('\n')}${more}`
        }

        throw new Error(`未知 action:${action}(仅支持 create / status / result / cancel)`)
      },
    },
  ]
}

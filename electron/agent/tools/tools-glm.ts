/**
 * 智谱 GLM 云端文档工具簇(2026-08-19 文档解析/OCR 接入)
 *
 * 两个工具(官方工具 API,均走 glm 供应商桶凭据,与当前激活供应商无关——
 * 主 Agent 用 DeepSeek 时也能调,只要设置里 GLM 桶配了 Key):
 * - glm_ocr:POST /files/ocr,图片文字识别(手写体/多语言,同步返回);
 * - glm_file_parse:文件解析提取文本。同步模式 POST /files/parser/sync
 *   (prime-sync,一步拿 content);异步模式 POST /files/parser/create
 *   (lite/expert/prime)→ 轮询 GET /files/parser/result/{taskId}/text。
 *
 * 与相邻工具的分工(description 同步注入 LLM):
 * - read_file:纯文本文件直接读(代码/配置/日志);
 * - glm_file_parse:PDF/Word/Excel/PPT/扫描件等**提取文本内容**;
 * - doc_convert:文档格式**转换**(输出 PDF/DOCX/MD 文件);
 * - glm_ocr:图片(截图/照片)文字识别,含手写体。
 *
 * 官方文档:https://docs.bigmodel.cn/api-reference/工具-api/
 * (文件解析(同步)/文件解析/解析结果/OCR 服务)
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { glmCloudErrorMessage, GLM_CLOUD_DEFAULT_BASE_URL } from '../providers/glm-cloud-constants'
import type { AgentTool, ToolExecCtx, ToolParams } from '../types'

/** GLM 桶凭据(引擎注入:providers.glm 的 apiKey/baseURL) */
export interface GlmCreds {
  apiKey: string
  baseURL: string
}

/** 上传文件大小上限(50MB,防 OOM) */
const GLM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024

/** OCR 语言/识别模型枚举(官方 language_type 全集) */
const GLM_OCR_LANGUAGES = [
  'CHN_ENG', 'AUTO', 'ENG', 'JAP', 'KOR', 'FRE', 'SPA', 'POR', 'GER', 'ITA',
  'RUS', 'DAN', 'DUT', 'MAL', 'SWE', 'IND', 'POL', 'ROM', 'TUR', 'GRE',
  'HUN', 'THA', 'VIE', 'ARA', 'HIN',
] as const

/** 文件解析支持的扩展名(Prime 工具全集;file_type = 扩展名大写) */
const GLM_PARSE_EXTENSIONS = new Set([
  'pdf', 'docx', 'doc', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg',
  'csv', 'txt', 'md', 'html', 'bmp', 'gif', 'webp', 'heic', 'eps', 'icns',
  'im', 'pcx', 'ppm', 'tiff', 'xbm', 'heif', 'jp2',
])

/**
 * 读取待上传文件(存在性 + 大小校验),返回 FormData(原生 undici,
 * fetch 自动带 multipart boundary,勿手动设 Content-Type)。
 * fileName 官方必填(file 字段)。
 */
async function buildUploadForm(filePath: string, fields: Record<string, string>): Promise<FormData> {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile()) {
    throw new Error(`文件不存在:${filePath}(请用 list_dir 确认真实路径与文件名,注意特殊字符与空格)`)
  }
  if (stat.size > GLM_UPLOAD_MAX_BYTES) {
    throw new Error(`文件过大(${(stat.size / 1024 / 1024).toFixed(1)}MB,上限 50MB):${filePath}`)
  }
  const buf = await fs.readFile(filePath)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buf)]), path.basename(filePath))
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return form
}

/** GLM 端点请求(multipart POST);非 2xx 读 body 走官方错误码映射 */
async function glmPostForm(
  creds: GlmCreds,
  endpoint: string,
  form: FormData,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const base = creds.baseURL.trim().replace(/\/+$/, '') || GLM_CLOUD_DEFAULT_BASE_URL
  const url = `${base}${endpoint}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.apiKey.trim()}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') {
      throw new Error(`智谱 GLM 请求超时(${endpoint},${Math.round(timeoutMs / 1000)}s)`)
    }
    throw new Error(`无法连接智谱 GLM API(${url}):${(err as Error).message}`)
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      // 忽略读失败
    }
    throw new Error(glmCloudErrorMessage(res.status, detail))
  }
  return (await res.json()) as Record<string, unknown>
}

/** GLM 端点 GET(解析结果轮询);非 2xx 同款错误映射 */
async function glmGet(
  creds: GlmCreds,
  endpoint: string,
): Promise<Record<string, unknown>> {
  const base = creds.baseURL.trim().replace(/\/+$/, '') || GLM_CLOUD_DEFAULT_BASE_URL
  const url = `${base}${endpoint}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.apiKey.trim()}` },
      signal: AbortSignal.timeout(20000),
    })
  } catch (err) {
    throw new Error(`无法连接智谱 GLM API(${url}):${(err as Error).message}`)
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      // 忽略读失败
    }
    throw new Error(glmCloudErrorMessage(res.status, detail))
  }
  return (await res.json()) as Record<string, unknown>
}

/** 睡眠(轮询间隔) */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 智谱 GLM 文档工具组(glm_ocr + glm_file_parse)。
 * getGlmCreds 每次执行实时读取(配置变更即时生效);返回 null = 未配置
 * Key,工具执行时报错引导用户去设置页填写。
 */
export function createGlmTools(getGlmCreds: () => GlmCreds | null): AgentTool[] {
  /** 取凭据;未配置给出可读错误(LLM 可转告用户) */
  const requireCreds = (): GlmCreds => {
    const creds = getGlmCreds()
    if (!creds || !creds.apiKey.trim()) {
      throw new Error('智谱 GLM API Key 未配置:请在 灵动岛设置 → Agent 设置 → 账号 → 供应商选择「智谱 GLM」填写 API Key(与当前对话供应商无关,glm 桶配好即可)')
    }
    return creds
  }

  return [
    {
      name: 'glm_ocr',
      description:
        '图片文字识别 OCR(智谱 GLM 云端):识别图片中的文字,支持**手写体**与多语言。' +
        '适合:用户给截图/照片/扫描图要提取文字;手写笔记识别;图片里的表格/段落转文字。' +
        '注意:要读 PDF/Word/Excel/PPT 等文档内容用 glm_file_parse;纯文本文件直接 read_file。',
      timeoutMs: 90_000,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片文件绝对路径(如 .png/.jpg/.jpeg/.bmp/.webp)' },
          language_type: {
            type: 'string',
            enum: [...GLM_OCR_LANGUAGES],
            description: '语言类型,缺省 CHN_ENG(中英混合);AUTO 自动检测,ENG/JAP/KOR/FRE 等单语',
          },
          probability: { type: 'boolean', description: '是否返回每块文字的置信度,缺省 false' },
        },
        required: ['path'],
      },
      async execute(params: ToolParams) {
        const filePath = String(params.path ?? '').trim()
        if (!filePath) throw new Error('path 不能为空')
        const creds = requireCreds()
        const language = String(params.language_type ?? 'CHN_ENG')
        if (!(GLM_OCR_LANGUAGES as readonly string[]).includes(language)) {
          throw new Error(`language_type 仅支持:${GLM_OCR_LANGUAGES.join('/')}`)
        }
        const form = await buildUploadForm(filePath, {
          tool_type: 'hand_write',
          language_type: language,
          ...(params.probability === true ? { probability: 'true' } : {}),
        })
        const d = await glmPostForm(creds, '/files/ocr', form, 80_000)
        if (d.status === 'failed') {
          throw new Error(`OCR 失败:${String(d.message ?? '未知原因')}`)
        }
        const words = Array.isArray(d.words_result) ? (d.words_result as Array<Record<string, unknown>>) : []
        if (words.length === 0) return '(未识别到文字;图片可能无文字内容或清晰度不足)'
        const lines = words.map((w, i) => {
          const text = String(w.words ?? '')
          const prob = w.probability as Record<string, unknown> | undefined
          const avg = typeof prob?.average === 'number' ? ` (置信度 ${(prob.average * 100).toFixed(0)}%)` : ''
          return `${i + 1}. ${text}${avg}`
        })
        return `识别到 ${String(d.words_result_num ?? words.length)} 块文字:\n${lines.join('\n')}`
      },
    },
    {
      name: 'glm_file_parse',
      description:
        '文档解析提取文本(智谱 GLM 云端):把 PDF/Word(doc/docx)/Excel/PPT/图片/HTML/CSV 等' +
        '解析成**纯文本内容**直接返回。适合:用户说"读一下这个 PDF/Word/PPT""提取文档内容/总结这篇文档"' +
        '(拿到文本后可继续总结/翻译/回答)。' +
        'mode=sync(缺省)一步同步返回,适合多数文档;mode=async 走后台任务(大文件/复杂版式,' +
        'tool_type:lite 快速 / expert 深度(仅 PDF)/ prime 全能,缺省 prime)。' +
        '注意:**格式转换**(PDF→Word 等,要输出文件)用 doc_convert;纯文本文件(代码/配置)直接 read_file;' +
        '单张图片识别文字用 glm_ocr。需在设置里配置智谱 GLM API Key。',
      // 同步解析大文档可能较慢;异步模式含轮询等待(最长 ~150s),同 doc_convert 档位
      timeoutMs: 200_000,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文档文件绝对路径(支持 pdf/doc/docx/xls/xlsx/ppt/pptx/png/jpg/csv/txt/md/html 等)' },
          mode: {
            type: 'string',
            enum: ['sync', 'async'],
            description: 'sync(缺省)= 同步解析直接返回文本;async = 后台任务+轮询(大文件用)',
          },
          tool_type: {
            type: 'string',
            enum: ['lite', 'expert', 'prime'],
            description: 'async 模式的解析工具:lite 快速 / expert 深度(仅 PDF)/ prime 全能(缺省)',
          },
        },
        required: ['path'],
      },
      async execute(params: ToolParams, ctx?: ToolExecCtx) {
        const filePath = String(params.path ?? '').trim()
        if (!filePath) throw new Error('path 不能为空')
        const creds = requireCreds()
        const ext = path.extname(filePath).slice(1).toLowerCase()
        if (ext && !GLM_PARSE_EXTENSIONS.has(ext)) {
          throw new Error(`不支持的文件类型 .${ext}(支持:${[...GLM_PARSE_EXTENSIONS].join('/')})`)
        }
        const fileType = ext ? ext.toUpperCase() : ''

        const mode = String(params.mode ?? 'sync')
        if (mode === 'sync') {
          // 同步解析:prime-sync 一步拿 content
          const form = await buildUploadForm(filePath, {
            tool_type: 'prime-sync',
            ...(fileType ? { file_type: fileType } : {}),
          })
          const d = await glmPostForm(creds, '/files/parser/sync', form, 180_000)
          if (d.status === 'failed') {
            throw new Error(`文件解析失败:${String(d.message ?? '未知原因')}`)
          }
          const content = typeof d.content === 'string' ? d.content : ''
          if (!content) {
            return `(解析成功但无文本内容;下载链接:${String(d.parsing_result_url ?? '无')}。文档可能是纯图片扫描件,可改用 glm_ocr 逐页识别)`
          }
          return content.length > 12000
            ? content.slice(0, 12000) + `\n…(解析文本过长,已截断到 12000 字符,全文 ${content.length} 字符)`
            : content
        }

        // 异步解析:create 拿 task_id → 轮询 result(text 格式)
        if (mode !== 'async') throw new Error('mode 仅支持 sync 或 async')
        const toolType = String(params.tool_type ?? 'prime')
        if (!['lite', 'expert', 'prime'].includes(toolType)) {
          throw new Error('tool_type 仅支持 lite/expert/prime')
        }
        if (toolType === 'expert' && ext && ext !== 'pdf') {
          throw new Error('expert 工具仅支持 PDF 文件(其它格式请用 prime 或 lite)')
        }
        const form = await buildUploadForm(filePath, {
          tool_type: toolType,
          ...(fileType ? { file_type: fileType } : {}),
        })
        const created = await glmPostForm(creds, '/files/parser/create', form, 60_000)
        const taskId = typeof created.task_id === 'string' ? created.task_id : ''
        if (!taskId) throw new Error(`任务创建失败:${String(created.message ?? JSON.stringify(created).slice(0, 200))}`)

        // 轮询解析结果(2.5s 间隔,最长 ~150s;中止信号随时退出)
        for (let i = 0; i < 60; i++) {
          if (ctx?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
          await sleep(i === 0 ? 1000 : 2500)
          if (ctx?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
          const r = await glmGet(creds, `/files/parser/result/${encodeURIComponent(taskId)}/text`)
          if (r.status === 'succeeded') {
            const content = typeof r.content === 'string' ? r.content : ''
            if (!content) {
              return `(解析完成但无文本内容;下载链接:${String(r.parsing_result_url ?? '无')})`
            }
            return content.length > 12000
              ? content.slice(0, 12000) + `\n…(解析文本过长,已截断到 12000 字符,全文 ${content.length} 字符)`
              : content
          }
          if (r.status === 'failed') {
            throw new Error(`文件解析失败:${String(r.message ?? '未知原因')}`)
          }
          // processing → 继续轮询
        }
        throw new Error(`解析超时(任务 ${taskId} 150s 内未完成;可稍后告知用户稍等,或改用 mode=sync 重试)`)
      },
    },
  ]
}

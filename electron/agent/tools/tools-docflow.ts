/**
 * docflow 域(本机 DocFlow 文档转换服务:探测/自动拉起/doc_convert)
 *
 * 十期自 tools.ts 拆出;disposeDocflow 由 tools.ts disposeTools 转调。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolParams } from '../types'
import { toolOutputDir, toolsRoot } from './tools-env'

/** DocFlow 服务地址(本地 Flask;未运行时 doc_convert 自动拉起) */
const DOCFLOW_BASE = 'http://127.0.0.1:5000'

/** DocFlow 服务进程(自动拉起后持有;disposeTools 关闭,防挂件退出残留) */
let docflowProc: ChildProcess | null = null
/** 并发互斥:多次 doc_convert 并行(executeToolBatch 的 Promise.all)
 * 同时探测失败会拉起多个服务进程——单例 promise,只拉一次 */
let docflowStartPromise: Promise<void> | null = null

/** 探测 DocFlow 服务是否就绪(/api/engine 是现有接口,轻量) */
function probeDocflow(): Promise<boolean> {
  return fetch(`${DOCFLOW_BASE}/api/engine`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false)
}

/**
 * 确保 DocFlow 服务在跑:未运行则**自动拉起**(2026-08-07 改造:
 * 本地构建的 docflow.exe 存在则优先,否则系统 python + server.py),
 * 轮询等待就绪——冻结启动慢(warmup imports + onnxruntime 加载),给 60s
 */
async function ensureDocflowInner(): Promise<void> {
  if (await probeDocflow()) return
  const exe = path.join(toolsRoot(), 'docflow', 'dist', 'docflow', 'docflow.exe')
  const script = path.join(toolsRoot(), 'docflow', 'server.py')
  if (!existsSync(exe) && !existsSync(script)) {
    throw new Error('DocFlow 工具缺失(tools/docflow 未找到)')
  }
  docflowProc = existsSync(exe)
    ? spawn(exe, [], { windowsHide: true, stdio: 'ignore' })
    : spawn('python', [script], { windowsHide: true, stdio: 'ignore', cwd: path.dirname(script) })
  docflowProc.on('exit', () => {
    docflowProc = null
  })
  const deadline = Date.now() + 60_000
  for (;;) {
    if (await probeDocflow()) return
    if (Date.now() > deadline) {
      throw new Error('DocFlow 服务启动超时,请检查 tools/docflow 是否完整')
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

function ensureDocflow(): Promise<void> {
  if (!docflowStartPromise) {
    docflowStartPromise = ensureDocflowInner().finally(() => {
      docflowStartPromise = null
    })
  }
  return docflowStartPromise
}

/** 文档转换:对接本机 DocFlow 服务(上传 → 转换 → 轮询 → 下载) */
export async function docConvert(params: ToolParams): Promise<string> {
  const inputPath = String(params.inputPath ?? '')
  if (!inputPath) throw new Error('inputPath 不能为空')
  if (!existsSync(inputPath)) throw new Error(`文件不存在:${inputPath}`)
  const ext = path.extname(inputPath).toLowerCase()
  if (!['.doc', '.docx', '.pdf'].includes(ext)) throw new Error('仅支持 .doc/.docx/.pdf 文件')
  const target = String(params.target ?? (ext === '.pdf' ? 'docx' : 'pdf'))
  if (!['pdf', 'docx', 'markdown'].includes(target)) throw new Error('target 仅支持 pdf/docx/markdown')
  // 输出目录(2026-08-12):配置了工具输出根目录时缺省 =
  // <根>/doc_convert/[<会话ID>](转换产物按对话分类);未配置保持
  // 原语义 = 输入文件所在目录(LLM 显式传 outputDir 恒优先)
  const outputDir =
    typeof params.outputDir === 'string' && params.outputDir
      ? params.outputDir
      : (toolOutputDir('doc_convert') ?? path.dirname(inputPath))
  const timeoutMs = Math.min(Math.max(Number(params.waitTimeout) || 120, 10), 600) * 1000

  // 1. 服务探测:未运行则自动拉起(2026-08-07——用户无需手动
  // python server.py;优先本地构建的 docflow.exe,否则系统 python)
  await ensureDocflow()

  // 2. 上传(mode=to_markdown 走 Markdown 转换;否则按扩展名自动判定)
  const buf = await fs.readFile(inputPath)
  const fd = new FormData()
  fd.append('files', new Blob([buf]), path.basename(inputPath))
  if (target === 'markdown') fd.append('mode', 'to_markdown')
  const up = await fetch(`${DOCFLOW_BASE}/api/upload`, {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(30000),
  })
  if (!up.ok) throw new Error(`DocFlow 上传失败 HTTP ${up.status}:${(await up.text()).slice(0, 300)}`)
  const upJson = (await up.json()) as { jobs?: Array<{ id: string; name: string }> }
  const jobId = upJson.jobs?.[0]?.id
  if (!jobId) throw new Error('DocFlow 未接受该文件(格式不支持)')

  // 3. 启动转换
  const conv = await fetch(`${DOCFLOW_BASE}/api/convert/${jobId}`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
  })
  if (!conv.ok) throw new Error(`DocFlow 转换启动失败 HTTP ${conv.status}`)

  // 4. 轮询状态
  const started = Date.now()
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('转换超时,请稍后在 DocFlow 页面查看')
    const st = await fetch(`${DOCFLOW_BASE}/api/status/${jobId}`, {
      signal: AbortSignal.timeout(10000),
    }).catch(() => null)
    if (st?.ok) {
      const s = (await st.json()) as { status: string; error?: string | null }
      if (s.status === 'done') break
      if (s.status === 'error') throw new Error(`转换失败:${s.error ?? '未知错误'}`)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }

  // 5. 下载到输出目录
  const dl = await fetch(`${DOCFLOW_BASE}/api/download/${jobId}`, {
    signal: AbortSignal.timeout(60000),
  })
  if (!dl.ok) throw new Error(`DocFlow 下载失败 HTTP ${dl.status}`)
  const outBuf = Buffer.from(await dl.arrayBuffer())
  const outName = `${path.basename(inputPath, ext)}.${target === 'markdown' ? 'md' : target}`
  await fs.mkdir(outputDir, { recursive: true })
  const outPath = path.join(outputDir, outName)
  await fs.writeFile(outPath, outBuf)
  return `转换完成:${outPath}(${outBuf.length} 字节)`
}

/** 关闭自动拉起的 DocFlow 服务(挂件退出时清理,防进程残留) */
export function disposeDocflow(): void {
  if (docflowProc) {
    docflowProc.kill()
    docflowProc = null
  }
}

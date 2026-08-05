/**
 * Agent 工具注册表(模块化)
 *
 * 每个工具 = { name, description, parameters(JSON Schema), execute }。
 * - description + parameters 注入 LLM 上下文,LLM 据此生成参数(过程可知:
 *   执行前参数经 tool-call 事件完整展示给用户);
 * - execute 在本机执行,无沙箱限制(桌面个人助手语义);
 * - 结果经 tool-result 事件回显,并截断后回填 LLM 上下文。
 *
 * 借鉴:MS Agent 参考后端的 UnifiedToolRegistry / Tool 定义,
 * 及 opencode src/tool/registry.ts 的注册语义(这里不引入 zod)。
 */

import { exec, spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Notification, shell } from 'electron'
import type { AgentTool, ToolParams } from './types'

/** xxt 答题脚本绝对路径(MS Agent 工具目录) */
const XXT_SCRIPT = 'C:/Users/asus/Desktop/MS Agent/main-sub-agent-system/tools/xxt/auto_answer.py'
/** bili-tool 二进制绝对路径(B站数据查询,纯 Rust 单二进制;查询命令 --json 输出到 stdout) */
const BILI_BIN = 'C:/Users/asus/Desktop/bilibili/bili-rs/target/release/bili-tool.exe'
/**
 * bili-tool 工作目录(**必须显式固定**):config 的 outdir=downloads 是相对
 * 路径,不指定 cwd 时下载会落在 Electron 的启动目录(打包版可能是
 * System32/exe 目录,用户和 LLM 都找不到);固定到 bili-rs 项目目录,
 * 下载落在 `C:/Users/asus/Desktop/bilibili/bili-rs/downloads/`,
 * 与用户手动使用 bili-tool 的现有下载一致
 */
const BILI_CWD = 'C:/Users/asus/Desktop/bilibili/bili-rs'
/** DocFlow 服务地址(本地 Flask) */
const DOCFLOW_BASE = 'http://127.0.0.1:5000'

/** 解析任务的输出目录(--outdir 参数,相对 BILI_CWD 解析;缺省默认目录);
 * 返回绝对路径,供通知/状态注入/LLM 报告真实落点 */
function biliOutdir(args: string[]): string {
  const i = args.indexOf('--outdir')
  const dir = i >= 0 && args[i + 1] ? args[i + 1] : 'downloads'
  return path.isAbsolute(dir) ? path.normalize(dir) : path.join(BILI_CWD, dir)
}

/** saved 记录里的相对路径 → 绝对路径(相对 BILI_CWD;已是绝对路径则原样) */
function absolutizeBiliPath(rel: string): string {
  const p = rel.trim()
  if (!p || path.isAbsolute(p)) return p
  return path.join(BILI_CWD, p)
}

/** 运行 Python 脚本(收集 stdout,超时杀进程) */
function runPython(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('python', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`脚本执行超时(${Math.round(timeoutMs / 1000)}s)`))
    }, timeoutMs)
    child.on('error', (e: Error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 python:${e.message}(需安装 Python 3.10+)`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(out || err || `(进程退出码 ${code})`)
    })
  })
}

/** 后台 bili-tool 长任务记录(进行中 + 已结束;结束记录保留供状态注入,
 * 让 LLM 对下载完成与否有真实感知——否则完成信息只经系统通知一次性
 * 播报,后续对话中 LLM 仍会惯性回复"还在下载/完成后会通知",实测 bug) */
interface BiliJob {
  pid: number
  startedAt: number
  args: string[]
  /** 是否已结束(close 事件落定;未落定视为进行中) */
  finished: boolean
  exitCode: number | null
  finishedAt: number
  /** 成功后的输出文件绝对路径(close 后查 saved 记录解析;空 = 未查/查不到) */
  outputPaths: string[]
}

/** 后台 bili 任务(完成/失败时发系统通知,用户无需轮询等待) */
const biliJobs = new Map<number, BiliJob>()
/** 已结束记录保留时长(超过后从状态注入清除;进程存续期内存占用可忽略) */
const BILI_JOB_TTL_MS = 24 * 60 * 60 * 1000
/** 进行中任务失联阈值:超过仍无 close,进程可能已被外部终结 */
const BILI_STALE_MS = 6 * 60 * 60 * 1000

/** 清理已结束且超 TTL 的旧记录 */
function pruneBiliJobs(now: number) {
  for (const [pid, job] of biliJobs) {
    if (job.finished && now - job.finishedAt > BILI_JOB_TTL_MS) biliJobs.delete(pid)
  }
}

/** 任务的人话标签与目标(args[0]:get = 单视频、download = UP 批量) */
function biliJobLabel(args: string[]): string {
  const target = args[1] ?? ''
  return args[0] === 'download' ? `UP 主批量下载(${target})` : `视频下载(${target})`
}

/** 全部任务的确定性状态快照(按启动时间排序;文案稳定,不随流逝时间
 * 逐字变化——状态块是系统提示末尾的唯一动态段,状态不变时不产生
 * 序列化抖动,不破坏 DeepSeek 前缀缓存) */
function getBiliJobLines(): string[] {
  const now = Date.now()
  pruneBiliJobs(now)
  const jobs = [...biliJobs.values()].sort((a, b) => a.startedAt - b.startedAt)
  return jobs.map((j) => {
    const label = biliJobLabel(j.args)
    if (!j.finished) {
      // 进行中也带上输出目录:LLM 回答"下载到哪"时能给真实绝对路径
      const outdir = biliOutdir(j.args)
      return now - j.startedAt > BILI_STALE_MS
        ? `- 进行中(进程 ${j.pid},已启动超过 6 小时,进程可能已丢失,可用 bili saved 确认):${label},输出目录 ${outdir}`
        : `- 进行中(进程 ${j.pid}):${label},输出目录 ${outdir}`
    }
    const t = new Date(j.finishedAt)
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    if (j.exitCode !== 0) {
      return `- 已失败(${hm},退出码 ${j.exitCode},进程 ${j.pid}):${label}`
    }
    // 已完成:列出输出文件绝对路径(LLM 据此告知用户视频在哪,
    // 不再"可在下载目录查看"这种含糊说法)
    const files = j.outputPaths ?? []
    return (
      `- 已完成(${hm},进程 ${j.pid}):${label}` +
      (files.length > 0 ? `,文件:\n      ${files.join('\n      ')}` : `,输出目录 ${biliOutdir(j.args)}`)
    )
  })
}

/** 后台 bili 任务状态注入块(引擎追加到系统提示末尾;无任务返回空串)。
 * 让 LLM 回答下载相关问题时依据真实状态,而不是"长任务默认还没好" */
export function getBiliBackgroundStatus(): string {
  const lines = getBiliJobLines()
  if (lines.length === 0) return ''
  return (
    '【后台下载任务状态(最新,以此为准)】\n' +
    lines.join('\n') +
    '\n对话中提及这些下载时按状态如实回答:已完成/已失败就直接说明,不要再"还在下载"或"完成后会通知";进行中才说还在下载。'
  )
}

/**
 * 完成时查询 saved 记录,提取本次输出的文件绝对路径。
 * 记录路径是相对 BILI_CWD 的,必须转绝对路径,否则 LLM/通知
 * 说不清视频落在哪个文件夹(用户实测反馈)。
 * 取最新 limit 条里落在本任务输出目录下的记录(刚完成的文件在最前;
 * 并发任务/手动下载混入时会多报几条,比漏报好)
 */
async function resolveBiliOutputs(job: BiliJob): Promise<string[]> {
  try {
    const out = await runBili(['saved', '--limit', '10'], 15000)
    const outdir = biliOutdir(job.args).toLowerCase()
    const files: string[] = []
    for (const line of out.split('\n')) {
      const i = line.lastIndexOf(' | ')
      if (i === -1) continue
      const abs = absolutizeBiliPath(line.slice(i + 3))
      if (abs.toLowerCase().startsWith(outdir)) files.push(abs)
    }
    return files
  } catch {
    return []
  }
}

/** 后台启动 bili-tool 长任务(视频下载):detached 独立进程,立即返回,
 * 不阻塞对话;完成/失败时发系统通知(下载中查询 saved 没有记录是正常的);
 * 返回文本明确"无需等待",防止 Agent 自行反复轮询造成等待感 */
function runBiliBackground(args: string[]): string {
  try {
    const child = spawn(BILI_BIN, args, { windowsHide: true, stdio: 'ignore', detached: true, cwd: BILI_CWD })
    child.unref()
    const pid = child.pid ?? -1
    biliJobs.set(pid, { pid, startedAt: Date.now(), args, finished: false, exitCode: null, finishedAt: 0, outputPaths: [] })
    child.on('close', (code) => {
      const job = biliJobs.get(pid)
      if (!job) return
      // 状态推进:进行中 → 结束(记录保留供后续状态注入;通知用户收尾)
      job.finished = true
      job.exitCode = code
      job.finishedAt = Date.now()
      const label = biliJobLabel(job.args)
      if (code !== 0) {
        new Notification({
          title: 'B站下载结束',
          body: `${label}异常退出(退出码 ${code}),请用 bili saved 查看记录或重试`,
        }).show()
        return
      }
      // 成功:后台查 saved 记录解析输出文件绝对路径 → 状态注入 + 通知
      void resolveBiliOutputs(job).then((files) => {
        job.outputPaths = files
        const outdir = biliOutdir(job.args)
        const message =
          files.length > 0 ? `${label}已完成:\n${files.join('\n')}` : `${label}已完成,输出目录:${outdir}`
        new Notification({ title: 'B站下载完成', body: message }).show()
        // 后台任务完成回调:引擎转发 background-done → 渲染端自动触发
        // 一轮对话,LLM 主动告知用户下载结果(无需用户主动提问)
        deps.onBackgroundDone?.({ title: 'B站下载完成', message })
      })
    })
    return (
      `已后台启动 bili-tool 下载:${args.join(' ')}(进程 ${pid})。` +
      `输出目录:${biliOutdir(args)}。` +
      '**这是长任务,通常 1-10 分钟,不要等待**:请立即告知用户"下载已开始,完成后会有系统通知";' +
      '完成/失败都会自动发系统通知,不需要反复查询。' +
      '仅当用户主动询问下载进度时,才调用 bili saved 查询下载记录(下载进行中查不到记录是正常的)。'
    )
  } catch (e) {
    throw new Error(`无法启动 bili-tool:${(e as Error).message}(二进制缺失:${BILI_BIN})`)
  }
}

/** 运行 bili-tool(查询类命令,stdout 为 JSON;超时杀进程;
 * cwd 固定 BILI_CWD,saved 记录等相对路径才能按同一基准解析) */
function runBili(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(BILI_BIN, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: BILI_CWD })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`bili-tool 执行超时(${Math.round(timeoutMs / 1000)}s)`))
    }, timeoutMs)
    child.on('error', (e: Error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 bili-tool:${e.message}(二进制缺失:${BILI_BIN})`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(out || err || `(进程退出码 ${code})`)
    })
  })
}

/** B站数据查询(bili-tool 查询命令 --json 输出结构化数据到 stdout) */
async function biliQuery(params: ToolParams): Promise<string> {
  const action = String(params.action ?? '')
  const query = String(params.query ?? '').trim()
  let args: string[] = []
  switch (action) {
    case 'up_info': {
      if (!query) throw new Error('up_info 需要 UP 主 mid 或空间链接')
      args = ['info', query, '--json']
      break
    }
    case 'up_videos': {
      if (!query) throw new Error('up_videos 需要 UP 主 mid')
      args = ['list', query, '--json']
      break
    }
    case 'search': {
      if (!query) throw new Error('search 需要关键词')
      const type = String(params.type ?? 'video')
      if (!['video', 'user', 'bangumi'].includes(type)) {
        throw new Error('type 仅支持 video/user/bangumi')
      }
      args = ['search', query, '--type', type, '--json']
      break
    }
    case 'trending': {
      const rid = Number(params.rid) || 0
      args = ['trending', '--rid', String(rid), '--json']
      break
    }
    case 'comments': {
      if (!query) throw new Error('comments 需要视频 BV 号或链接')
      args = ['comments', query, '--json']
      break
    }
    case 'download': {
      // 单视频下载:长任务后台启动(detached 独立进程),立即返回;
      // 完成情况用 saved action 查询
      if (!query) throw new Error('download 需要视频 BV 号或链接')
      const dargs = ['get', query]
      if (params.audio) dargs.push('--audio', String(params.audio))
      if (params.quality) dargs.push('--quality', String(params.quality))
      if (params.outdir) dargs.push('--outdir', String(params.outdir))
      if (params.page) dargs.push('--page', String(Number(params.page) || 1))
      if (params.subs) dargs.push('--subs')
      if (params.no_danmaku) dargs.push('--no-danmaku')
      return runBiliBackground(dargs)
    }
    case 'download_up': {
      // UP 主视频批量下载:后台启动,立即返回
      if (!query) throw new Error('download_up 需要 UP 主 mid')
      const dargs = ['download', query]
      if (params.limit) dargs.push('--limit', String(Number(params.limit) || 0))
      if (params.days) dargs.push('--days', String(Number(params.days) || 0))
      if (params.regex) dargs.push('--regex', String(params.regex))
      if (params.audio) dargs.push('--audio', String(params.audio))
      if (params.quality) dargs.push('--quality', String(params.quality))
      if (params.outdir) dargs.push('--outdir', String(params.outdir))
      if (params.dry_run) dargs.push('--dry-run')
      return runBiliBackground(dargs)
    }
    case 'danmaku': {
      // 弹幕下载(快,前台等):XML/ASS/TXT/JSON
      if (!query) throw new Error('danmaku 需要视频 BV 号或链接')
      const dargs = ['danmaku', query]
      if (params.format) dargs.push('--fmt', String(params.format))
      return runBili(dargs, 60000)
    }
    case 'subtitle': {
      // CC 字幕下载(srt,前台等)
      if (!query) throw new Error('subtitle 需要视频 BV 号或链接')
      return runBili(['subtitle', query], 60000)
    }
    case 'saved': {
      // 已下载记录(查询后台下载任务是否完成)。
      // 记录里的路径是相对 BILI_CWD 的,逐行转绝对路径——
      // 否则 LLM 看到 downloads\xxx.mp4 不知道真实落点(用户实测反馈)
      const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200)
      const out = await runBili(['saved', '--limit', String(limit)], 30000)
      return out
        .split('\n')
        .map((line) => {
          const i = line.lastIndexOf(' | ')
          if (i === -1) return line
          return line.slice(0, i + 3) + absolutizeBiliPath(line.slice(i + 3))
        })
        .join('\n')
    }
    case 'open': {
      // 搜索并直接打开第一个结果(一次调用完成"搜索+打开",
      // 免去 LLM 解析 JSON 再拼接 BV 链接的中间步骤)。
      // 默认视频 → bvid 拼视频页;type=user → mid 拼 UP 空间页
      if (!query) throw new Error('open 需要搜索关键词')
      const type = String(params.type ?? 'video')
      if (!['video', 'user', 'bangumi'].includes(type)) {
        throw new Error('type 仅支持 video/user/bangumi')
      }
      const json = await runBili(['search', query, '--type', type, '--json'], 30000)
      let items: unknown = null
      try {
        items = JSON.parse(json)
      } catch {
        // 解析失败走下方无结果分支
      }
      const first = Array.isArray(items) && items.length > 0 ? items[0] : null
      const rec = first && typeof first === 'object' ? (first as Record<string, unknown>) : null
      const url =
        type === 'user' && typeof rec?.mid === 'number'
          ? `https://space.bilibili.com/${rec.mid}`
          : typeof rec?.bvid === 'string' && rec.bvid
            ? `https://www.bilibili.com/video/${rec.bvid}`
            : ''
      if (!url) throw new Error(`搜索"${query}"无结果或格式异常,请改用 search 查看`)
      const title =
        typeof rec?.title === 'string' ? rec.title : typeof rec?.name === 'string' ? rec.name : ''
      // 标题自带《》时不重复包裹(如 B站 标题常含书名号)
      const shown = title ? (title.includes('《') ? title : `《${title}》`) : ''
      await shell.openExternal(url)
      return `已打开第一个搜索结果:${shown}\n${url}`
    }
    default:
      throw new Error(
        `未知 action:${action}(支持 up_info/up_videos/search/open/trending/comments/download/download_up/danmaku/subtitle/saved)`,
      )
  }
  return runBili(args, 30000)
}

/** 文档转换:对接本机 DocFlow 服务(上传 → 转换 → 轮询 → 下载) */
async function docConvert(params: ToolParams): Promise<string> {
  const inputPath = String(params.inputPath ?? '')
  if (!inputPath) throw new Error('inputPath 不能为空')
  if (!existsSync(inputPath)) throw new Error(`文件不存在:${inputPath}`)
  const ext = path.extname(inputPath).toLowerCase()
  if (!['.doc', '.docx', '.pdf'].includes(ext)) throw new Error('仅支持 .doc/.docx/.pdf 文件')
  const target = String(params.target ?? (ext === '.pdf' ? 'docx' : 'pdf'))
  if (!['pdf', 'docx', 'markdown'].includes(target)) throw new Error('target 仅支持 pdf/docx/markdown')
  const outputDir =
    typeof params.outputDir === 'string' && params.outputDir ? params.outputDir : path.dirname(inputPath)
  const timeoutMs = Math.min(Math.max(Number(params.waitTimeout) || 120, 10), 600) * 1000

  // 1. 服务探测(DocFlow 需先手动启动:python server.py)
  const probe = await fetch(`${DOCFLOW_BASE}/api/engine`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
  if (!probe || !probe.ok) {
    throw new Error('DocFlow 服务未运行:请在 DocFlow 目录执行 python server.py 启动后重试')
  }

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

/** 工具输出 → LLM 回填的最大长度(参考后端 token 预算治理语义) */
const RESULT_MAX = 8000
/** 目录列举上限 */
const LIST_LIMIT = 200

/** 执行 shell 命令(Windows 走 cmd.exe,shell: true) */
function runCommand(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, _reject) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        shell: true,
      },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter((s) => s && s.trim()).join('\n')
        if (err) {
          // 命令非零退出:输出仍有价值,带错误标记返回,不直接抛
          const code = (err as NodeJS.ErrnoException & { code?: string | number }).code
          resolve(`${out || '(无输出)'}\n[命令退出码 ${code ?? '未知'}]`)
          return
        }
        resolve(out || '(命令完成,无输出)')
      },
    )
  })
}

/** HTML 标签与实体清理 */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Bing 搜索(国内可达;解析 b_algo 结果块) */
async function searchBing(query: string, n: number): Promise<string> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${n}`
  const res = await fetch(url, { headers: { 'User-Agent': SEARCH_UA }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`Bing 返回 HTTP ${res.status}`)
  const html = await res.text()
  const itemRe =
    /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?[\s\S]*?<\/li>/g
  const results: string[] = []
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(html)) && results.length < n) {
    const href = m[1]
    if (!/^https?:\/\//i.test(href)) continue
    const title = stripHtml(m[2])
    const snippet = stripHtml(m[3] ?? '')
    if (!title) continue
    results.push(`${results.length + 1}. ${title}\n   ${href}\n   ${snippet}`)
  }
  if (results.length === 0) throw new Error('Bing 未解析到结果')
  return results.join('\n')
}

/** DuckDuckGo 搜索(回退;国内不可达,部分网络环境可用) */
async function searchDuckDuckGo(query: string, n: number): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'User-Agent': SEARCH_UA }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`DDG 返回 HTTP ${res.status}`)
  const html = await res.text()
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const links: Array<{ href: string; title: string }> = []
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) && links.length < n) {
    const href = m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').replace(/&rut=.*$/, '')
    links.push({ href: decodeURIComponent(href), title: stripHtml(m[2]) })
  }
  const snippets: string[] = []
  while ((m = snippetRe.exec(html)) && snippets.length < n) snippets.push(stripHtml(m[1]))
  if (links.length === 0) throw new Error('DDG 未解析到结果')
  return links.map((l, i) => `${i + 1}. ${l.title}\n   ${l.href}\n   ${snippets[i] ?? ''}`).join('\n')
}

/** 网页搜索(Bing 主用,DDG 回退;均失败给出明确提示) */
async function webSearch(query: string, count: number): Promise<string> {
  const n = Math.min(Math.max(count || 5, 1), 10)
  try {
    return await searchBing(query, n)
  } catch {
    try {
      return await searchDuckDuckGo(query, n)
    } catch {
      return '(搜索服务暂不可达,可稍后重试或换关键词)'
    }
  }
}

/** 模块化工具清单(每次注册都是独立对象,便于后续按需增删) */
export function createTools(deps: {
  onSwitchToMusic(): void
  /**
   * 后台长任务完成回调(如 bili 下载完成):引擎转发为 background-done
   * 事件 → 渲染端自动触发一轮对话,LLM 主动告知用户结果(用户无需
   * 主动提问——实测下载完成后不提问就不知道结果)
   */
  onBackgroundDone?(info: { title: string; message: string }): void
}): AgentTool[] {
  return [
    {
      name: 'exec_command',
      description:
        '在本机执行 shell 命令(Windows:cmd.exe)。无沙箱限制,可操作本机任何内容。' +
        '命令输出会返回给你;非零退出码也会带输出返回。' +
        '适合:查进程、管理文件、运行脚本、系统维护、安装工具等。' +
        '注意:危险命令(删除、格式化、改系统配置)请谨慎执行。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令(如 dir、tasklist 等)' },
          cwd: { type: 'string', description: '工作目录,缺省为用户主目录' },
          timeout: { type: 'number', description: '超时秒数,缺省 30,最大 300' },
        },
        required: ['command'],
      },
      async execute(params: ToolParams) {
        const command = String(params.command ?? '').trim()
        if (!command) throw new Error('command 不能为空')
        const timeout = Math.min(Math.max(Number(params.timeout) || 30, 1), 300) * 1000
        const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : os.homedir()
        return runCommand(command, cwd, timeout)
      },
    },
    {
      name: 'read_file',
      description: '读取本机文件内容(UTF-8 文本)。适合阅读代码、配置、日志等。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          maxChars: { type: 'number', description: '最多返回字符数,缺省 8000' },
        },
        required: ['path'],
      },
      async execute(params: ToolParams) {
        const filePath = String(params.path ?? '')
        if (!filePath) throw new Error('path 不能为空')
        const text = await fs.readFile(filePath, 'utf8')
        const max = Math.min(Math.max(Number(params.maxChars) || RESULT_MAX, 200), 100000)
        return text.length > max ? text.slice(0, max) + `\n…(内容过长,已截断到 ${max} 字符)` : text
      },
    },
    {
      name: 'write_file',
      description: '写入本机文件(UTF-8 文本),目录不存在会自动创建。覆盖已存在内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
        required: ['path', 'content'],
      },
      async execute(params: ToolParams) {
        const filePath = String(params.path ?? '')
        const content = String(params.content ?? '')
        if (!filePath) throw new Error('path 不能为空')
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, content, 'utf8')
        return `已写入 ${filePath}(${Buffer.byteLength(content, 'utf8')} 字节)`
      },
    },
    {
      name: 'list_dir',
      description: '列出目录内容(文件/子目录名,最多 200 条)。适合探查目录结构。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录绝对路径,缺省为用户主目录' },
        },
        required: [],
      },
      async execute(params: ToolParams) {
        const dir = typeof params.path === 'string' && params.path ? params.path : os.homedir()
        const entries = await fs.readdir(dir, { withFileTypes: true })
        const lines = entries.slice(0, LIST_LIMIT).map((e) => (e.isDirectory() ? `[目录] ${e.name}` : e.name))
        if (entries.length > LIST_LIMIT) lines.push(`…(共 ${entries.length} 项,已截断)`)
        return lines.join('\n')
      },
    },
    {
      name: 'open_url',
      description: '用系统默认浏览器打开网址(仅 http/https)。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整网址,如 https://example.com' },
        },
        required: ['url'],
      },
      async execute(params: ToolParams) {
        const raw = String(params.url ?? '').trim()
        if (!/^https?:\/\//i.test(raw)) throw new Error('仅支持 http/https 网址')
        await shell.openExternal(raw)
        return `已用默认浏览器打开 ${raw}`
      },
    },
    {
      name: 'open_file',
      description: '用系统默认程序打开文件或文件夹(如图片、文档、目录)。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件或文件夹绝对路径' },
        },
        required: ['path'],
      },
      async execute(params: ToolParams) {
        const target = String(params.path ?? '')
        if (!target) throw new Error('path 不能为空')
        const errMsg = await shell.openPath(target)
        if (errMsg) throw new Error(`打开失败:${errMsg}`)
        return `已打开 ${target}`
      },
    },
    {
      name: 'web_search',
      description: '联网搜索网页信息(返回标题+链接+摘要列表)。搜索结果可能有限,可多试关键词。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          count: { type: 'number', description: '返回条数,缺省 5,最大 10' },
        },
        required: ['query'],
      },
      async execute(params: ToolParams) {
        return webSearch(String(params.query ?? ''), Number(params.count) || 5)
      },
    },
    {
      name: 'get_time',
      description: '获取当前日期时间(本地时区)。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const now = new Date()
        const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
        return `${now.toLocaleString('zh-CN')} ${weekday}(${Intl.DateTimeFormat().resolvedOptions().timeZone})`
      },
    },
    {
      name: 'system_info',
      description: '获取本机系统信息:操作系统、CPU、内存、运行时长等。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const cpus = os.cpus()
        return [
          `系统:${os.platform()} ${os.release()}(${os.arch()})`,
          `主机:${os.hostname()}`,
          `CPU:${cpus[0]?.model ?? '未知'} × ${cpus.length}`,
          `内存:${(os.totalmem() / 1024 ** 3).toFixed(1)} GB,可用 ${(os.freemem() / 1024 ** 3).toFixed(1)} GB`,
          `运行时长:${Math.floor(os.uptime() / 3600)} 小时`,
          `Node:${process.version}`,
        ].join('\n')
      },
    },
    {
      name: 'notify',
      description: '发送 Windows 系统通知(右下角)。适合提醒、定时通知等场景。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '通知标题' },
          message: { type: 'string', description: '通知正文' },
        },
        required: ['title', 'message'],
      },
      async execute(params: ToolParams) {
        if (!Notification.isSupported()) return '(当前系统不支持通知)'
        new Notification({
          title: String(params.title ?? 'Agent'),
          body: String(params.message ?? ''),
        }).show()
        return '通知已发送'
      },
    },
    {
      name: 'switch_to_music',
      description: '把灵动岛挂件从 Agent 模式切回音乐播放器模式(岛体恢复歌曲/播放控制)。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        deps.onSwitchToMusic()
        return '已切换到音乐模式'
      },
    },
    {
      name: 'doc_convert',
      description:
        '文档格式转换(调用本机 DocFlow 服务):DOC/DOCX→PDF、PDF→DOCX、PDF/DOC/DOCX→Markdown。' +
        '适合文档处理任务。注意:需要 DocFlow 服务已启动(在 DocFlow 目录运行 python server.py)。',
      parameters: {
        type: 'object',
        properties: {
          inputPath: { type: 'string', description: '输入文件绝对路径(支持 .doc/.docx/.pdf)' },
          target: {
            type: 'string',
            enum: ['pdf', 'docx', 'markdown'],
            description: '目标格式;缺省按输入类型自动(pdf→docx、doc/docx→pdf)',
          },
          outputDir: { type: 'string', description: '输出目录,缺省为输入文件所在目录' },
          waitTimeout: { type: 'number', description: '等待转换完成秒数,缺省 120,最大 600' },
        },
        required: ['inputPath'],
      },
      async execute(params: ToolParams) {
        return docConvert(params)
      },
    },
    {
      name: 'xxt',
      description:
        '超星学习通自动答题(调用本机 xxt 工具):login 打开浏览器等待人工登录 / crawl 爬取题目(返回题目 JSON)' +
        '/ fill 填充答案(传 answers JSON)/ check 检查填充状态 / submit 暂存并提交 / screenshot 截图。' +
        '工作流:crawl 获取题目 → Agent 生成答案 → fill 填充 → check 确认 → submit 提交。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['login', 'crawl', 'fill', 'check', 'submit', 'screenshot'],
            description: '操作:login / crawl / fill / check / submit / screenshot',
          },
          url: { type: 'string', description: '作业页面 URL(除 login 外均必填)' },
          answers: {
            type: 'string',
            description: 'fill 时的答案,JSON 字符串,如 {"1":"C","2":"A","3":"答案文本"}',
          },
          output: { type: 'string', description: 'screenshot 的截图保存路径' },
          headless: { type: 'boolean', description: '无头浏览器模式,缺省 false(可见窗口)' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        const actions = ['login', 'crawl', 'fill', 'check', 'submit', 'screenshot']
        if (!actions.includes(action)) throw new Error(`action 仅支持:${actions.join('/')}`)
        const url = String(params.url ?? '')
        if (action !== 'login' && !url) throw new Error('该操作需要 url 参数(作业页面链接)')
        if (!fs.existsSync(XXT_SCRIPT)) {
          throw new Error(`xxt 脚本不存在:${XXT_SCRIPT}`)
        }
        const args = [XXT_SCRIPT, action]
        if (url) args.push('--url', url)
        if (action === 'fill' && params.answers) args.push('--answers', String(params.answers))
        if (action === 'screenshot' && params.output) args.push('--output', String(params.output))
        if (params.headless) args.push('--headless')
        // 浏览器操作耗时较长(登录等待/爬取/填充),给足超时
        const timeoutMs = action === 'login' ? 300000 : 180000
        return runPython(args, timeoutMs)
      },
    },
    {
      name: 'bili',
      description:
        'B站数据查询与视频下载(调用本机 bili-tool,Rust 单二进制,免 Python)。' +
        '查询:up_info 查 UP 主信息(粉丝/关注/投稿/获赞) / up_videos 查 UP 主视频列表 / ' +
        'search 搜索视频/用户/番剧 / open 搜索并直接打开第一个结果(用户说"搜索XX打开第一个"时用它,一次完成;type=user 打开 UP 空间页) / trending 查热门榜(分区 rid:0全站 1动画 3音乐 4游戏 5娱乐 36科技 ' +
        '119鬼畜 129舞蹈 155生活 160时尚 167知识 181影视) / comments 查视频评论区。' +
        '下载:download 下载单个视频 / download_up 批量下载 UP 主视频(可限最近 N 个/正则过滤,支持 --dry-run 先预览) / ' +
        'danmaku 下载弹幕(XML/ASS/TXT/JSON) / subtitle 下载 CC 字幕 / saved 查已下载记录。' +
        '**下载是后台长任务(通常 1-10 分钟)**:启动后立即返回并告知用户"下载已开始",**不要反复轮询 saved 等待**——' +
        '完成/失败会自动发系统通知;仅当用户主动询问进度时才调用 saved。' +
        '清晰度建议:1080p 文件大下载慢,可优先 720p 或仅音频(audio=mp3)。' +
        '**B站 API 限制知识(查询失败时按此判断与答复用户)**:① 接口需要浏览器 UA 与 WBI/App 签名,' +
        '工具已内置(bili-tool 实现 WBI mixin 签名与移动端 appkey 签名);② 游客请求会触发风控——' +
        '热门榜/部分搜索/评论区可能返回 -352 等错误码(IP 风控/限流),对策:降低请求频率、稍后重试、' +
        '更换关键词或分区;③ 高画质(1080P+)、收藏夹、合集等接口需要登录态——bili-tool 可扫码登录(login),' +
        '登录后多数限制解除;④ 下载依赖本机 ffmpeg 与登录态(高画质源);⑤ 部分接口偶发 -400(参数/权限),' +
        '多为接口限制,换用移动端 API 或登录可绕过(工具已内置兜底)。' +
        'mid 可为纯数字或 bilibili 空间链接,BV 号可为链接。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'up_info',
              'up_videos',
              'search',
              'open',
              'trending',
              'comments',
              'download',
              'download_up',
              'danmaku',
              'subtitle',
              'saved',
            ],
            description:
              '操作:up_info/up_videos/search/open/trending/comments(查询)/download(单视频下载)/download_up(UP批量下载)/danmaku(弹幕)/subtitle(字幕)/saved(下载记录)',
          },
          query: {
            type: 'string',
            description:
              '查询/下载目标:UP 主 mid 或空间链接(up_info/up_videos/download_up)、搜索关键词(search)、视频 BV 号或链接(download/comments/danmaku/subtitle);trending/saved 不需要',
          },
          type: {
            type: 'string',
            enum: ['video', 'user', 'bangumi'],
            description: 'search 的搜索类型,缺省 video',
          },
          rid: { type: 'number', description: 'trending 的分区 id,缺省 0(全站)' },
          audio: { type: 'string', description: '仅下载音频并转码为指定格式(如 mp3/flac);不填 = 视频' },
          quality: { type: 'string', description: '视频清晰度(如 1080p/720p/360p),缺省 best' },
          outdir: { type: 'string', description: '下载输出目录,缺省 bili-tool 的 downloads/' },
          page: { type: 'number', description: 'download 多 P 视频的选集页码,缺省 1' },
          subs: { type: 'boolean', description: 'download 同时下载 CC 字幕' },
          no_danmaku: { type: 'boolean', description: 'download 不下载弹幕' },
          limit: { type: 'number', description: 'download_up 只下载最近 N 个视频;saved 显示记录条数(缺省 20)' },
          days: { type: 'number', description: 'download_up 只下载最近 N 天发布的视频' },
          regex: { type: 'string', description: 'download_up 按标题正则过滤(只下载匹配的视频)' },
          dry_run: { type: 'boolean', description: 'download_up 只列出将下载的视频,不实际下载(预览)' },
          format: { type: 'string', enum: ['xml', 'ass', 'txt', 'json'], description: 'danmaku 的输出格式,缺省 xml' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        return biliQuery(params)
      },
    },
  ]
}

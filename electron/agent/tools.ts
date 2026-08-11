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

import { exec, spawn, type ChildProcess } from 'node:child_process'
// 注意:promises 命名空间没有 mkdirSync/existsSync(CLAUDE.md 约定
// "tools.ts 的 fs 只用 promises as fs"——mkdirSync 需单独从 node:fs 导入,
// 曾用 fs.mkdirSync 调 undefined 被空 catch 吞掉,目录从未创建,
// spawn cwd 不存在 → ENOENT,2026-08-08 工具逐一验证实测)
import { existsSync, mkdirSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, Notification, shell } from 'electron'
import { registerTask, setTaskDoneHandler, updateTask } from './tasks'
import type { AgentTool, ToolParams } from './types'

/**
 * 内置工具根目录(2026-08-07 三个外部工具移植进 tools/):
 * 项目根 tools/(cwd = 项目根;不用 __dirname —— agent.cjs
 * 是 CJS 而测试 bundle 是 ESM,__dirname 在 ESM 下不可用(实测报错))
 */
function toolsRoot(): string {
  const res = process.resourcesPath ? path.join(process.resourcesPath, 'tools') : ''
  return res && existsSync(res) ? res : path.resolve(process.cwd(), 'tools')
}

/** 用户数据目录(可写;bili 下载落点 / xxt 登录态 / docflow 运行时产物;
 * = %APPDATA%/dynamic-island;测试回退临时路径) */
function userDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    return path.join(process.env.APPDATA ?? os.homedir(), 'dynamic-island')
  }
}

/** xxt 可执行产物(本地构建的 pyinstaller onedir 在 dist/xxt/ 下;
 * 不存在时回退系统 python + 源码脚本) */
const XXT_EXE = path.join(toolsRoot(), 'xxt', 'dist', 'xxt', 'xxt.exe')
/** xxt 源码脚本(python 模式) */
const XXT_SCRIPT = path.join(toolsRoot(), 'xxt', 'auto_answer.py')
/** bili-tool 二进制(纯 Rust 单二进制;查询命令 --json 输出到 stdout) */
const BILI_BIN = path.join(toolsRoot(), 'bili', 'bili-tool.exe')
/**
 * bili-tool 工作目录(**必须显式固定**):config 的 outdir=downloads 是相对
 * 路径,不指定 cwd 时下载会落在 Electron 的启动目录(用户和 LLM 都找不到);
 * 固定到 userData/bili——下载落在 userData/bili/downloads/
 */
const BILI_CWD = path.join(userDataDir(), 'bili')
/**
 * bili-tool 环境:base_dir 经 BILI_BASE_DIR 指向 userData/bili ——
 * cookies.json/配置落可写目录(登录态与下载同目录,清理一致)
 */
const BILI_ENV = {
  ...process.env,
  BILI_BASE_DIR: BILI_CWD,
}
/** DocFlow 服务地址(本地 Flask;未运行时 doc_convert 自动拉起) */
const DOCFLOW_BASE = 'http://127.0.0.1:5000'

// bili-tool 工作目录必须存在:spawn 的 cwd 不存在会 ENOENT(且被误报为
// "二进制缺失")——download/saved/trending 等分支都直接 spawn,从不创建
// 目录,首次使用必然失败(2026-08-08 工具逐一验证实测);login 分支虽有
// mkdir 但只管二维码路径。模块加载时同步创建(开销可忽略,userData/bili
// 本就是约定落点)。注意 mkdirSync 来自 node:fs 顶层,不是 promises
try {
  mkdirSync(BILI_CWD, { recursive: true })
} catch {
  // 目录创建失败不致命:后续 spawn 会给出真实错误
}

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

/** 运行 xxt 工具(本地构建的 xxt.exe 存在则优先,否则系统 python +
 * 源码脚本;收集 stdout,超时杀进程)。
 * 浏览器登录态/截图目录经环境变量隔离到 userData:原 .browser_profile
 * 含用户登录态,不随仓库分发(2026-08-07 改造) */
function runXxt(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      XXT_PROFILE_DIR: path.join(userDataDir(), 'xxt-profile'),
      XXT_SCREENSHOT_DIR: path.join(userDataDir(), 'xxt-screenshots'),
    }
    const child = existsSync(XXT_EXE)
      ? spawn(XXT_EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      : spawn('python', [XXT_SCRIPT, ...args], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
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
      reject(new Error(`无法启动 xxt:${e.message}(需 Python 3.10+ 或内置 xxt.exe)`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(out || err || `(进程退出码 ${code})`)
    })
  })
}

/** 后台 bili-tool 长任务记录(进行中;close 后即删除——完成信息已写入
 * 通用任务注册表(tasks.ts),状态块/对话感知由它统一提供) */
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

/** 任务的人话标签与目标(args[0]:get = 单视频、download = UP 批量) */
function biliJobLabel(args: string[]): string {
  const target = args[1] ?? ''
  return args[0] === 'download' ? `UP 主批量下载(${target})` : `视频下载(${target})`
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
 * 不阻塞对话;注册到通用任务注册表(tasks.ts)——进行中状态实时注入
 * 系统提示,进入终态(完成/失败)经 done 回调 → background-done →
 * 渲染端自动触发对话,LLM 主动告知用户结果(反馈空间);同时发系统
 * 通知(下载中查询 saved 没有记录是正常的)。
 * 返回文本明确"无需等待",防止 Agent 自行反复轮询造成等待感 */
function runBiliBackground(args: string[]): string {
  try {
    const child = spawn(BILI_BIN, args, {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
      cwd: BILI_CWD,
      env: BILI_ENV,
    })
    child.unref()
    const pid = child.pid ?? -1
    biliJobs.set(pid, { pid, startedAt: Date.now(), args, finished: false, exitCode: null, finishedAt: 0, outputPaths: [] })
    const taskId = `bili-dl-${pid}`
    const outdir = biliOutdir(args)
    registerTask({
      id: taskId,
      title: 'B站下载',
      status: 'running',
      // 进行中也带输出目录:LLM 回答"下载到哪"时能给真实绝对路径
      detail: `${biliJobLabel(args)}(进程 ${pid}),输出目录 ${outdir}`,
    })
    child.on('close', (code) => {
      const job = biliJobs.get(pid)
      if (!job) return
      // 状态推进:进行中 → 结束(记录 close 后即删,终态信息在任务注册表)
      job.finished = true
      job.exitCode = code
      job.finishedAt = Date.now()
      biliJobs.delete(pid)
      const label = biliJobLabel(job.args)
      if (code !== 0) {
        new Notification({
          title: 'B站下载结束',
          body: `${label}异常退出(退出码 ${code}),请用 bili saved 查看记录或重试`,
        }).show()
        // 失败也进入终态 → background-done → 自动对话告知用户(失败
        // 不再"只弹通知",LLM 与用户都在对话里知道结果)
        updateTask(taskId, {
          status: 'failed',
          detail: `${label}异常退出(退出码 ${code}),可用 bili saved 查看记录或重试`,
        })
        return
      }
      // 成功:后台查 saved 记录解析输出文件绝对路径 → 终态 + 通知
      void resolveBiliOutputs(job).then((files) => {
        job.outputPaths = files
        const message =
          files.length > 0 ? `${label}已完成:\n${files.join('\n')}` : `${label}已完成,输出目录:${outdir}`
        new Notification({ title: 'B站下载完成', body: message }).show()
        updateTask(taskId, { status: 'done', detail: message })
      })
    })
    return (
      `已后台启动 bili-tool 下载:${args.join(' ')}(进程 ${pid})。` +
      `输出目录:${biliOutdir(args)}。` +
      '**这是长任务,通常 1-10 分钟,不要等待**:请立即告知用户"下载已开始,完成后会有系统通知";' +
      '完成/失败都会自动发系统通知,并在对话里告知结果,不需要反复查询。' +
      '仅当用户主动询问下载进度时,才调用 bili saved 查询下载记录(下载进行中查不到记录是正常的)。' +
      '**完成后若要播放,用 open_file 打开下载的文件——媒体会作为附件在对话窗口内直接播放**,' +
      '不要切换音乐模式,也不要让用户去文件管理器里找。'
    )
  } catch (e) {
    throw new Error(`无法启动 bili-tool:${(e as Error).message}(二进制缺失:${BILI_BIN})`)
  }
}

/**
 * 后台轮询扫码登录确认(2026-08-07):login 工具生成二维码后立即调用,
 * spawn `bili-tool login --resume <key>` 轮询 poll(最长 120s)——
 * 用户扫码确认后 bili-tool 走 crossDomain 拿 SESSDATA 写 cookies.json;
 * 注册到通用任务注册表(tasks.ts):等待扫码状态实时注入系统提示(LLM
 * 回答"登录好了吗"时依据真实状态),进入终态经 done 回调 →
 * background-done → 自动触发对话。**成功与失败都有对话反馈**(失败不再
 * 只弹通知——LLM 在对话里告知用户"二维码过期,可重新生成")
 */
function startBiliLoginPoll(key: string): void {
  // 每次登录尝试独立任务 id(重新生成二维码时旧尝试的超时/失败不会
  // 覆盖新尝试的状态;同一 key 才会覆盖)
  const taskId = `bili-login-${key}`
  registerTask({
    id: taskId,
    title: 'B站扫码登录',
    status: 'waiting',
    detail: '等待用户扫码确认(二维码 2 分钟内有效)',
  })
  const child = spawn(
    BILI_BIN,
    ['login', '--resume', key, '--timeout', '120'],
    { windowsHide: true, stdio: 'ignore', cwd: BILI_CWD, env: BILI_ENV, detached: true },
  )
  child.unref()
  child.on('exit', (code) => {
    if (code === 0) {
      new Notification({ title: 'B站登录成功', body: '扫码确认完成,已登录 B 站' }).show()
      updateTask(taskId, { status: 'done', detail: '用户已扫码确认,已登录 B 站' })
    } else {
      new Notification({ title: 'B站登录未完成', body: '二维码已过期或未扫码确认,可重新生成' }).show()
      updateTask(taskId, { status: 'failed', detail: '二维码已过期或未扫码确认,可重新生成' })
    }
  })
}

/** 运行 bili-tool(查询类命令,stdout 为 JSON;超时杀进程;
 * cwd 固定 BILI_CWD,saved 记录等相对路径才能按同一基准解析) */
function runBili(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(BILI_BIN, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: BILI_CWD,
      env: BILI_ENV,
    })
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

/** B站数据查询(bili-tool 查询命令 --json 输出结构化数据到 stdout);
 * login 返回文本 + 二维码图片附件(引擎注入助手消息 image part) */
async function biliQuery(params: ToolParams): Promise<string | { text: string; image?: string }> {
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
      // UP 主视频批量下载:后台启动,立即返回。
      // **批量下载必须先征得用户同意(2026-08-10 用户要求)**:经
      // confirmAction 确认门(与 exec_command 确认同款 UI 卡,标题 +
      // 详情),拒绝 = 不启动,返回"用户拒绝"文本(LLM 可告知用户/
      // 改单视频 download)。确认等待期间引擎兜底超时由 bili 工具
      // timeoutMs 覆盖(130s > 确认 120s 超时)
      if (!query) throw new Error('download_up 需要 UP 主 mid')
      const dargs = ['download', query]
      if (params.limit) dargs.push('--limit', String(Number(params.limit) || 0))
      if (params.days) dargs.push('--days', String(Number(params.days) || 0))
      if (params.regex) dargs.push('--regex', String(params.regex))
      if (params.audio) dargs.push('--audio', String(params.audio))
      if (params.quality) dargs.push('--quality', String(params.quality))
      if (params.outdir) dargs.push('--outdir', String(params.outdir))
      if (params.dry_run) dargs.push('--dry-run')
      // 确认门(未注入 = 放行,测试/无 UI 环境):批量下载是占用磁盘与
      // 带宽的动作,LLM 不能未经用户同意就启动
      const confirmDeps = biliConfirmRef.current
      if (confirmDeps) {
        const label = `批量下载 UP 主 ${query} 的视频${params.limit ? `(最近 ${params.limit} 个)` : ''}`
        const approved = await confirmDeps.confirmAction(
          'B站批量下载',
          `${label},将下载到 ${biliOutdir(dargs)}(可能消耗较多磁盘与带宽)。是否继续?`,
        )
        if (!approved) {
          return '用户拒绝了批量下载。请告知用户"已取消批量下载";如需下载单个视频可用 download 指定 BV 号。'
        }
      }
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
    case 'login': {
      // 扫码登录(对话内二维码图片方案,2026-08-07):bili-tool 生成
      // 二维码 PNG(no-wait 不阻塞),返回 **文本 + 图片附件** —— 引擎
      // 注入助手消息 image part,消息气泡直接展示二维码,不依赖 LLM
      // 复述长 base64(实测 LLM 复述不可靠,图片不显示);
      // **后台自动轮询确认**(2026-08-07 修复:原实现只生成二维码,
      // 扫码后无人 poll 写登录态,whoami 永远未登录)——解析 no-wait
      // 输出的 qrcode key,spawn --resume 轮询,成功写 cookies.json 并
      // 通知 + background-done 触发自动对话告知,失败通知重扫
      const qrPath = path.join(BILI_CWD, 'login-qrcode.png')
      await fs.mkdir(path.dirname(qrPath), { recursive: true })
      const genOut = await runBili(['login', '--qrcode-img', qrPath, '--no-wait'], 30000)
      const keyMatch = genOut.match(/二维码key:\s*([A-Za-z0-9]+)/)
      const key = keyMatch?.[1]
      const buf = await fs.readFile(qrPath).catch(() => null)
      if (!buf || buf.length === 0) throw new Error('二维码生成失败')
      if (key) startBiliLoginPoll(key)
      return {
        text:
          'B站扫码登录二维码已生成(2 分钟内有效),二维码图片已随本消息展示给用户。' +
          '请用户用 B 站手机 App「扫一扫」扫码并确认。' +
          (key ? '引擎正在后台等待扫码确认,扫码成功/失败都会自动通知并在对话里告知结果。' : ''),
        image: `data:image/png;base64,${buf.toString('base64')}`,
      }
    }
    case 'whoami': {
      // 登录状态确认(扫码后调用;已登录显示 UID,未登录提示)
      const out = await runBili(['whoami'], 15000)
      return out.trim()
    }
    case 'convert': {
      // 把已有 HEVC(H.265)视频就地转码为 H.264(2026-08-11,修复
      // "bili 下载的 HEVC 视频在对话窗口播放全黑"):挂件窗口的 Chromium
      // 在禁用硬件加速(透明窗口稳定需要)下无法呈现 HEVC 帧;转码后
      // 窗口内直接可播。长任务后台执行(33 分钟 1080p 约 1-2 分钟,
      // 更长视频更久),完成/失败自动通知 + 对话反馈
      if (!query) throw new Error('convert 需要本地视频文件路径')
      return runBiliBackground(['convert', query])
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

/**
 * bili 批量下载确认门(2026-08-10):createTools 注入 deps.confirmAction
 * (引擎 → 主进程 → tool-confirm-request → 渲染端确认卡);biliQuery 是
 * 模块级函数,经 ref 读取当前注入的确认函数(未注入 = 不确认,测试环境)
 */
const biliConfirmRef: { current: { confirmAction: (title: string, detail: string) => Promise<boolean> } | null } = {
  current: null,
}

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

/** 引擎销毁:关闭自动拉起的 DocFlow 服务(挂件退出时清理,防进程残留) */
export function disposeTools(): void {
  if (docflowProc) {
    docflowProc.kill()
    docflowProc = null
  }
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

/** 媒体扩展名 → 媒体类型(open_file / exec_command 媒体拦截共用,
 * 2026-08-08) */
function mediaKindForPath(target: string): 'img' | 'video' | 'audio' | null {
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(target)) return 'img'
  if (/\.(mp4|m4v|mov|webm)$/i.test(target)) return 'video'
  if (/\.(mp3|wav|flac|ogg|oga|opus|m4a|aac)$/i.test(target)) return 'audio'
  return null
}

/**
 * 从 `start` 命令提取媒体文件路径(2026-08-08,exec_command 媒体拦截):
 * LLM 播放视频常用 `start "标题" "C:\x.mp4"`(cmd 引号语义:第一个引号
 * 串是窗口标题)或 `start C:\x.mp4`(裸 token)。返回绝对路径(相对路径
 * 按 cwd 解析);非 start 命令或提取不出媒体路径返回 null
 */
function extractMediaPathFromStart(command: string, cwd: string): string | null {
  const m = /^start\s+/i.exec(command)
  if (!m) return null
  const rest = command.slice(m[0].length).trim()
  if (!rest) return null
  let target = ''
  if (rest.startsWith('"')) {
    // 引号形式:start "标题" "路径"(两段)或 start "路径"(单段——
    // cmd 语义单段是标题,不打开文件,不拦截防误判)
    const q1 = /^"([^"]*)"/.exec(rest)
    if (q1) {
      const after = rest.slice(q1[0].length).trim()
      if (after.startsWith('"')) {
        const q2 = /^"([^"]*)"/.exec(after)
        if (q2) target = q2[1]
      }
    }
  } else {
    target = rest.split(/\s+/)[0]
  }
  if (!target) return null
  return path.isAbsolute(target) ? target : path.resolve(cwd, target)
}

/** 模块化工具清单(每次注册都是独立对象,便于后续按需增删) */
/**
 * 功能引导文档路径(2026-08-10,get_feature_guide 工具):LLM 读取
 * docs/TECH.md(第 11 章 = 功能清单与使用引导)向用户介绍灵动岛功能。
 * 项目根 docs/(cwd;与 toolsRoot() 同款解析)
 */
function guideDocPath(): string {
  const res = process.resourcesPath ? path.join(process.resourcesPath, 'docs', 'TECH.md') : ''
  return res && existsSync(res) ? res : path.resolve(process.cwd(), 'docs', 'TECH.md')
}

/**
 * 系统音量脚本路径(2026-08-10,set_system_volume 工具):winmm
 * waveOutGetVolume/SetVolume 读/写系统主音量。
 * electron/system-volume.ps1(与 smtc-reader.ps1 同目录)
 */
function volumeScriptPath(): string {
  const res = process.resourcesPath ? path.join(process.resourcesPath, 'bridge', 'system-volume.ps1') : ''
  return res && existsSync(res) ? res : path.resolve(process.cwd(), 'electron', 'system-volume.ps1')
}

/** 运行系统音量脚本(get 或 set),返回 stdout;失败抛中文错误(LLM 可自纠) */
function runVolumeScript(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', volumeScriptPath(), ...args],
      { windowsHide: true },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
    })
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(err.trim() || out.trim() || `音量脚本退出码 ${code}`))
      else resolve(out.trim())
    })
    child.on('error', (e) => reject(new Error(`无法启动音量脚本:${e.message}`)))
  })
}

/**
 * 引导文档章节提取(测试用导出):按 `## `(二级标题)切分章节,标题或正文
 * 开头(前 400 字)含 topic 即命中;返回命中章节拼接(每节截 maxChars、
 * 最多 maxSections 节、总长截 maxTotal,防大文档撑爆上下文)。
 * 无 topic → 返回整篇标题树(目录,LLM 据此挑话题再查)。
 */
export function extractGuideSections(
  text: string,
  topic: string,
  opts?: { maxChars?: number; maxSections?: number; maxTotal?: number },
): string {
  const maxChars = opts?.maxChars ?? 2500
  const maxSections = opts?.maxSections ?? 5
  const maxTotal = opts?.maxTotal ?? 8000
  const lines = text.split('\n')
  const sections: Array<{ chapter: string; header: string; body: string }> = []
  const toc: string[] = []
  let chapter = ''
  let cur: { header: string; body: string[] } | null = null
  for (const line of lines) {
    if (line.startsWith('# ')) {
      chapter = line.replace(/^#\s+/, '').trim()
      toc.push(line.replace(/^#\s*/, '').trim())
      continue
    }
    if (line.startsWith('## ')) {
      if (cur) sections.push({ chapter, header: cur.header, body: cur.body.join('\n') })
      cur = { header: line.replace(/^##\s+/, '').trim(), body: [] }
      toc.push(line.replace(/^##\s*/, '').trim())
      continue
    }
    if (cur) cur.body.push(line)
  }
  if (cur) sections.push({ chapter, header: cur.header, body: cur.body.join('\n') })

  const t = topic.trim().toLowerCase()
  if (!t) return toc.join('\n')

  const hit = (s: { chapter: string; header: string; body: string }) =>
    (s.chapter + s.header + s.body.slice(0, 400)).toLowerCase().includes(t)
  const parts: string[] = []
  for (const s of sections.filter(hit)) {
    if (parts.length >= maxSections) break
    const text2 = s.body.length > maxChars ? s.body.slice(0, maxChars) + '\n…(章节过长,已截断)' : s.body
    parts.push(`【${s.chapter} > ${s.header}】\n${text2}`)
  }
  if (parts.length === 0) {
    return `(未找到与「${topic}」相关的章节。可用话题:${toc.slice(0, 40).join(' / ')}…)`
  }
  let out = parts.join('\n\n')
  if (out.length > maxTotal) out = out.slice(0, maxTotal) + '\n…(结果过长,已截断)'
  return out
}

export function createTools(deps: {
  /** play=true = 切换后立即开始播放当前播放列表(2026-08-11) */
  onSwitchToMusic(play?: boolean): void
  /**
   * 后台任务进入终态回调(通用任务注册表,如 bili 下载/扫码登录):
   * 引擎转发为 background-done 事件 → 渲染端自动触发一轮对话,LLM
   * 主动告知用户结果(用户无需主动提问——完成/失败都有对话反馈,
   * 不依赖"发完通知就结束")
   */
  onBackgroundDone?(info: { title: string; message: string }): void
  /**
   * 通用动作确认门(2026-08-10):bili 批量下载启动前征求用户同意;
   * 未注入 = 不确认(测试环境)
   */
  confirmAction?(title: string, detail: string): Promise<boolean>
}): AgentTool[] {
  // bili 批量下载确认门注入(模块级 ref,biliQuery 同步读取)
  biliConfirmRef.current = deps.confirmAction ? { confirmAction: deps.confirmAction } : null
  // 通用任务注册表接线(替代原 bili 专用 bgDone 模块级回调):任何工具
  // 注册的任务进入终态(完成/失败/取消)都走这里 → background-done
  setTaskDoneHandler((task) => {
    const suffix = task.status === 'done' ? '完成' : task.status === 'failed' ? '失败' : '已取消'
    deps.onBackgroundDone?.({ title: `${task.title}${suffix}`, message: task.detail })
  })
  return [
    {
      name: 'exec_command',
      description:
        '在本机执行 shell 命令(Windows:cmd.exe)。无沙箱限制,可操作本机任何内容。' +
        '命令输出会返回给你;非零退出码也会带输出返回。' +
        '适合:查进程、管理文件、运行脚本、系统维护、安装工具等。' +
        '注意:危险命令(删除、格式化、改系统配置)请谨慎执行。' +
        '媒体文件(图片/视频/音频)展示请勿用 start 打开外部播放器——' +
        '媒体会作为附件直接展示在对话窗口内播放,回复时告知用户"已打开"即可。',
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
        // 媒体文件拦截(2026-08-08 修复"LLM 说已开始播放但窗口看不到
        // 气泡"):LLM 常用 `start <媒体文件>` 打开视频——不调外部播放器,
        // 返回媒体附件(media part)窗口内直接播放;与 open_file 同款
        const mediaTarget = extractMediaPathFromStart(command, cwd)
        const mediaKind = mediaTarget ? mediaKindForPath(mediaTarget) : null
        if (mediaKind) {
          // 2026-08-09:start 解析出的媒体路径校验存在(文件名含空格/
          // 引号时裸 token 解析会截断,路径不存在 → 协议 404 → 渲染端
          // 假报"格式不支持")。不存在时抛错引导 LLM 用 open_file 传
          // 完整路径,而不是下发 404 附件
          if (!existsSync(mediaTarget as string)) {
            throw new Error(
              `文件不存在:${mediaTarget}(start 解析的路径可能因空格/引号被截断,` +
                `请改用 open_file 工具传完整绝对路径打开该媒体文件)`,
            )
          }
          return {
            text:
              `媒体文件已就绪(${path.basename(mediaTarget as string)}),已作为附件展示在对话窗口中,` +
              `用户在窗口内直接观看/收听。请在回复中告知用户已打开。`,
            media: [{ kind: mediaKind, url: mediaTarget as string, name: path.basename(mediaTarget as string) }],
          }
        }
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
      description:
        '用系统默认程序打开文件或文件夹(文档、目录等)。' +
        '注意:图片/视频/音频等媒体文件**不会**打开外部播放器——' +
        '媒体会作为附件直接展示在对话窗口内播放,回复时告知用户"已打开"即可。',
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
        // 媒体文件拦截(2026-08-08 用户要求"说打开视频看看,结果打开的是
        // 外部播放器;LLM 回复已播放但窗口看不到视频气泡"):不调
        // shell.openPath 弹外部播放器——返回**媒体附件**(media part),
        // 引擎注入助手消息,渲染端 MediaFrame 窗口内直接播放(不依赖
        // LLM 输出 markdown,实测 LLM 只回"已播放"而不展示)
        const mediaKind = mediaKindForPath(target)
        if (mediaKind) {
          // 2026-08-09 修复"格式正确却报无法播放":LLM 拼路径差一个字
          // (文件名含 ⚡✨""() 空格等特殊字符)时,不存在的路径下发附件
          // → 协议 404 → Chromium 与格式不支持同码(code 4)→ 渲染端
          // 假报"格式不支持"。此处先校验存在,不存在直接抛错回填
          // (LLM 看到"缺什么"可自纠,不再产生 404 假阳性)
          if (!existsSync(target)) {
            throw new Error(`文件不存在:${target}(请先用 list_dir 确认真实文件名再打开,注意特殊字符与空格)`)
          }
          return {
            text:
              `媒体文件已就绪(${path.basename(target)}),已作为附件展示在对话窗口中,` +
              `用户在窗口内直接观看/收听(可拖拽缩放)。请在回复中告知用户已打开。`,
            media: [{ kind: mediaKind, url: target, name: path.basename(target) }],
          }
        }
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
      name: 'get_feature_guide',
      description:
        '读取灵动岛(本程序)内置的功能引导文档,按话题返回相关章节——' +
        '用户问「你有什么功能/你能干什么/这个岛能做什么/XX功能怎么用」时,**先调用本工具**' +
        '了解功能与入口,再结合用户兴趣向用户介绍引导(挑 3-5 个重点,不要一口气列完)。' +
        'topic 给功能/话题关键词(如 "音乐" "B站" "多媒体库" "记忆" "主动陪伴" "设置" "视频"),' +
        '不给 topic 返回文档目录。注意:这是本程序的功能说明,不是外部知识。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '可选:功能/话题关键词,如 "多媒体库"' },
        },
        required: [],
      },
      async execute(params: ToolParams) {
        const topic = String(params.topic ?? '').trim()
        const docPath = guideDocPath()
        if (!existsSync(docPath)) {
          return '(功能引导文档缺失,可向用户介绍:音乐控制 / Agent 对话与本机工具 / 多媒体库 / 个性化外观)'
        }
        const text = await fs.readFile(docPath, 'utf8')
        return extractGuideSections(text, topic)
      },
    },
    {
      name: 'set_system_volume',
      description:
        '读取/设置**系统**主音量(0-100 整数,作用于整个系统,立即生效)。' +
        'action=get 查询当前音量;action=set 设置音量(volume 必填 0-100)。' +
        '适合:用户说"把系统音量调小/调到 50/静音"等。' +
        '注意:这是**系统音量**(所有程序);灵动岛内媒体播放的独立音量' +
        '用 set_video_config 的 volume 参数调(两者互不影响)。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'], description: 'get = 查询当前音量;set = 设置音量(默认 get)' },
          volume: { type: 'number', description: '目标音量 0-100(set 必填),如 50' },
        },
        required: [],
      },
      async execute(params: ToolParams) {
        const action = String(params.action ?? 'get')
        if (action === 'get') {
          const out = await runVolumeScript(['-Action', 'get'])
          const m = /volume=(\d+)/.exec(out)
          return m ? `当前系统音量:${m[1]}%` : `(音量读取异常:${out})`
        }
        if (action !== 'set') throw new Error('action 只能是 get 或 set')
        const vol = Number(params.volume)
        if (!Number.isFinite(vol)) throw new Error('volume 需要是数字(0-100)')
        const v = Math.min(100, Math.max(0, Math.round(vol)))
        const out = await runVolumeScript(['-Action', 'set', '-Value', String(v)])
        const m = /volume=(\d+)/.exec(out)
        return `已将系统音量设置为 ${m ? `${m[1]}%` : `${v}%`}`
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
      description:
        '把灵动岛挂件从 Agent 模式切回音乐播放器模式(岛体恢复歌曲/播放控制)。' +
        '**用户要求"听歌/播放音乐"时必须带 play:true——切换后从当前播放列表开始播放**;' +
        '仅切换模式(用户只想回音乐模式看状态)不带 play。' +
        '播放列表为空时提示用户先添加歌曲,或用 list_audio_library + add_audio_to_playlist 把歌曲加入播放列表再切。',
      parameters: {
        type: 'object',
        properties: {
          play: {
            type: 'boolean',
            description: 'true = 切换到音乐模式后立即开始播放当前播放列表(用户要求听歌/播放时传)',
          },
        },
      },
      async execute(params: ToolParams) {
        const play = params?.play === true
        deps.onSwitchToMusic(play)
        return play ? '已切换到音乐模式并开始播放' : '已切换到音乐模式'
      },
    },
    {
      name: 'doc_convert',
      description:
        '文档格式转换(调用本机 DocFlow 服务):DOC/DOCX→PDF、PDF→DOCX、PDF/DOC/DOCX→Markdown。' +
        '适合文档处理任务。注意:需要 DocFlow 服务已启动(在 DocFlow 目录运行 python server.py)。',
      // 引擎兜底超时覆盖:内部默认等待转换 120s(可到 600s),引擎默认
      // 60s 统一超时会把转换中途杀掉(审计 P0:长超时形同虚设)
      timeoutMs: 200_000,
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
      // 引擎兜底超时覆盖:login 浏览器等人工登录最长 300s,其余 180s;
      // 引擎默认 60s 统一超时会把 login 中途杀掉(审计 P0)
      timeoutMs: 310_000,
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
        if (!existsSync(XXT_EXE) && !existsSync(XXT_SCRIPT)) {
          throw new Error('xxt 工具缺失(tools/xxt 未找到)')
        }
        const args = [action]
        if (url) args.push('--url', url)
        if (action === 'fill' && params.answers) args.push('--answers', String(params.answers))
        if (action === 'screenshot' && params.output) args.push('--output', String(params.output))
        if (params.headless) args.push('--headless')
        // 浏览器操作耗时较长(登录等待/爬取/填充),给足超时
        const timeoutMs = action === 'login' ? 300000 : 180000
        return runXxt(args, timeoutMs)
      },
    },
    {
      name: 'bili',
      // 引擎兜底超时覆盖(2026-08-10):download_up 启动前需经确认门等待
      // 用户选择(120s 超时),引擎默认 60s 会把确认等待中途杀掉
      timeoutMs: 130_000,
      description:
        'B站数据查询与视频下载(调用本机 bili-tool,Rust 单二进制,免 Python)。' +
        '查询:up_info 查 UP 主信息(粉丝/关注/投稿/获赞) / up_videos 查 UP 主视频列表 / ' +
        'search 搜索视频/用户/番剧 / open 搜索并直接打开第一个结果(用户说"搜索XX打开第一个"时用它,一次完成;type=user 打开 UP 空间页) / trending 查热门榜(分区 rid:0全站 1动画 3音乐 4游戏 5娱乐 36科技 ' +
        '119鬼畜 129舞蹈 155生活 160时尚 167知识 181影视) / comments 查视频评论区。' +
        '下载:download 下载单个视频 / download_up 批量下载 UP 主视频(**必须先经用户确认,引擎会弹出确认请求**——' +
        '用户拒绝就停止,改用 download 下载单个;可限最近 N 个/正则过滤,支持 --dry-run 先预览) / ' +
        'danmaku 下载弹幕(XML/ASS/TXT/JSON) / subtitle 下载 CC 字幕 / saved 查已下载记录。' +
        '**扫码登录(2026-08-07)**:login 生成登录二维码图片(对话消息里展示给用户,用户用 B 站手机 App 扫码确认;' +
        '**引擎自动在后台轮询确认,扫码成功/失败都会自动通知并在对话里告知结果,无需再调 whoami**)/ ' +
        'whoami 查询登录状态(登录可解锁高清/收藏夹/合集)。' +
        '**下载是后台长任务(通常 1-10 分钟)**:启动后立即返回并告知用户"下载已开始",**不要反复轮询 saved 等待**——' +
        '完成/失败会自动发系统通知;仅当用户主动询问进度时才调用 saved。' +
        '**下载的音频/视频要播放时,用 open_file 打开输出文件——媒体会作为附件在对话窗口内直接播放**' +
        '(不要切音乐模式,也不要让用户自己去找文件)。' +
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
              'login',
              'whoami',
              'convert',
            ],
            description:
              '操作:up_info/up_videos/search/open/trending/comments(查询)/download(单视频下载)/download_up(UP批量下载)/danmaku(弹幕)/subtitle(字幕)/saved(下载记录)/login(生成扫码登录二维码图片)/whoami(查询登录状态)/convert(把已有 HEVC 视频就地转码为 H.264——窗口内无法播放 HEVC 时的修复手段)',
          },
          query: {
            type: 'string',
            description:
              '查询/下载目标:UP 主 mid 或空间链接(up_info/up_videos/download_up)、搜索关键词(search)、视频 BV 号或链接(download/comments/danmaku/subtitle)、本地视频文件路径(convert);trending/saved 不需要',
          },
          type: {
            type: 'string',
            enum: ['video', 'user', 'bangumi'],
            description: 'search 的搜索类型,缺省 video',
          },
          rid: { type: 'number', description: 'trending 的分区 id,缺省 0(全站)' },
          audio: { type: 'string', description: '仅下载音频并转码为指定格式(如 mp3/flac);不填 = 视频' },
          quality: { type: 'string', description: '视频清晰度(如 1080p/720p/360p),缺省 best;下载的 HEVC(H.265)视频会自动转码为 H.264(对话窗口内可直接播放)' },
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

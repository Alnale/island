/**
 * bili 域(bili-tool 查询/下载:常量、后台任务、扫码登录轮询、biliQuery)
 *
 * 十期自 tools.ts 拆出;tools.ts 的 bili 工具 execute 调 biliQuery,
 * 确认门经 setBiliConfirmAction 注入(createTools deps.confirmAction)。
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { showNotify } from '../notify'
import { listTasks, registerTask, updateTask } from '../tasks'
import type { ToolParams } from '../types'
import { toolOutputDir, userDataDir, toolsRoot } from './tools-env'

/** bili-tool 二进制(纯 Rust 单二进制;查询命令 --json 输出到 stdout) */
export const BILI_BIN = path.join(toolsRoot(), 'bili', 'bili-tool.exe')
/**
 * bili-tool 工作目录(**必须显式固定**):config 的 outdir=downloads 是相对
 * 路径,不指定 cwd 时下载会落在 Electron 的启动目录(用户和 LLM 都找不到);
 * 固定到 userData/bili——下载落在 userData/bili/downloads/
 */
export const BILI_CWD = path.join(userDataDir(), 'bili')
/**
 * bili-tool 环境:base_dir 经 BILI_BASE_DIR 指向 userData/bili ——
 * cookies.json/配置落可写目录(登录态与下载同目录,清理一致)
 */
export const BILI_ENV = {
  ...process.env,
  BILI_BASE_DIR: BILI_CWD,
}

// bili-tool 工作目录必须存在:spawn 的 cwd 不存在会 ENOENT(且被误报为
// "二进制缺失")——download/saved/trending 等分支都直接 spawn,从不创建
// 目录,首次使用必然失败(2026-08-08 工具逐一验证实测);login 分支虽有
// mkdir 但只管二维码路径。模块加载时同步创建(开销可忽略,userData/bili
// 本就是约定落点)。注意 mkdirSync 来自 node:fs 顶层,不是 promises。
// 2026-10-23:清空工具数据/外部删除后目录可能已不存在,每次 spawn 前再
// 确保一次(否则被误报为"bili 工具被删/二进制缺失")。
export function ensureBiliCwd(): void {
  try {
    mkdirSync(BILI_CWD, { recursive: true })
  } catch {
    // 目录创建失败不致命:后续 spawn 会给出真实错误
  }
}
ensureBiliCwd()

// ---------------------------------------------------------------------------
// 登录态整合(2026-09-22 用户反馈"明明登录了,查询收藏夹又说没有登录信息")
//
// 根因三处,统一到本层:
// ① **凭据位置分裂**:挂件内 login 写 userData/bili/config/cookies.json
//    (BILI_BASE_DIR);双击 exe 的 WebUI / qr-login-helper.py 写 **exe 旁
//    config/cookies.json**——挂件看不见,"明明登录了"却处处未登录;
// ② **判定各自为政**:fav 用 whoami 人话正则 `UID\s+(\d+)`(cookie 缺
//    DedeUserID 时 Rust 输出"已登录 (UID )",正则失败被误报"可能未登录")、
//    download 用 `includes('已登录')`、Rust is_logged_in 只查文件有无
//    SESSDATA(**不验有效期**——过期后仍报已登录,API 调用被拒);
// ③ **过期无感知**:SESSDATA 失效后所有提示都含糊("可能未登录")。
//
// 整合:BILI_COOKIE_FILE 单一来源(遗留位置自动收编/退出一并清除)+
// nav 实时探针(isLogin/mid/uname,不解析 whoami 人话)区分 未登录/
// 已过期/缺 UID,全部 action 共用 biliLoginState() 与统一话术。
// ---------------------------------------------------------------------------

/** 登录凭据唯一权威位置(bili-tool 在 BILI_ENV 下读写的同一文件) */
export const BILI_COOKIE_FILE = path.join(BILI_CWD, 'config', 'cookies.json')

/**
 * 历史遗留凭据位置:exe 旁 config/(双击 exe 的 WebUI 登录 /
 * qr-login-helper.py 默认输出目录)与 BILI_CWD 根(早期实验)。
 * 规范位缺 SESSDATA 时自动收编(importBiliCookies)
 */
export const BILI_LEGACY_COOKIE_FILES = [
  path.join(path.dirname(BILI_BIN), 'config', 'cookies.json'),
  path.join(BILI_CWD, 'cookies.json'),
]

/** cookie 文件解析结果(bili-tool / qr-helper 同款扁平 map 格式) */
export interface BiliCookieInfo {
  hasSessdata: boolean
  /** DedeUserID(qr-helper/旧版可能缺失) */
  uid: string
  /** _saved_at 秒级时间戳(qr-helper 旧格式无此字段 → 0) */
  savedAt: number
}

/**
 * cookie 键名规范大小写(2026-09-22 实测**真根因**):登录链路
 * (login.rs crossDomain 合并 / serve.rs WebUI)把 Set-Cookie 键
 * `to_uppercase` 后落盘——文件里是 `DEDEUSERID`/`BILI_JCT`,而 bili-tool
 * 读取端按**精确键名**找 `DedeUserID`/`bili_jct`(login_info/auth_cookie):
 * 全部 miss → whoami 输出"已登录 (UID )"、API 请求缺身份/CSRF 字段。
 * 整合:落盘前把这三个键规范成读取端认的大小写(其余键原样保留)。
 */
const CANONICAL_COOKIE_KEYS = new Map([
  ['sessdata', 'SESSDATA'],
  ['bili_jct', 'bili_jct'],
  ['dedeuserid', 'DedeUserID'],
  ['dedeuserid__ckmd5', 'DedeUserID__ckMd5'],
])

/** 键名大小写规范化(纯函数;返回新对象 + 是否有变化) */
export function normalizeBiliCookieKeys(obj: Record<string, unknown>): {
  obj: Record<string, unknown>
  changed: boolean
} {
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [k, v] of Object.entries(obj)) {
    const canon = CANONICAL_COOKIE_KEYS.get(k.toLowerCase())
    const key = canon ?? k
    if (key !== k) changed = true
    // 同名多大小写变体并存时规范键优先(先到先得,规范化后不再新增变体)
    if (out[key] === undefined) out[key] = v
    else changed = true
  }
  return { obj: out, changed }
}

/** 解析 cookies.json 文本(纯函数;键名大小写不敏感;非法 JSON → null) */
export function parseBiliCookies(raw: string): BiliCookieInfo | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const lower = new Map(Object.entries(v).map(([k, val]) => [k.toLowerCase(), val]))
    const get = (k: string) => {
      const val = lower.get(k.toLowerCase())
      return typeof val === 'string' ? val.trim() : ''
    }
    const savedAt = lower.get('_saved_at')
    return {
      hasSessdata: !!get('SESSDATA'),
      uid: get('DedeUserID'),
      savedAt: typeof savedAt === 'number' ? savedAt : 0,
    }
  } catch {
    return null
  }
}

/**
 * 登录凭据整合(同步,幂等):
 * ① 规范位已有凭据 → **就地规范化键名大小写**(修"已登录 (UID )"根因);
 * ② 规范位缺失 → 从 legacyPaths 挑**有 SESSDATA 且 _saved_at 最新**的一份
 *    收编进来(补 _saved_at 兼容 qr-helper 旧格式),同样规范化。
 * 返回被收编的来源路径(仅迁移时非 null)。
 */
export function consolidateBiliCookies(canonicalPath: string, legacyPaths: string[]): string | null {
  const write = (obj: Record<string, unknown>) => {
    mkdirSync(path.dirname(canonicalPath), { recursive: true })
    writeFileSync(canonicalPath, JSON.stringify(obj, null, 2), 'utf8')
  }
  const read = (p: string) => {
    try {
      const raw = readFileSync(p, 'utf8')
      const info = parseBiliCookies(raw)
      return info && info.hasSessdata ? { p, raw, info } : null
    } catch {
      return null
    }
  }
  const cur = read(canonicalPath)
  if (cur) {
    // ① 就地规范化(幂等:无变化不重写)
    try {
      const { obj, changed } = normalizeBiliCookieKeys(JSON.parse(cur.raw) as Record<string, unknown>)
      if (changed) write(obj)
    } catch {
      // 内容异常:保持原样,由 nav 探针/提示语兜底
    }
    return null
  }
  // ② 遗留收编
  let best: ReturnType<typeof read> = null
  for (const p of legacyPaths) {
    const c = read(p)
    if (c && (!best || c.info.savedAt > best.info.savedAt)) best = c
  }
  if (!best) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(best.raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof obj._saved_at !== 'number') obj._saved_at = best.info.savedAt || Math.floor(Date.now() / 1000)
  try {
    write(normalizeBiliCookieKeys(obj).obj)
    return best.p
  } catch {
    return null
  }
}

// 模块加载即整合一次(键名规范化 + 遗留位置收编;用户此前的凭据立刻可用)
try {
  consolidateBiliCookies(BILI_COOKIE_FILE, BILI_LEGACY_COOKIE_FILES)
} catch {
  // 整合失败不致命:biliLoginState 每次还会重试
}

/** nav 探针结果(bilibili x/web-interface/nav) */
export interface BiliNavProbe {
  isLogin: boolean
  /** 登录用户的 UID(权威;未登录为空) */
  mid: string
  uname: string
}

/** 解析 nav 探针响应(纯函数;结构异常 → null = 未验证) */
export function parseNavProbe(value: unknown): BiliNavProbe | null {
  const root = (value ?? {}) as Record<string, unknown>
  const data = root.data as Record<string, unknown> | undefined
  if (!data || typeof data !== 'object') return null
  const isLogin = data.isLogin === true
  const mid =
    typeof data.mid === 'number' ? String(data.mid) : typeof data.mid === 'string' ? data.mid.trim() : ''
  const uname = typeof data.uname === 'string' ? data.uname : ''
  // -101(账号未登录)也带 data 壳 → 明确按未登录
  if (root.code === -101) return { isLogin: false, mid, uname }
  return { isLogin, mid, uname }
}

/** bili-tool/API 输出是否在说"未登录"(统一识别,含全角标点变体) */
export function biliOutputLooksLoggedOut(text: string): boolean {
  return /未登录|需要登录|请先(?:运行\s*)?login|请先登录|-101/.test(String(text ?? ''))
}

/** 统一登录态快照(全部 bili action 共用) */
export interface BiliLoginState {
  /** 本地有 SESSDATA 凭据 */
  credentialed: boolean
  /** cookie 文件里的 DedeUserID(可能缺) */
  fileUid: string
  /** nav 实时验证:true/false;undefined = 网络失败未验证 */
  live?: boolean
  /** 权威 UID(nav mid 优先,fileUid 兜底;空 = 无法定位"我的收藏夹") */
  uid: string
  uname: string
  /** 统一提示(未登录/已过期/缺 UID);空 = 正常 */
  hint: string
}

/** nav 实时探针(带 SESSDATA 请求;网络失败/解析失败 → null = 未验证) */
async function navProbe(lower: Map<string, string>): Promise<BiliNavProbe | null> {
  try {
    const cookie = [
      `SESSDATA=${lower.get('sessdata') ?? ''}`,
      lower.get('bili_jct') ? `bili_jct=${lower.get('bili_jct')}` : '',
      lower.get('dedeuserid') ? `DedeUserID=${lower.get('dedeuserid')}` : '',
    ]
      .filter(Boolean)
      .join('; ')
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://www.bilibili.com/',
      },
      signal: AbortSignal.timeout(8000),
    })
    return parseNavProbe(await res.json())
  } catch {
    return null
  }
}

/**
 * 统一登录态:收编遗留凭据 → 读 cookie 文件 → nav 实时探针。
 * 判定语义:credentialed = 本地有 SESSDATA;live = 服务端真实登录态
 * (区分"没登录"与"登录已过期");uid = nav mid ∥ DedeUserID。
 */
export async function biliLoginState(): Promise<BiliLoginState> {
  consolidateBiliCookies(BILI_COOKIE_FILE, BILI_LEGACY_COOKIE_FILES)
  const lower = new Map<string, string>()
  try {
    const v = JSON.parse(await fs.readFile(BILI_COOKIE_FILE, 'utf8')) as Record<string, unknown>
    for (const [k, val] of Object.entries(v ?? {})) {
      if (typeof val === 'string') lower.set(k.toLowerCase(), val.trim())
    }
  } catch {
    // 无凭据文件
  }
  const credentialed = !!lower.get('sessdata')
  const fileUid = lower.get('dedeuserid') ?? ''
  if (!credentialed) {
    return {
      credentialed: false,
      fileUid: '',
      uid: '',
      uname: '',
      hint: 'B站未登录(无本地凭据):请先 bili(action=login) 扫码登录——登录后解锁收藏夹/高清画质/AI 字幕。',
    }
  }
  const probe = await navProbe(lower)
  const live = probe ? probe.isLogin : undefined
  const uid = probe?.mid || fileUid
  const uname = probe?.uname ?? ''
  let hint = ''
  if (live === false) {
    hint = 'B站登录已失效(本地有凭据但服务端验证未登录,SESSDATA 过期或被风控):请重新 bili(action=login) 扫码登录。'
  } else if (!uid) {
    hint = 'B站登录凭据缺少用户 ID(DedeUserID),无法定位"我的收藏夹":请重新 bili(action=login) 扫码登录(会覆盖现有凭据)。'
  }
  return { credentialed: true, fileUid, live, uid, uname, hint }
}

/** bili 输出被判定未登录时补统一引导(带过期/未登录精确话术) */
function withLoginGuide(out: string, st: BiliLoginState): string {
  if (!biliOutputLooksLoggedOut(out)) return out
  const guide =
    st.live === false
      ? '登录已失效,请重新 bili(action=login) 扫码登录。'
      : '需要有效登录态,请先 bili(action=login) 扫码登录。'
  return `${out}\n提示:${guide}`
}

/** 解析任务的输出目录(--outdir 参数,相对 BILI_CWD 解析;缺省默认目录);
 * 返回绝对路径,供通知/状态注入/LLM 报告真实落点 */
export function biliOutdir(args: string[]): string {
  const i = args.indexOf('--outdir')
  const dir = i >= 0 && args[i + 1] ? args[i + 1] : 'downloads'
  return path.isAbsolute(dir) ? path.normalize(dir) : path.join(BILI_CWD, dir)
}

/** saved 记录里的相对路径 → 绝对路径(相对 BILI_CWD;已是绝对路径则原样) */
export function absolutizeBiliPath(rel: string): string {
  const p = rel.trim()
  if (!p || path.isAbsolute(p)) return p
  return path.join(BILI_CWD, p)
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
    ensureBiliCwd()
    if (!existsSync(BILI_BIN)) {
      throw new Error(`bili-tool.exe 不存在:${BILI_BIN}(安装包未安装 bili 工具,请重新安装并勾选「哔哩哔哩下载工具」)`)
    }
    // 实时进度(2026-08-11,用户要求"下载到哪了可查"):单视频下载(get)
    // 追加 --progress-file,bili-tool 每 1.5s 原子写进度 JSON;下方轮询器
    // 每 2s 读取,把百分比注入任务状态块(detail)——LLM 对话里直接能
    // 回答"下载到 68%"。批量下载(download_up)任务粒度是"UP 主",进度
    // 文件会被多个分P 互相覆盖,不启用
    const taskIdPrefix = `bili-dl-`
    let progressPath: string | null = null
    let progressTimer: ReturnType<typeof setInterval> | null = null
    if (args[0] === 'get') {
      progressPath = path.join(BILI_CWD, '.progress', `${taskIdPrefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
      mkdirSync(path.dirname(progressPath), { recursive: true })
      args = [...args, '--progress-file', progressPath]
    }
    // 输出落盘(2026-10-23 修复):bili-tool 下载失败时**退出码仍然是 0**
    // (cmd_get 捕获错误后照样返回 Ok,只在 stdout 打 ✗ 行),旧实现 stdio='ignore'
    // 把失败吞掉 —— 引擎于是把失败当成功,通知"B站下载完成"、用户却找不到文件
    // (实测根因还有 bili-tool.exe 被打上 Low Mandatory Level,写 AppData 一律
    // os error 5 拒绝访问)。统一重定向到 .logs,close 时读回判定。
    const logDir = path.join(BILI_CWD, '.logs')
    mkdirSync(logDir, { recursive: true })
    const logPath = path.join(logDir, `bili-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`)
    let logFd = -1
    try {
      logFd = openSync(logPath, 'w')
    } catch {
      logFd = -1
    }
    const childStdio: 'ignore' | Array<'ignore' | number> = logFd >= 0 ? ['ignore', logFd, logFd] : 'ignore'
    const child = spawn(BILI_BIN, args, {
      windowsHide: true,
      stdio: childStdio,
      detached: true,
      cwd: BILI_CWD,
      env: BILI_ENV,
    })
    if (logFd >= 0) {
      try {
        closeSync(logFd)
      } catch {
        // 父进程句柄关闭失败不致命:子进程持有自己的副本继续写
      }
    }
    child.unref()
    const pid = child.pid ?? -1
    biliJobs.set(pid, { pid, startedAt: Date.now(), args, finished: false, exitCode: null, finishedAt: 0, outputPaths: [] })
    const taskId = `${taskIdPrefix}${pid}`
    const outdir = biliOutdir(args)
    registerTask({
      id: taskId,
      title: 'B站下载',
      status: 'running',
      // 进行中也带输出目录:LLM 回答"下载到哪"时能给真实绝对路径
      detail: `${biliJobLabel(args)}(进程 ${pid}),输出目录 ${outdir}`,
      // 发起会话键(2026-08-16):完成通知回到发起下载的会话(主对话外
      // 的会话不再丢消息——事件带此键,渲染端只让该会话实例处理)
      sessionKey: currentBiliSessionKey(),
    })
    // 进度轮询:读 bili-tool 写的进度 JSON → 更新任务 detail(可读化)
    const fmtMb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`
    const progressFile = progressPath
    if (progressFile) {
      progressTimer = setInterval(() => {
        if (biliJobs.get(pid)?.finished) return
        void fs
          .readFile(progressFile, 'utf8')
          .then((text) => {
            const p = JSON.parse(text) as { stage?: string; label?: string; done?: number; total?: number; percent?: number }
            if (!p || typeof p.stage !== 'string') return
            let detail: string
            if (p.stage === 'download' && typeof p.percent === 'number' && p.percent >= 0) {
              detail = `${biliJobLabel(args)} ${p.percent}%(${p.label ?? ''} ${fmtMb(p.done ?? 0)}/${fmtMb(p.total ?? 0)}),输出目录 ${outdir}`
            } else if (p.stage === 'transcode') {
              // 措辞避免"下载完成"——进行中任务仍在转码,LLM 看到"完成"
              // 会提前向用户播报下载结束(2026-10-23 幻觉反馈)
              detail = `${biliJobLabel(args)} 转码中(约需几分钟),输出目录 ${outdir}`
            } else if (p.stage === 'mux') {
              detail = `${biliJobLabel(args)} 合并音视频中,输出目录 ${outdir}`
            } else {
              return
            }
            updateTask(taskId, { detail })
          })
          .catch(() => {
            // 文件未就绪/半截写入:跳过本轮
          })
      }, 2000)
    }
    child.on('close', (code) => {
      if (progressTimer) clearInterval(progressTimer)
      if (progressFile) {
        void fs.rm(progressFile, { force: true }).catch(() => {})
      }
      const job = biliJobs.get(pid)
      if (!job) return
      // 状态推进:进行中 → 结束(记录 close 后即删,终态信息在任务注册表)
      job.finished = true
      job.exitCode = code
      job.finishedAt = Date.now()
      biliJobs.delete(pid)
      const label = biliJobLabel(job.args)
      let logText = ''
      try {
        logText = readFileSync(logPath, 'utf8')
      } catch {
        logText = ''
      }
      // bili-tool 的错误行统一以 ✗ 开头(cmd_get: println!("✗ {bv}: {e}"))
      const errLines = logText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('✗'))
        .slice(0, 3)
        .join(' / ')
      if (code !== 0 || errLines) {
        const reason = errLines || (code !== 0 ? `异常退出(退出码 ${code})` : '未知错误')
        showNotify('B站下载失败', `${label}: ${reason}`)
        // 失败也进入终态 → background-done → 自动对话告知用户(失败
        // 不再"只弹通知",LLM 与用户都在对话里知道结果)
        updateTask(taskId, {
          status: 'failed',
          detail: `${label}失败: ${reason}(日志: ${logPath})`,
        })
        return
      }
      // 成功:后台查 saved 记录解析输出文件绝对路径 → 终态 + 通知
      void fs.rm(logPath, { force: true }).catch(() => {})
      void resolveBiliOutputs(job).then((files) => {
        job.outputPaths = files
        const message =
          files.length > 0 ? `${label}已完成:\n${files.join('\n')}` : `${label}已完成,输出目录:${outdir}`
        showNotify('B站下载完成', message)
        updateTask(taskId, { status: 'done', detail: message })
      })
    })
    return (
      `已后台启动 bili-tool 下载:${args.join(' ')}(进程 ${pid})。` +
      `输出目录:${biliOutdir(args)}。` +
      '**这是长任务,通常 1-10 分钟,不要等待**:请立即告知用户"下载已开始,完成后会有系统通知";' +
      '完成/失败都会自动发系统通知,并在对话里告知结果,不需要反复查询。' +
      '仅当用户主动询问下载进度时,调用 bili progress 查询实时进度(如"下载到 68%")。' +
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
    // 发起会话键(2026-08-16):登录结果通知回到发起登录的会话
    sessionKey: currentBiliSessionKey(),
  })
  ensureBiliCwd()
  const child = spawn(
    BILI_BIN,
    ['login', '--resume', key, '--timeout', '120'],
    { windowsHide: true, stdio: 'ignore', cwd: BILI_CWD, env: BILI_ENV, detached: true },
  )
  child.unref()
  child.on('exit', (code) => {
    if (code === 0) {
      showNotify('B站登录成功', '扫码确认完成,已登录 B 站')
      updateTask(taskId, { status: 'done', detail: '用户已扫码确认,已登录 B 站' })
    } else {
      showNotify('B站登录未完成', '二维码已过期或未扫码确认,可重新生成')
      updateTask(taskId, { status: 'failed', detail: '二维码已过期或未扫码确认,可重新生成' })
    }
  })
}

/** 运行 bili-tool(查询类命令,stdout 为 JSON;超时杀进程;
 * cwd 固定 BILI_CWD,saved 记录等相对路径才能按同一基准解析) */
export function runBili(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    ensureBiliCwd()
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
      // 区分"工具本体缺失"与"工作目录/权限问题",不再一律误报二进制缺失
      const hint = !existsSync(BILI_BIN)
        ? `(工具缺失:${BILI_BIN};请重新安装并勾选「哔哩哔哩下载工具」)`
        : `(工作目录:${BILI_CWD})`
      reject(new Error(`无法启动 bili-tool:${e.message}${hint}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(out || err || `(进程退出码 ${code})`)
    })
  })
}

/** B站数据查询(bili-tool 查询命令 --json 输出结构化数据到 stdout);
 * login 返回文本 + 二维码图片附件(引擎注入助手消息 image part) */
export async function biliQuery(params: ToolParams): Promise<string | { text: string; image?: string }> {
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
    case 'fav': {
      // 收藏夹(2026-08-19;2026-09-22 登录态整合):UID 不再解析 whoami
      // 人话正则(cookie 缺 DedeUserID 时"已登录 (UID )"会误报未登录)——
      // 统一走 biliLoginState(nav mid ∥ DedeUserID),未登录/过期/缺 UID
      // 三种情况各给精确话术;输出若仍被判未登录补统一引导。
      const st = await biliLoginState()
      if (!st.uid || st.live === false) return st.hint
      if (!query) {
        // 只列出收藏夹
        return withLoginGuide(await runBili(['fav', st.uid, '--list'], 30000), st)
      }
      // 下载指定收藏夹(带 query=收藏夹 id 或含 media_id 的链接)
      // 从 query 提取 media_id(纯数字 id 直接可用;链接里提取)
      const mediaMatch = /(?:media_id=)?(\d{3,})/.exec(query)
      const mediaId = mediaMatch ? mediaMatch[1]! : query
      const dargs = ['fav', st.uid, '--download', mediaId]
      if (params.audio) dargs.push('--audio', String(params.audio))
      if (params.quality) dargs.push('--quality', String(params.quality))
      const biliOut = toolOutputDir('bili')
      if (params.outdir) dargs.push('--outdir', String(params.outdir))
      else if (biliOut) dargs.push('--outdir', biliOut)
      return runBiliBackground(dargs)
    }
    case 'download': {
      // 单视频下载:长任务后台启动(detached 独立进程),立即返回;
      // 完成情况用 saved action 查询
      if (!query) throw new Error('download 需要视频 BV 号或链接')
      // 登录提示(2026-08-11;2026-09-22 整合):未登录/已过期高清受限
      // (通常只能 360p/480p),返回文本附精确提示(不阻塞下载)
      let loginHint = ''
      try {
        const st = await biliLoginState()
        if (!st.credentialed) {
          loginHint = '当前未登录,高清画质受限(可能只能下 360p/480p);需要高清可先 bili(action=login) 扫码登录。'
        } else if (st.live === false) {
          loginHint = '登录已失效(SESSDATA 过期),高清画质受限(可能只能下 360p/480p);请重新 bili(action=login) 扫码登录。'
        }
      } catch {
        // 登录态查询失败不阻塞下载
      }
      const dargs = ['get', query]
      if (params.audio) dargs.push('--audio', String(params.audio))
      if (params.quality) dargs.push('--quality', String(params.quality))
      // 输出目录(2026-08-12):LLM 显式传 outdir 恒优先;否则配置了
      // 工具输出根目录时缺省 = <根>/bili/[<会话ID>](下载按对话分类)
      const biliOut = toolOutputDir('bili')
      if (params.outdir) dargs.push('--outdir', String(params.outdir))
      else if (biliOut) dargs.push('--outdir', biliOut)
      if (params.page) dargs.push('--page', String(Number(params.page) || 1))
      if (params.subs) dargs.push('--subs')
      if (params.no_danmaku) dargs.push('--no-danmaku')
      const started = runBiliBackground(dargs)
      return loginHint ? `${started}\n${loginHint}` : started
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
      // 与单视频 download 同款:LLM 显式 outdir 优先,否则输出目录缺省
      const biliOut = toolOutputDir('bili')
      if (params.outdir) dargs.push('--outdir', String(params.outdir))
      else if (biliOut) dargs.push('--outdir', biliOut)
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
    case 'progress': {
      // 实时下载进度(2026-08-11):查询**进行中**的 bili 后台下载任务——
      // detail 由引擎轮询 bili-tool 进度文件持续更新(如"68%")。
      // 2026-10-23:必须过滤终态——终态记录保留 24h,旧实现把"已完成"
      // 也列出来,LLM 每次查询都重新播报"视频下载完毕"(幻觉),用户实测。
      const running = listTasks().filter(
        (t) => t.id.startsWith('bili-dl-') && (t.status === 'running' || t.status === 'waiting'),
      )
      if (running.length === 0) return '当前没有进行中的 bili 下载任务(最近下载完成/失败后已自动告知结果,可用 bili saved 查记录)'
      return running.map((t) => `- ${t.detail}`).join('\n')
    }
    case 'login': {
      // 扫码登录(对话内二维码图片方案,2026-08-07):bili-tool 生成
      // 二维码 PNG(no-wait 不阻塞),返回 **文本 + 图片附件** —— 引擎
      // 注入助手消息 image part,消息气泡直接展示二维码,不依赖 LLM
      // 复述长 base64(实测 LLM 复述不可靠,图片不显示);
      // **后台自动轮询确认**(2026-08-07 修复:原实现只生成二维码,
      // 扫码后无人 poll 写登录态,whoami 永远未登录)——解析 no-wait
      // 输出的 qrcode key,spawn --resume 轮询,成功写 cookies.json 并
      // 通知 + background-done 触发自动对话告知,失败通知重扫。
      // 2026-09-22 整合:已登录时先提示(防误覆盖),凭据落规范位单一来源
      let alreadyNote = ''
      try {
        const st = await biliLoginState()
        if (st.live === true) {
          alreadyNote = `当前已登录 (UID ${st.uid}${st.uname ? ` · ${st.uname}` : ''}),无需重复扫码;继续扫码将覆盖现有登录。`
        }
      } catch {
        // 状态查询失败不影响扫码
      }
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
          (alreadyNote ? `${alreadyNote}\n` : '') +
          'B站扫码登录二维码已生成(2 分钟内有效),二维码图片已随本消息展示给用户。' +
          '请用户用 B 站手机 App「扫一扫」扫码并确认。' +
          (key ? '引擎正在后台等待扫码确认,扫码成功/失败都会自动通知并在对话里告知结果。' : ''),
        image: `data:image/png;base64,${buf.toString('base64')}`,
      }
    }
    case 'whoami': {
      // 登录状态(2026-09-22 整合):不再裸贴 bili-tool 人话——统一
      // biliLoginState(nav 实时验证),精确区分 已登录/已过期/未登录
      const st = await biliLoginState()
      if (!st.credentialed) return st.hint
      if (st.live === false) return st.hint
      const verify = st.live === true ? '实时验证通过' : '本地凭据有效(离线未能实时验证)'
      return `已登录 (UID ${st.uid})${st.uname ? ` · ${st.uname}` : ''}——${verify};凭据 ${BILI_COOKIE_FILE}`
    }
    case 'logout': {
      // 退出登录(2026-09-22 整合):规范位 + 全部遗留位置一并清除
      // (防 exe 旁旧凭据下次又被收编回来)
      const out = await runBili(['logout'], 15000).catch(() => '')
      for (const p of BILI_LEGACY_COOKIE_FILES) {
        await fs.rm(p, { force: true }).catch(() => {})
      }
      return `${out.trim() || '已退出登录'}(本地凭据已清除,含历史遗留位置)——需要时 bili(action=login) 重新扫码。`
    }
    case 'config': {
      // 查看/修改 bili-tool 默认配置(2026-08-11):quality/codec/outdir/
      // jobs/parallel 等持久化在 BILI_CWD/config/config.json——
      // 对话里"以后 B站都下 720p""下载默认转码"即可改,不用手动编辑
      // 文件;校验值域由 bili-tool config 命令完成(错误会直接返回)
      if (params.key) {
        const key = String(params.key).trim()
        if (!key) throw new Error('config 需要 key(如 quality/codec/outdir)')
        const value = String(params.value ?? '').trim()
        if (!value) throw new Error(`config 需要 value(设置 ${key} 的值)`)
        const out = await runBili(['config', '--set', key, value], 15000)
        return out.trim()
      }
      const out = await runBili(['config'], 15000)
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
        `未知 action:${action}(支持 up_info/up_videos/search/open/trending/comments/fav/download/download_up/danmaku/subtitle/saved/progress/login/whoami/logout/convert/config)`,
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

/** 确认门注入(createTools 时调用;null = 不确认,测试环境) */
export function setBiliConfirmAction(fn: ((title: string, detail: string) => Promise<boolean>) | null): void {
  biliConfirmRef.current = fn ? { confirmAction: fn } : null
}

/**
 * 当前会话键 ref(2026-08-16 修复"bili 下载完成消息没有传递到发起会话"):
 * biliQuery 是模块级函数,后台任务注册需要**发起时刻**的会话键——
 * createTools 注入 deps.getSessionKey(引擎 sessionState 服务),任务
 * 完成时 background-done 事件据此回到发起下载的会话(见 tasks.ts
 * AgentTask.sessionKey)。与 biliConfirmRef 同款模式
 */
const biliSessionRef: { current: (() => string | null) | null } = { current: null }

/** 会话键注入(createTools 时调用;null = 无会话键 → 主对话 main) */
export function setBiliSessionKey(fn: (() => string | null) | null): void {
  biliSessionRef.current = fn
}

/** 发起时刻的会话键(任务注册时固定;null = main) */
function currentBiliSessionKey(): string | undefined {
  return biliSessionRef.current?.() || undefined
}

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
 *
 * 细分版图:tools-env(路径环境簇)/ tools-bili(bili 域)/
 * tools-docflow(docflow 域)/ tools-search(联网搜索)/ tools-media(媒体拦截)
 * 已拆出,本文件保留 xxt/系统音量/功能引导/命令执行与 createTools 装配;
 * barrel 兼容 re-export(engine.ts/测试既有路径不变)。
 */


import { exec, spawn } from 'node:child_process'
// 注意:promises 命名空间没有 mkdirSync/existsSync(CLAUDE.md 约定
// "tools.ts 的 fs 只用 promises as fs"——mkdirSync 需单独从 node:fs 导入,
// 曾用 fs.mkdirSync 调 undefined 被空 catch 吞掉,目录从未创建,
// spawn cwd 不存在 → ENOENT,2026-08-08 工具逐一验证实测)
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import { showNotify } from '../notify'
import { setTaskDoneHandler } from '../tasks'
import type { AgentTool, ToolParams } from '../types'
// 已拆出的领域簇:本文件内部仍需使用的部分显式导入(barrel re-export 见下方)
import { webSearch } from './tools-search'
import { extractMediaPathFromStart, mediaKindForPath } from './tools-media'
import { toolsRoot, userDataDir, toolOutputDir, setOutputEnv } from './tools-env'
import { biliQuery, BILI_CWD, setBiliConfirmAction } from './tools-bili'
import { docConvert, disposeDocflow } from './tools-docflow'

// ---- 已拆出簇 barrel 兼容 re-export(engine.ts/测试既有路径不变) ----
export * from './tools-search'
export * from './tools-media'
export * from './tools-env'
export * from './tools-bili'
export * from './tools-docflow'


/**
 * 审计修复(2026-08-14 SEC-2):文件路径安全校验——拦截写入/读取系统
 * 关键目录,防止 LLM 被 prompt injection 诱导操作敏感路径。
 * 仅作为最后防线,桌面助手语义下用户文件操作不受限。
 */
const SENSITIVE_PATH_PATTERNS = [
  /\\Windows\\/i, /\/etc\//, /\/proc\//, /\/sys\//,
  /\\System32\\/i, /\\WinSxS\\/i,
]
function assertPathSafe(filePath: string): void {
  const normalized = path.resolve(filePath)
  for (const pat of SENSITIVE_PATH_PATTERNS) {
    if (pat.test(normalized)) {
      throw new Error(`路径安全校验失败:不允许操作系统关键目录 ${normalized}`)
    }
  }
}

/** xxt 可执行产物(本地构建的 pyinstaller onedir 在 dist/xxt/ 下;
 * 不存在时回退系统 python + 源码脚本) */
const XXT_EXE = path.join(toolsRoot(), 'xxt', 'dist', 'xxt', 'xxt.exe')
/** xxt 源码脚本(python 模式) */
const XXT_SCRIPT = path.join(toolsRoot(), 'xxt', 'auto_answer.py')

/**
 * 本机工具存放路径与用法清单(2026-08-12,用户要求"LLM 不知道各个工具
 * 的存放路径和使用说明"):静态系统提示块——列出内置工具的**绝对路径**
 * + 一句话用法,注入主引擎系统提示(engine.ts),LLM 每轮都知道工具在哪、
 * 怎么用 exec_command 直接操作(查日志/改配置/独立调用),不需要靠猜或
 * 问用户。文案必须**稳定**(系统提示前缀缓存:任何变化都会断缓存前缀)。
 * 路径运行时求值(dev = 项目根,打包 = resourcesPath,与 toolsRoot 同源)。
 */
export function buildToolsGuideBlock(): string {
  const root = toolsRoot()
  const bili = path.join(root, 'bili', 'bili-tool.exe')
  const docflowExe = path.join(root, 'docflow', 'dist', 'docflow', 'docflow.exe')
  const docflowPy = path.join(root, 'docflow', 'server.py')
  const xxtExe = path.join(root, 'xxt', 'dist', 'xxt', 'xxt.exe')
  const xxtPy = path.join(root, 'xxt', 'auto_answer.py')
  const biliCwd = BILI_CWD
  const lines = [
    '【本机工具存放路径与用法】(用 exec_command 可直接操作;引擎内置工具调用不到的需求可在此找到):',
    `- bili 工具(引擎 bili 工具的后端二进制):${bili}。用法:bili-tool <action> [参数] --json,`,
    `  动作 up_info/up_videos/search/open/trending/comments/danmaku/subtitle/download/download_up/saved/progress/login/whoami/config/convert;`,
    `  工作目录 ${biliCwd}(登录态 cookies.json、下载都在这里,下载落 ${path.join(biliCwd, 'downloads')})`,
    `- DocFlow 文档转换服务(引擎 doc_convert 工具的后端):${existsSync(docflowExe) ? docflowExe : docflowPy}(不存在 exe 时用系统 python 跑 server.py)。`,
    `  服务地址 http://127.0.0.1:5000,引擎会自动拉起,一般无需手动`,
    `- xxt 超星学习通工具(引擎 xxt 工具的后端):${existsSync(xxtExe) ? xxtExe : xxtPy}(exe 不存在时用系统 python 跑 auto_answer.py)。`,
    `  子命令 login/crawl/fill/check/submit/screenshot,浏览器走系统 Edge`,
    `- 系统音量脚本:${path.resolve(process.cwd(), 'electron', 'system-volume.ps1')}(引擎 set_system_volume 工具的后端)`,
    `- 长期记忆文件:${path.join(userDataDir(), 'memory.json')}(引擎 remember/list_memory 工具操作它)`,
    `- 功能引导文档:${path.resolve(process.cwd(), 'docs', 'TECH.md')}(第 11 章 = 功能清单,get_feature_guide 工具读取)`,
  ]
  return lines.join('\n')
}

/** 运行 xxt 工具(本地构建的 xxt.exe 存在则优先,否则系统 python +
 * 源码脚本;收集 stdout,超时杀进程)。
 * 浏览器登录态/截图目录经环境变量隔离到 userData:原 .browser_profile
 * 含用户登录态,不随仓库分发(2026-08-07 改造) */
function runXxt(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // 截图输出目录(2026-08-12):配置了工具输出根目录时落到
    // <根>/xxt/[<会话ID>],否则默认 userData/xxt-screenshots
    const xxtOut = toolOutputDir('xxt')
    const env = {
      ...process.env,
      XXT_PROFILE_DIR: path.join(userDataDir(), 'xxt-profile'),
      XXT_SCREENSHOT_DIR: xxtOut ?? path.join(userDataDir(), 'xxt-screenshots'),
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

/** 引擎销毁:清理工具域资源(当前 = 关闭自动拉起的 DocFlow 服务) */
export function disposeTools(): void {
  disposeDocflow()
}


/** 工具输出 → LLM 回填的最大长度(参考后端 token 预算治理语义) */
const RESULT_MAX = 8000
/** 目录列举上限 */
const LIST_LIMIT = 200

/** 执行 shell 命令(Windows 走 cmd.exe,shell: true) */
function runCommand(command: string, cwd: string, timeoutMs: number): Promise<string> {
  // 测试 stub(2026-08-14):AGENT_TEST_STUB_SHELL=1 时不起真实进程——
  // 此前测试里 `start "some title"` 等命令真被 cmd 执行,每次跑测试
  // 都弹一个标题为 some title 的终端窗口;生产不设此变量,零影响
  if (process.env.AGENT_TEST_STUB_SHELL === '1') {
    return Promise.resolve(`(测试 stub,命令未真实执行:${command})`)
  }
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
          // (ExecException.code 是 number、ErrnoException.code 是 string,
          // 两类型不充分重叠无法交叉 cast,收窄为 unknown 字段探测)
          const errLike = err as { code?: unknown; signal?: unknown }
          resolve(`${out || '(无输出)'}\n[命令退出码 ${errLike.code ?? errLike.signal ?? '未知'}]`)
          return
        }
        resolve(out || '(命令完成,无输出)')
      },
    )
  })
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
  /**
   * 工具输出根目录(2026-08-12):Agent 配置 agent.outputDir(空 = 未启用);
   * getSessionId = 当前会话 ID(send 时更新)。产出文件按
   * <根>/<工具名>/[<会话ID>] 存放,未注入保持默认位置
   */
  getOutputDir?(): string | null
  getSessionId?(): string | null
}): AgentTool[] {
  // 工具输出目录环境注入(tools-env 模块级,工具执行时读取)
  setOutputEnv({
    getOutputDir: deps.getOutputDir ?? (() => null),
    getSessionId: deps.getSessionId ?? (() => null),
  })
  // bili 批量下载确认门注入(tools-bili 模块级 ref,biliQuery 同步读取)
  setBiliConfirmAction(deps.confirmAction ?? null)
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
        assertPathSafe(filePath) // 审计 SEC-2:拦截系统关键目录
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
        assertPathSafe(filePath) // 审计 SEC-2:拦截系统关键目录
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
        '媒体会作为附件直接展示在对话窗口内播放,回复时告知用户"已打开"即可。' +
        '**用户要求"听歌/放首歌/播音乐"时默认用本工具打开音频在对话窗口内播放**,' +
        '不要切音乐模式;只有用户明确说"切到音乐模式播放"时才用 switch_to_music。',
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
        showNotify(String(params.title ?? 'Agent'), String(params.message ?? ''))
        return '通知已发送'
      },
    },
    {
      name: 'switch_to_music',
      description:
        '把灵动岛挂件从 Agent 模式切回音乐播放器模式(岛体恢复歌曲/播放控制)。' +
        '**仅在用户明确要求切换到音乐模式时调用**(如"切到音乐模式""用音乐模式放")——' +
        '用户说"听歌/放首歌/播音乐"默认是让本助手播放,**默认用 open_file 打开音频在对话窗口内直接播放,不要切音乐模式**;' +
        'play:true = 用户明确要求切过去后立即开始播放当前播放列表;' +
        '仅切换模式(用户只想回音乐模式看状态)不带 play。' +
        '播放列表为空时提示用户先添加歌曲,或用 list_audio_library + add_audio_to_playlist 把歌曲加入播放列表再切。',
      parameters: {
        type: 'object',
        properties: {
          play: {
            type: 'boolean',
            description: 'true = 切换到音乐模式后立即开始播放当前播放列表(用户明确要求切过去并播放时传)',
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
          outputDir: {
            type: 'string',
            description:
              '输出目录,缺省 = 工具输出目录(设置里配置后为 输出根/doc_convert/当前对话ID,转换产物按对话分类);未配置输出目录时缺省为输入文件所在目录',
          },
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
          output: {
            type: 'string',
            description:
              'screenshot 的截图保存路径;缺省 = 工具输出目录(设置里配置后为 输出根/xxt/当前对话ID/截图.png,截图按对话分类);未配置时保存到默认截图目录',
          },
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
              'progress',
              'login',
              'whoami',
              'convert',
              'config',
            ],
            description:
              '操作:up_info/up_videos/search/open/trending/comments(查询)/download(单视频下载)/download_up(UP批量下载)/danmaku(弹幕)/subtitle(字幕)/saved(下载记录)/progress(查询进行中下载的实时进度,如"68%")/login(生成扫码登录二维码图片)/whoami(查询登录状态)/convert(把已有 HEVC/AV1 视频就地转码为 H.264——窗口内无法播放时的修复手段)/config(查看/修改 bili 默认配置,如清晰度 quality/codec/输出目录 outdir)',
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
          outdir: {
            type: 'string',
            description:
              '下载输出目录;缺省 = 工具输出目录(设置里配置后为 输出根/bili/当前对话ID,下载按对话分类);未配置输出目录时缺省 bili-tool 的 downloads/',
          },
          page: { type: 'number', description: 'download 多 P 视频的选集页码,缺省 1' },
          subs: { type: 'boolean', description: 'download 同时下载 CC 字幕' },
          no_danmaku: { type: 'boolean', description: 'download 不下载弹幕' },
          limit: { type: 'number', description: 'download_up 只下载最近 N 个视频;saved 显示记录条数(缺省 20)' },
          days: { type: 'number', description: 'download_up 只下载最近 N 天发布的视频' },
          regex: { type: 'string', description: 'download_up 按标题正则过滤(只下载匹配的视频)' },
          dry_run: { type: 'boolean', description: 'download_up 只列出将下载的视频,不实际下载(预览)' },
          format: { type: 'string', enum: ['xml', 'ass', 'txt', 'json'], description: 'danmaku 的输出格式,缺省 xml' },
          key: { type: 'string', description: 'config 要查看/修改的配置项(quality/codec/outdir/jobs/parallel/audio 等;不填 = 查看当前全部配置)' },
          value: { type: 'string', description: 'config 设置的值(quality: 480/720/1080/2160/best;codec: auto/copy;outdir: 目录路径)' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        return biliQuery(params)
      },
    },
  ]
}

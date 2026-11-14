/**
 * 电脑操控工具簇(2026-10-22):computer
 *
 * 一个工具四个动作:window_list(列可见窗口)/ window_shot(窗口完整截图)/
 * window_focus(窗口置前)/ screen_shot(整屏截图,多显示器拼接)。
 * 后端 = electron/window-shot.ps1(与 system-volume.ps1 同目录同款解析:
 * 打包 resourcesPath/bridge/,开发 cwd/electron/),PowerShell P/Invoke。
 *
 * 截图完整性保证(2026-10-22 用户实测"截图残缺"根因):此前 LLM 用
 * exec_command 手写 PowerShell 截屏,进程未声明 DPI 感知时 GetWindowRect
 * 返回逻辑像素、位图按逻辑尺寸分配,150% 缩放下只截到窗口左上 ~380x640
 * 物理像素(窗口实际 570x960)——右 1/3、下 1/3 被裁。后端脚本进程内
 * Per-Monitor V2 DPI 感知,坐标与位图统一物理像素,标题栏/四边完整;
 * PrintWindow(PW_RENDERFULLCONTENT) 遮挡下也能拿到完整渲染,并裁掉
 * Win10+ 隐形调整边框(= DWM 可见边框,"窗口原样")。
 *
 * 输出契约:截图 PNG 落盘(工具输出目录分类),返回文本 + image 附件
 * (data URL,引擎注入助手消息 image part,对话内直接展示;QQ 远程会话
 * 回复里带文件路径即自动发图,extractImageRefs 发图兜底)。
 */

import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { toolOutputDir, userDataDir } from './tools-env'
import type { AgentTool, ToolParams } from '../types'

/**
 * 后端脚本路径(与 tools.ts volumeScriptPath 同款解析):
 * 打包 = resourcesPath/bridge/window-shot.ps1;开发 = cwd/electron/
 */
export function windowShotScriptPath(): string {
  const res = process.resourcesPath ? path.join(process.resourcesPath, 'bridge', 'window-shot.ps1') : ''
  return res && existsSync(res) ? res : path.resolve(process.cwd(), 'electron', 'window-shot.ps1')
}

/** 窗口条目(后端 -Mode list 的 JSON 元素) */
export interface WindowEntry {
  hwnd: number
  title: string
  x: number
  y: number
  width: number
  height: number
  dpi: number
  minimized: boolean
}

/** 后端 JSON 解析(空输出/坏输出走错误,调用方转中文错误回 LLM;测试导出) */
export function parseJsonOutput(raw: string, fallbackError: string): unknown {
  const text = raw.trim()
  if (!text) throw new Error(fallbackError)
  // PowerShell 可能带 BOM/ANSI 前缀噪声:截取首个 { 或 [ 起的 JSON 段
  const start = Math.min(
    ...[text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0),
  )
  if (!Number.isFinite(start)) throw new Error(`${fallbackError}:${text.slice(0, 200)}`)
  return JSON.parse(text.slice(start))
}

/**
 * 运行后端脚本,解析 JSON 结果。参数:mode('list'|'shot'|'focus'|'screen')
 * + title/hwnd/output。超时 30s(截图含置前等待,通常 <3s)。
 */
export function runWindowShotScript(args: {
  mode: 'list' | 'shot' | 'focus' | 'screen'
  title?: string
  hwnd?: number
  output?: string
}): Promise<Record<string, unknown>> {
  const script = windowShotScriptPath()
  if (!existsSync(script)) {
    return Promise.reject(new Error(`电脑操控脚本缺失:${script}(window-shot.ps1)。安装不完整,请重装或从仓库恢复 electron/window-shot.ps1`))
  }
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', args.mode]
  if (args.title) argv.push('-Title', args.title)
  if (args.hwnd) argv.push('-Hwnd', String(args.hwnd))
  if (args.output) argv.push('-Output', args.output)
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', argv, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('window-shot.ps1 超时(30s)'))
    }, 30_000)
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 PowerShell:${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        const parsed = parseJsonOutput(out, `window-shot.ps1 无有效输出(退出码 ${code}${err.trim() ? `;stderr:${err.trim().slice(0, 200)}` : ''})`) as Record<string, unknown>
        if (parsed.ok === false) {
          reject(new Error(String(parsed.error ?? 'window-shot.ps1 执行失败')))
          return
        }
        resolve(parsed)
      } catch (e) {
        reject(e as Error)
      }
    })
  })
}

/** PNG → data URL(image 附件);读不到文件抛中文错误 */
async function imageDataUrl(file: string): Promise<string> {
  const buf = await fs.readFile(file).catch(() => null)
  if (!buf || buf.length === 0) throw new Error(`截图文件读取失败:${file}`)
  return `data:image/png;base64,${buf.toString('base64')}`
}

/** 截图默认落点:配置了工具输出根 = <根>/computer/[<会话ID>],否则 userData/computer-shots */
function shotOutputPath(name: string): string {
  const dir = toolOutputDir('computer') ?? path.join(userDataDir(), 'computer-shots')
  return path.join(dir, name)
}

const ACTIONS = ['window_list', 'window_shot', 'window_focus', 'screen_shot'] as const

/**
 * computer 工具(单工具多动作,与 bili/xxt 同款风格)。
 * 无宿主依赖(纯本机 PowerShell),任何引擎装配即用。
 */
export function createComputerTools(): AgentTool[] {
  const computerTool: AgentTool = {
    name: 'computer',
    timeoutMs: 40_000,
    description:
      '电脑操控:窗口管理与截图(Windows)。动作:window_list 列出可见窗口(标题/位置/尺寸/句柄)/ ' +
      'window_shot 截取指定窗口的**完整截图**(标题栏与四边框完整、任何系统缩放/多显示器都不裁切;窗口被遮挡也能截)/ ' +
      'window_focus 把窗口还原并置前 / screen_shot 截整个屏幕(多显示器拼接)。' +
      '**截图/看窗口/发窗口截图类请求一律用本工具,禁止用 exec_command 手写 PowerShell/Python 截屏**——' +
      '手写截屏在系统缩放 125%/150% 下会把窗口右边和下边裁掉(用户实测"截图残缺"就是这么来的),本工具已处理 DPI 完整性。' +
      '截图结果自动作为图片附件在对话里展示给用户;text 里带输出文件路径,QQ 会话把路径写进回复即自动发图(或 napcat image=路径)。' +
      '定位窗口:title 填标题子串(如"米家扫码登录");有多个候选或找不到时先 window_list 看精确标题,也可以直接传返回的 hwnd。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'window_list=列窗口 / window_shot=窗口截图 / window_focus=窗口置前 / screen_shot=整屏截图',
        },
        title: {
          type: 'string',
          description: '窗口标题子串(window_list 的可选过滤;window_shot/window_focus 的目标窗口,与 hwnd 二选一)',
        },
        hwnd: {
          type: 'number',
          description: '窗口句柄(window_list 返回),精确指定目标窗口时优先于 title',
        },
        output: {
          type: 'string',
          description: '截图保存路径;缺省 = 工具输出目录(设置里配置后为 输出根/computer/当前对话ID/,未配置时 userData/computer-shots/)',
        },
      },
      required: ['action'],
    },
    async execute(params: ToolParams) {
      const action = String(params.action ?? '')
      if (!(ACTIONS as readonly string[]).includes(action)) {
        throw new Error(`未知 action:${action}(可用 ${ACTIONS.join('/')})`)
      }
      const title = typeof params.title === 'string' ? params.title.trim() : ''
      const hwnd = Number(params.hwnd) || 0

      if (action === 'window_list') {
        const res = await runWindowShotScript({ mode: 'list' })
        let wins = res as unknown as WindowEntry[]
        if (!Array.isArray(wins)) wins = wins ? [wins as unknown as WindowEntry] : []
        if (title) wins = wins.filter((w) => w.title.toLowerCase().includes(title.toLowerCase()))
        if (wins.length === 0) {
          return title ? `没有标题含「${title}」的可见窗口;先 window_list 不带 title 看全部标题` : '当前没有带标题的可见窗口'
        }
        const lines = wins.slice(0, 50).map(
          (w) =>
            `「${w.title}」 句柄 ${w.hwnd} 位置(${w.x},${w.y}) 尺寸 ${w.width}x${w.height}` +
            ` DPI ${w.dpi}${w.minimized ? ' (最小化)' : ''}`,
        )
        const more = wins.length > 50 ? `\n(共 ${wins.length} 个,只列前 50)` : ''
        return `可见窗口 ${wins.length} 个:\n${lines.join('\n')}${more}`
      }

      if (action === 'window_focus') {
        if (!title && !hwnd) throw new Error('window_focus 需要 title(标题子串)或 hwnd')
        const res = await runWindowShotScript({ mode: 'focus', title: title || undefined, hwnd: hwnd || undefined })
        return `已把窗口「${res.title}」还原(若最小化)并置前`
      }

      if (action === 'window_shot') {
        if (!title && !hwnd) throw new Error('window_shot 需要 title(标题子串)或 hwnd')
        const out =
          typeof params.output === 'string' && params.output.trim()
            ? params.output.trim()
            : shotOutputPath(`window-${Date.now()}.png`)
        const res = await runWindowShotScript({ mode: 'shot', title: title || undefined, hwnd: hwnd || undefined, output: out })
        const file = String(res.output ?? out)
        const image = await imageDataUrl(file)
        return {
          text:
            `已截取窗口「${res.title}」完整截图(${res.width}x${res.height} 物理像素,标题栏与四边框完整,不裁切)。\n` +
            `文件:${file}\n` +
            '截图已作为图片附件展示给用户;发 QQ 时把上面文件路径写进回复即可自动发图(或 napcat image=该路径)。',
          image,
        }
      }

      // screen_shot
      const out =
        typeof params.output === 'string' && params.output.trim()
          ? params.output.trim()
          : shotOutputPath(`screen-${Date.now()}.png`)
      const res = await runWindowShotScript({ mode: 'screen', output: out })
      const file = String(res.output ?? out)
      const image = await imageDataUrl(file)
      return {
        text:
          `已截取整屏(${res.width}x${res.height},含全部显示器拼接)。\n文件:${file}\n` +
          '截图已作为图片附件展示给用户;发 QQ 时把上面文件路径写进回复即可自动发图(或 napcat image=该路径)。',
        image,
      }
    },
  }
  return [computerTool]
}

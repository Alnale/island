/**
 * NapCat 扫码登录小窗管理器(2026-09-22)
 *
 * 用户实测病灶:「QQ 一直显示过期,且扫上了,也说没扫上」——NapCat WebUI
 * 把过期登录码原样挂在屏幕上(不换新、不提示),扫到的都是死码;截图/
 * 转发的二维码落地即死。本管理器提供实时登录小窗:
 *   托盘「QQ 扫码登录…」/ LLM 工具 napcat login → 打开小窗
 *   小窗永远展示**新鲜码**(到期前自动换)+ 秒级状态轮询(等待扫码/
 *   服务端提示/登录成功),成功自动关窗 + 通知。
 *
 * 主窗口安全基线同款(显式 sandbox/contextIsolation);页面矩阵经
 * encodeQr(agent.cjs 零依赖 QR 编码器,已与 python qrcode 对拍)生成。
 */
const { BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')

const TTL_SEC = 105 // 展示有效期(真实有效期约 120s,提前换不死码)

/**
 * WebUI 地址候选(2026-10-22):NapCat webui.json 的 host 常配成 "::" ——
 * Windows 上可能只监听 IPv6,死连 127.0.0.1 会 "fetch failed"(用户截图根因
 * 之一)。这里按配置 host → 127.0.0.1 → [::1] 给出候选,登录流逐个尝试。
 */
function webuiBaseUrls(host, port) {
  const p = Number(port) || 6099
  const urls = []
  const add = (u) => {
    if (u && !urls.includes(u)) urls.push(u)
  }
  const h = String(host || '').trim()
  if (h && h !== '::' && h !== '0.0.0.0' && h !== '*') {
    const hostPart = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h
    add(`http://${hostPart}:${p}`)
  }
  add(`http://127.0.0.1:${p}`)
  add(`http://[::1]:${p}`)
  return urls
}

/**
 * WebUI 配置自动发现(2026-10-22 起同时读 host/port,不再只会拼死 6099):
 * 环境变量 → 常见 NapCat 安装目录的 webui.json。返回第一个带 token 的配置
 * 的地址候选;没有 token 时也返回地址(供小窗错误文案显示实际连接目标)。
 */
function findWebuiConfig() {
  const envToken = (process.env.NAPCAT_WEBUI_TOKEN || '').trim()
  const envUrl = (process.env.NAPCAT_WEBUI_URL || '').trim()
  const home = os.homedir()
  const napcatHome = (process.env.NAPCAT_HOME || '').trim()
  const appData = (process.env.APPDATA || '').trim()
  const localAppData = (process.env.LOCALAPPDATA || '').trim()
  const candidates = [
    napcatHome && path.join(napcatHome, 'config', 'webui.json'),
    napcatHome && path.join(napcatHome, 'napcat', 'config', 'webui.json'),
    path.join(home, 'NapCatQQNode', 'napcat', 'config', 'webui.json'),
    path.join(home, 'NapCatQQNode', 'config', 'webui.json'),
    path.join(home, 'NapCatQQ', 'config', 'webui.json'),
    appData && path.join(appData, 'NapCat', 'config', 'webui.json'),
    localAppData && path.join(localAppData, 'NapCat', 'config', 'webui.json'),
  ].filter(Boolean)

  let fileToken = ''
  let source = ''
  let fileBaseUrls = []
  for (const p of candidates) {
    let j = null
    try {
      j = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {
      continue // 下一个候选
    }
    if (!j || typeof j !== 'object') continue
    const urls = webuiBaseUrls(j.host, j.port)
    if (fileBaseUrls.length === 0 && urls.length) fileBaseUrls = urls
    const tk = typeof j.token === 'string' ? j.token.trim() : ''
    if (tk) {
      fileToken = tk
      source = p
      if (urls.length) fileBaseUrls = urls
      break // 第一个带 token 的安装 = 用户当前用的那份
    }
  }

  const envBase = envUrl ? [envUrl.replace(/\/+$/, '')] : []
  const baseUrls = envBase.length
    ? envBase
    : fileBaseUrls.length
      ? fileBaseUrls
      : webuiBaseUrls('127.0.0.1', 6099)
  return {
    token: envToken || fileToken,
    baseUrl: baseUrls[0],
    baseUrls,
    source: envToken ? 'NAPCAT_WEBUI_TOKEN' : source,
  }
}

/** 兼容旧调用:只要 token(2026-10-22 起请用 findWebuiConfig) */
function findWebuiToken() {
  return findWebuiConfig().token
}

/**
 * 创建登录管理器。deps:
 * - agentEngineModule:agent.cjs 导出(createNapcatLoginFlow/encodeQr)
 * - showNotify(title, body, priority?):系统通知统一出口
 */
function createNapcatLogin(deps) {
  let win = null
  let flow = null
  let lastState = null
  let ipcBound = false

  const pushState = (state) => {
    lastState = state
    // QR 矩阵现场编码(失败不致命——页面保留旧图并显示状态文本)
    let qr = null
    try {
      if (state.phase === 'waiting' && state.qrUrl) {
        const m = deps.agentEngineModule.encodeQr(state.qrUrl)
        qr = {
          size: m.size,
          rows: m.modules.map((row) => row.map((v) => (v ? '1' : '0')).join('')),
        }
      }
    } catch (err) {
      console.warn('[napcat-login] QR 编码失败:', err?.message || err)
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('napcat-login:state', { ...state, qr, ttlSec: TTL_SEC })
    }
    if (state.phase === 'done') {
      try {
        deps.showNotify('🐳 QQ 登录成功', 'NapCat 机器人已登录,OneBot(3001)随即可用', 'high')
      } catch {
        // 通知失败不影响登录
      }
      setTimeout(() => close(), 1600)
    }
  }

  const startFlow = (token) => {
    if (flow) flow.stop()
    const cfg = findWebuiConfig()
    const tk = (typeof token === 'string' && token.trim()) || cfg.token
    if (!tk) {
      pushState({ phase: 'error', qrUrl: '', ageSec: 0, remainSec: 0, message: '未找到 WebUI token(检查 NapCat 配置 webui.json),可在下方粘贴后点「开始」' })
      return
    }
    flow = deps.agentEngineModule.createNapcatLoginFlow({
      token: tk,
      baseUrl: cfg.baseUrl,
      baseUrls: cfg.baseUrls,
      ttlSec: TTL_SEC,
      sha256Hex: (t) => crypto.createHash('sha256').update(t).digest('hex'),
      onUpdate: pushState,
    })
    void flow.start()
  }

  const bindIpc = () => {
    if (ipcBound) return
    ipcBound = true
    ipcMain.on('napcat-login:ready', () => {
      // 页面就绪:重推最近状态(打开即有图)
      if (lastState) {
        const st = lastState
        lastState = null
        pushState(st)
      }
    })
    ipcMain.on('napcat-login:start', (_e, token) => startFlow(typeof token === 'string' ? token : ''))
    ipcMain.on('napcat-login:refresh', () => {
      void flow?.refresh()
    })
    ipcMain.on('napcat-login:minimize', () => {
      if (win && !win.isDestroyed()) win.minimize()
    })
    ipcMain.on('napcat-login:close', () => {
      if (win && !win.isDestroyed()) win.close()
    })
  }

  const open = () => {
    if (win && !win.isDestroyed()) {
      win.focus()
      return
    }
    bindIpc()
    win = new BrowserWindow({
      width: 380,
      height: 640,
      minWidth: 340,
      minHeight: 560,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      // 无边框 + 自绘窗口控件(2026-09-22 用户要求:原生标题栏控件太丑)——
      // 最小化/关闭画在小窗头部右上,body 自带 -webkit-app-region: drag 拖拽
      frame: false,
      title: 'QQ 扫码登录',
      backgroundColor: '#080a0e',
      webPreferences: {
        preload: path.join(__dirname, 'napcat-login-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    })
    win.on('closed', () => {
      win = null
      if (flow) flow.stop()
      flow = null
      lastState = null
    })
    void win.loadFile(path.join(__dirname, 'napcat-login.html'))
    startFlow('')
  }

  const close = () => {
    if (flow) flow.stop()
    flow = null
    if (win && !win.isDestroyed()) win.close()
    win = null
  }

  return {
    open,
    close,
    isOpen: () => !!(win && !win.isDestroyed()),
  }
}

module.exports = { createNapcatLogin, findWebuiConfig, findWebuiToken, webuiBaseUrls }

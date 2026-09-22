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

/** WebUI token 自动发现:环境变量 → 常见 NapCat 安装目录的 webui.json */
function findWebuiToken() {
  const env = process.env.NAPCAT_WEBUI_TOKEN
  if (env && env.trim()) return env.trim()
  const home = os.homedir()
  const candidates = [
    path.join(home, 'NapCatQQNode', 'napcat', 'config', 'webui.json'),
    path.join(home, 'NapCatQQNode', 'config', 'webui.json'),
    path.join(home, 'NapCatQQ', 'config', 'webui.json'),
    path.join(process.env.APPDATA || '', 'NapCat', 'config', 'webui.json'),
  ]
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (j && typeof j.token === 'string' && j.token.trim()) return j.token.trim()
    } catch {
      // 下一个候选
    }
  }
  return ''
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
    const tk = (typeof token === 'string' && token.trim()) || findWebuiToken()
    if (!tk) {
      pushState({ phase: 'error', qrUrl: '', ageSec: 0, remainSec: 0, message: '未找到 WebUI token(检查 NapCat 配置 webui.json),可在下方粘贴后点「开始」' })
      return
    }
    flow = deps.agentEngineModule.createNapcatLoginFlow({
      token: tk,
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

module.exports = { createNapcatLogin, findWebuiToken }

/**
 * 米家扫码登录小窗管理器(2026-09-22)
 *
 * 小米 passport QR 登录流(避开密码登录的 captcha + 邮件 2FA):
 *   托盘「米家登录…」/ LLM 工具 mijia login → 打开小窗
 *   小窗展示服务端 QR 图源(qr 字段,权威码源;图源失败回退手编矩阵画
 *   loginUrl)+ 到期自动换码 + 秒级长轮询;扫码确认后自动换 serviceToken
 *   → 凭证经 mijia-store DPAPI 加密落盘 → 通知 + 自动关窗。
 *
 * 状态机 = agent.cjs 的 createMijiaLoginFlow(纯逻辑,三契约同款 napcat:
 * 过期码不落屏 / 轮询驱动换码 / 错误态「换一张」= 整体重试)。
 * 主窗口安全基线同款(显式 sandbox/contextIsolation)。
 */
const { BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const crypto = require('node:crypto')

/**
 * 创建米家登录管理器。deps:
 * - agentEngineModule:agent.cjs 导出(createMijiaLoginFlow/createMijiaCloud/
 *   createMijiaStore/encodeQr)
 * - showNotify(title, body, priority?):系统通知统一出口
 */
function createMijiaLogin(deps) {
  let win = null
  let flow = null
  let lastState = null
  let ipcBound = false
  let currentRegion = 'cn'
  let store = null

  const getStore = () => {
    if (!store) store = deps.agentEngineModule.createMijiaStore()
    return store
  }

  const pushState = (state) => {
    lastState = state
    // QR 矩阵现场编码(服务端图源 qrImage 的回退渲染;失败不致命)
    let qr = null
    try {
      if (state.phase === 'waiting' && state.qrText) {
        const m = deps.agentEngineModule.encodeQr(state.qrText)
        qr = {
          size: m.size,
          rows: m.modules.map((row) => row.map((v) => (v ? '1' : '0')).join('')),
        }
      }
    } catch (err) {
      console.warn('[mijia-login] QR 编码失败:', err?.message || err)
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('mijia-login:state', { ...state, qr, ttlSec: 240 })
    }
    if (state.phase === 'done') {
      try {
        deps.showNotify('🐳 米家登录成功', '小米账号已登录,岛灵可以控制米家设备了', 'high')
      } catch {
        // 通知失败不影响登录
      }
      setTimeout(() => close(), 1600)
    }
  }

  const startFlow = (region) => {
    if (flow) flow.stop()
    if (typeof region === 'string' && region.trim()) currentRegion = region.trim()
    const cloud = deps.agentEngineModule.createMijiaCloud()
    flow = deps.agentEngineModule.createMijiaLoginFlow({
      cloud,
      ttlSec: 240,
      onUpdate: pushState,
      onCredentials: async (a) => {
        // 凭证落盘:mijia-store 经 safeStorage enc:v1: 密文(LM 永不可见)
        await getStore().saveAuth({
          userId: String(a.userId ?? ''),
          cUserId: String(a.cUserId ?? ''),
          ssecurity: String(a.ssecurity ?? ''),
          passToken: String(a.passToken ?? ''),
          serviceToken: String(a.serviceToken ?? ''),
          region: currentRegion,
          deviceId: crypto.randomBytes(8).toString('hex'),
          updatedAt: Date.now(),
        })
      },
    })
    void flow.start()
  }

  const bindIpc = () => {
    if (ipcBound) return
    ipcBound = true
    ipcMain.on('mijia-login:ready', () => {
      // 页面就绪:重推最近状态(打开即有图)
      if (lastState) {
        const st = lastState
        lastState = null
        pushState(st)
      }
    })
    ipcMain.on('mijia-login:start', (_e, region) => startFlow(typeof region === 'string' ? region : ''))
    ipcMain.on('mijia-login:refresh', () => {
      void flow?.refresh()
    })
    ipcMain.on('mijia-login:minimize', () => {
      if (win && !win.isDestroyed()) win.minimize()
    })
    ipcMain.on('mijia-login:close', () => {
      if (win && !win.isDestroyed()) win.close()
    })
  }

  const open = (region) => {
    if (typeof region === 'string' && region.trim()) currentRegion = region.trim()
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
      // 无边框 + 自绘窗口控件(与 napcat-login 同款视觉)
      frame: false,
      title: '米家扫码登录',
      backgroundColor: '#080a0e',
      webPreferences: {
        preload: path.join(__dirname, 'mijia-login-preload.cjs'),
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
    void win.loadFile(path.join(__dirname, 'mijia-login.html'))
    startFlow(currentRegion)
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

module.exports = { createMijiaLogin }

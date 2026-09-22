/**
 * NapCat 扫码登录小窗预览(开发验证用,2026-09-22)
 *
 * 直连本机 NapCat WebUI 真实出码,渲染 napcat-login.html 并截图,
 * 用于验证:① /api 前缀修复后二维码真的画出来了;② 小窗 UI 三态;
 * ③ 无边框自绘窗口控件。
 *
 * 用法:node scripts/build-electron.mjs 后
 *   npx electron tests/preview-napcat-login.cjs [输出png路径]
 * 3.5s 后自动截图退出(截图默认 tests/napcat-login-preview.png)。
 */
const { app, BrowserWindow } = require('electron')
// 预览专用:软件渲染下 capturePage 稳定(GPU 合成偶发 UnknownVizError,实测)
app.disableHardwareAcceleration()
const path = require('node:path')
const fs = require('node:fs')
const { createNapcatLogin } = require('../electron/napcat-login.cjs')
const agentEngineModule = require('../electron/agent.cjs')

const outPng = process.argv[2] || path.join(__dirname, 'napcat-login-preview.png')
const log = (line) => console.log(line)
app.on('window-all-closed', () => log('[preview] window-all-closed(全部窗口已关,应用将退出)'))

app.whenReady().then(() => {
  log('[preview] app ready')
  const mgr = createNapcatLogin({
    agentEngineModule,
    showNotify: () => {},
  })
  mgr.open()
  log('[preview] open() 完成,窗口数=' + BrowserWindow.getAllWindows().length)
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    win.on('closed', () => log('[preview] 窗口 closed'))
    win.webContents.on('render-process-gone', (_e, d) => log('[preview] render-process-gone: ' + JSON.stringify(d)))
    win.webContents.on('console-message', (_e, level, msg) => log(`[renderer] ${msg}`))
    win.webContents.on('did-fail-load', (_e, code, desc) => log(`[preview] did-fail-load: ${code} ${desc}`))
    win.webContents.on('did-finish-load', () => log('[preview] 页面加载完成'))
  }
  setTimeout(async () => {
    log('[preview] 3.5s 到,准备截图')
    const w = BrowserWindow.getAllWindows()[0]
    if (!w) {
      log('[preview] 登录窗未打开')
      app.exit(1)
      return
    }
    // 置顶可见:窗口被完全遮挡时合成器不出帧,capturePage 报 UnknownVizError(实测)
    w.setAlwaysOnTop(true)
    w.show()
    w.focus()
    await new Promise((r) => setTimeout(r, 400))
    let saved = false
    for (let i = 0; i < 4 && !saved; i++) {
      try {
        const img = await w.webContents.capturePage()
        fs.writeFileSync(outPng, img.toPNG())
        log(`[preview] screenshot saved: ${outPng}`)
        saved = true
      } catch (err) {
        log(`[preview] 截图失败(${i + 1}/4): ${err?.message || err}`)
        await new Promise((r) => setTimeout(r, 600))
      }
    }
    if (!saved) {
      // 像素拿不到就转储 DOM 状态,逻辑仍可验证
      try {
        const dump = await w.webContents.executeJavaScript(
          `JSON.stringify({
            qrShown: document.getElementById('qr').classList.contains('show'),
            placeholder: document.getElementById('placeholder').classList.contains('show'),
            status: document.getElementById('status').textContent,
            chip: document.getElementById('chipText').textContent,
            hasMin: !!document.getElementById('btnMin'),
            hasClose: !!document.getElementById('btnClose'),
            hasWebuiBtn: !!document.getElementById('btnWebui'),
          })`,
        )
        log('[preview] DOM dump: ' + dump)
      } catch (err) {
        log('[preview] DOM dump 失败: ' + (err?.message || err))
      }
    }
    setTimeout(() => app.exit(0), 300) // 让 stdio 刷出去再退
  }, 3500)
})

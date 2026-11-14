/**
 * 米家扫码登录小窗预览/常驻(开发验证用,2026-10-22)
 *
 * 打开**真实**的米家扫码登录小窗(mijia-login.cjs + createMijiaLoginFlow
 * 真实出码),窗口保持打开(不自动退出),用于:
 * ① 配合 electron/window-shot.ps1(computer 工具后端)验证窗口截图完整性
 *    ——标题栏/四边框/二维码四角/底部倒计时不裁切(DPI 感知实测);
 * ② 人工扫码登录:米家 App 扫窗内实时码(码 240s 自动换新,截图码会过期,
 *    扫屏上实时码最稳)。
 *
 * 用法:node scripts/build-electron.mjs 后
 *   npx electron tests/preview-mijia-login.cjs [region]
 * 关窗即退出;登录成功窗口自动关闭(与产品行为一致,凭证落共享存储,
 * 登录态对主应用同样生效)。
 */
const { app, BrowserWindow } = require('electron')
const { createMijiaLogin } = require('../electron/mijia-login.cjs')
const agentEngineModule = require('../electron/agent.cjs')

const region = process.argv[2] || ''
const log = (line) => console.log(line)

app.on('window-all-closed', () => {
  log('[preview] window-all-closed,退出')
  app.quit()
})

app.whenReady().then(() => {
  log('[preview] app ready')
  const mgr = createMijiaLogin({
    agentEngineModule,
    showNotify: (title, body) => log(`[notify] ${title} ${body}`),
  })
  mgr.open(region)
  log('[preview] open() 完成,窗口数=' + BrowserWindow.getAllWindows().length)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    log('[preview] 登录窗未打开')
    app.exit(1)
    return
  }
  win.on('closed', () => log('[preview] 窗口 closed'))
  win.webContents.on('did-finish-load', () => log('[preview] 页面加载完成'))
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`[preview] did-fail-load: ${code} ${desc}`))
  win.webContents.on('console-message', (_e, _level, msg) => log(`[renderer] ${msg}`))
  // 置前可见:既是扫码体验(实时码在屏幕中间),也让 BitBlt 兜底截取生效
  win.setAlwaysOnTop(true)
  win.show()
  win.focus()
})

// NapCat 扫码登录小窗 preload(2026-09-22):页面 ↔ 主进程的最小 IPC 面
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('napcatLogin', {
  /** 页面就绪(主进程开始推状态) */
  ready() {
    ipcRenderer.send('napcat-login:ready')
  },
  /** 状态推送(含 QR 矩阵 rows:['0101'...]) */
  onState(cb) {
    const fn = (_e, state) => cb(state)
    ipcRenderer.on('napcat-login:state', fn)
    return () => ipcRenderer.removeListener('napcat-login:state', fn)
  },
  /** (重新)启动登录流;token 空 = 主进程自动读配置 */
  start(token) {
    ipcRenderer.send('napcat-login:start', typeof token === 'string' ? token : '')
  },
  /** 手动换一张 */
  refresh() {
    ipcRenderer.send('napcat-login:refresh')
  },
  /** 最小化窗口(自绘标题栏 —) */
  minimize() {
    ipcRenderer.send('napcat-login:minimize')
  },
  /** 关闭窗口(自绘标题栏 ✕) */
  close() {
    ipcRenderer.send('napcat-login:close')
  },
})

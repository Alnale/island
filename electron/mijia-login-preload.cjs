// 米家扫码登录小窗 preload(2026-09-22):页面 ↔ 主进程的最小 IPC 面
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mijiaLogin', {
  /** 页面就绪(主进程开始推状态) */
  ready() {
    ipcRenderer.send('mijia-login:ready')
  },
  /** 状态推送(qrImage 服务端图源 + qr 矩阵 rows:['0101'...]) */
  onState(cb) {
    const fn = (_e, state) => cb(state)
    ipcRenderer.on('mijia-login:state', fn)
    return () => ipcRenderer.removeListener('mijia-login:state', fn)
  },
  /** (重新)启动登录流;region 如 'cn'/'de' */
  start(region) {
    ipcRenderer.send('mijia-login:start', typeof region === 'string' ? region : '')
  },
  /** 手动换一张 */
  refresh() {
    ipcRenderer.send('mijia-login:refresh')
  },
  /** 最小化窗口(自绘标题栏 —) */
  minimize() {
    ipcRenderer.send('mijia-login:minimize')
  },
  /** 关闭窗口(自绘标题栏 ✕) */
  close() {
    ipcRenderer.send('mijia-login:close')
  },
})

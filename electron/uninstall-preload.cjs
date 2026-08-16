/**
 * 灵动岛卸载向导 —— 预加载脚本
 * 以 contextBridge 暴露最小卸载器 API,渲染端(uninstall.html)零 Node 依赖。
 * 由 electron.exe --uninstall 启动加载(见 main.cjs runUninstaller)。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('uninstaller', {
  /** 卸载信息:应用名/版本/安装目录/个人数据目录/是否存在个人数据 */
  getInfo() {
    return ipcRenderer.invoke('unins:info')
  },
  /** 执行卸载(opts: {deleteData});返回 {ok, installDir?, error?} */
  run(opts) {
    return ipcRenderer.invoke('unins:run', opts)
  },
  /** 完成卸载:延迟删除安装目录后退出应用 */
  finish() {
    return ipcRenderer.invoke('unins:finish')
  },
  /** 取消卸载:直接退出,不删除安装目录 */
  cancel() {
    return ipcRenderer.invoke('unins:cancel')
  },
  /** 卸载进度订阅(返回取消函数):{percent, title?, stage?, file?} */
  onProgress(callback) {
    const listener = (_event, p) => callback(p)
    ipcRenderer.on('unins:progress', listener)
    return () => ipcRenderer.removeListener('unins:progress', listener)
  },
  minimize() {
    ipcRenderer.send('unins:minimize')
  },
})

/**
 * 灵动岛安装管理器 —— 预加载脚本
 * 以 contextBridge 暴露最小 API,渲染端(installer.html / uninstall.html)零 Node 依赖。
 * installer / uninstaller 两个命名空间沿用原向导接口;manager 提供模式切换。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('installer', {
  /** 安装器信息:应用名/版本/默认安装目录/发布产物是否存在/已安装位置 */
  getInfo() {
    return ipcRenderer.invoke('inst:info')
  },
  /** 选择安装目录(系统对话框;返回 null = 取消) */
  pickDir() {
    return ipcRenderer.invoke('inst:pick-dir')
  },
  /** 列出发布包内可选安装的外部工具:[{id, name, desc}] */
  listTools() {
    return ipcRenderer.invoke('inst:tools')
  },
  /** 执行安装(opts: {dir, desktop, startMenu, autostart, tools:[]});返回 {ok, dir?, error?} */
  install(opts) {
    return ipcRenderer.invoke('inst:run', opts)
  },
  /** 完成/启动:launch = true 启动应用后退出 */
  finish(launch) {
    return ipcRenderer.invoke('inst:finish', launch === true)
  },
  /** 安装进度订阅(返回取消函数):{percent, title?, stage?, file?, log?, logCls?} */
  onProgress(callback) {
    const listener = (_event, p) => callback(p)
    ipcRenderer.on('inst:progress', listener)
    return () => ipcRenderer.removeListener('inst:progress', listener)
  },
  minimize() {
    ipcRenderer.send('inst:minimize')
  },
  close() {
    ipcRenderer.send('inst:close')
  },
})

contextBridge.exposeInMainWorld('uninstaller', {
  /** 卸载信息:应用名/版本/安装目录/个人数据目录/是否存在个人数据/可否切换安装 */
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

contextBridge.exposeInMainWorld('manager', {
  /** 当前模式与可切换方向:{mode, installed, installDir, canSwitchToInstall, canSwitchToUninstall} */
  getContext() {
    return ipcRenderer.invoke('mgr:context')
  },
  /** 切换安装/卸载界面('install' | 'uninstall') */
  switchMode(target) {
    return ipcRenderer.invoke('mgr:switch-mode', target)
  },
})

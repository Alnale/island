/**
 * 灵动岛安装向导 —— 预加载脚本
 * 以 contextBridge 暴露最小安装器 API,渲染端(installer.html)零 Node 依赖。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('installer', {
  /** 安装器信息:应用名/版本/默认安装目录/发布产物是否存在 */
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

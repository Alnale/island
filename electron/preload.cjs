/**
 * 灵动岛桌面挂件 —— 预加载脚本
 * 以 contextBridge 向挂件页面暴露最小桌面 API。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  /** 鼠标进入/离开灵动岛交互区:切换窗口点击穿透 */
  pointer(active) {
    ipcRenderer.send('widget:pointer', Boolean(active))
  },
  /** 隐藏挂件(托盘可恢复) */
  hide() {
    ipcRenderer.send('widget:hide')
  },
  /** 退出应用 */
  quit() {
    ipcRenderer.send('widget:quit')
  },
  /** 置顶开关 */
  setAlwaysOnTop(on) {
    ipcRenderer.send('widget:topmost', Boolean(on))
  },
  /** 托盘菜单"设置":订阅回调(渲染端在岛内展开设置视图) */
  onOpenSettings(callback) {
    ipcRenderer.on('widget:open-settings', () => callback())
  },
  /** 调整窗口高度(背景编辑器视图需要更高空间) */
  setWindowHeight(height) {
    ipcRenderer.send('widget:set-height', Number(height))
  },
  /** 调整窗口尺寸(Agent 面板缩放需要宽度;高度用于高空间视图) */
  setWindowSize(width, height) {
    ipcRenderer.send('widget:set-size', Number(width), Number(height))
  },
  /** 右键长按拖拽移动挂件:开始(记录基准位置;数值兜底防异常参数) */
  dragStart(screenX, screenY) {
    ipcRenderer.send('widget:drag-start', Number(screenX), Number(screenY))
  },
  /** 右键长按拖拽移动挂件:移动(指针屏幕坐标,与窗口同坐标系) */
  dragMove(screenX, screenY) {
    ipcRenderer.send('widget:drag-move', Number(screenX), Number(screenY))
  },
  /** 右键长按拖拽移动挂件:结束 */
  dragEnd() {
    ipcRenderer.send('widget:drag-end')
  },
  /** Agent:发送一轮对话(引擎无状态,history 为完整历史) */
  agentSend(text, history) {
    ipcRenderer.send('agent:send', String(text), history)
  },
  /** Agent:中止当前轮 */
  agentAbort() {
    ipcRenderer.send('agent:abort')
  },
  /** Agent:订阅引擎事件流(状态/文本增量/工具调用/工具结果/消息落定) */
  onAgentEvent(callback) {
    ipcRenderer.on('agent:event', (_event, event) => callback(event))
  },
  /** Agent:读取配置(API Key / Base URL / 模型 / 系统提示词) */
  agentGetConfig() {
    return ipcRenderer.invoke('agent:config-get')
  },
  /** Agent:工具清单(名称/描述/参数 schema,UI 展示用) */
  agentGetTools() {
    return ipcRenderer.invoke('agent:tools')
  },
  /** Agent:静默总结对话标题(后台,不打扰用户) */
  agentSummarize(messages) {
    return ipcRenderer.invoke('agent:summarize', messages)
  },
  /** Agent:写入配置(增量补丁) */
  agentSetConfig(patch) {
    return ipcRenderer.invoke('agent:config-set', patch)
  },
  /** 模式切换(托盘右键菜单):订阅回调 */
  onSetMode(callback) {
    ipcRenderer.on('widget:set-mode', (_event, mode) => callback(mode))
  },
  /** 请求切换模式(音乐 ↔ agent;Agent 文字区滑动手势退出 → 音乐) */
  setMode(mode) {
    ipcRenderer.send('widget:set-mode', mode)
  },
  /** 启动时询问当前模式(音乐 / agent) */
  getMode() {
    return ipcRenderer.invoke('widget:get-mode')
  },
})

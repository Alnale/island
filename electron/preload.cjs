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
  /* 死通道已删(审计 P2-1):hide/quit/setAlwaysOnTop 渲染端零调用,
   * 托盘退出走 app.quit、置顶走 tray 直调 */
  /** 托盘菜单"设置":订阅回调(渲染端在岛内展开设置视图)。
   * 返回取消订阅函数(与 onAgentEvent 同款——dev StrictMode 双挂载下
   * 重复注册会使托盘事件回调翻倍) */
  onOpenSettings(callback) {
    const listener = () => callback()
    ipcRenderer.on('widget:open-settings', listener)
    return () => ipcRenderer.removeListener('widget:open-settings', listener)
  },
  /** 初次安装引导:订阅回调(渲染端在岛内展开帮助手册) */
  onOpenHelp(callback) {
    const listener = () => callback()
    ipcRenderer.on('widget:open-help', listener)
    return () => ipcRenderer.removeListener('widget:open-help', listener)
  },
  /** 消息气泡链接:用系统浏览器打开(不新建 Electron 窗口) */
  openExternal(url) {
    ipcRenderer.send('app:open-external', String(url))
  },
  /** 调整窗口尺寸(Agent 面板缩放需要宽度;高度用于高空间视图;
   * widget:set-height 死通道已删,统一走 set-size) */
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
  /** Agent:exec_command 确认门回执(确认请求经 onAgentEvent 的
   * tool-confirm-request 事件到达,用户点允许/拒绝后回传) */
  agentConfirmTool(approved) {
    ipcRenderer.send('agent:tool-confirm', Boolean(approved))
  },
  /** Agent:订阅引擎事件流(状态/文本增量/工具调用/工具结果/消息落定)。
   * 返回取消订阅函数(useAgent 与设置视图的 effect cleanup 调用,
   * 避免视图卸载后回调继续持有 setState) */
  onAgentEvent(callback) {
    const listener = (_event, event) => callback(event)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  /** Agent:读取配置(API Key / Base URL / 模型 / 系统提示词) */
  agentGetConfig() {
    return ipcRenderer.invoke('agent:config-get')
  },
  /** Agent:工具清单(名称/描述/参数 schema,UI 展示用;含 MCP/技能) */
  agentGetTools() {
    return ipcRenderer.invoke('agent:tools')
  },
  /** Agent:测试 MCP 服务连通性(独立连接 → 列工具 → 销毁) */
  agentTestMcp(server) {
    return ipcRenderer.invoke('agent:mcp-test', server)
  },
  /** Agent:读取记忆条目列表(记忆管理器用) */
  agentMemoryGet() {
    return ipcRenderer.invoke('agent:memory-get')
  },
  /** Agent:导出记忆到文件(保存对话框;JSON 结构同 memory.json) */
  agentMemoryExport() {
    return ipcRenderer.invoke('agent:memory-export')
  },
  /** Agent:导入记忆文件(打开对话框选导出文件 → 合并进现有记忆,
      返回 {imported, skipped} 计数) */
  agentMemoryImport() {
    return ipcRenderer.invoke('agent:memory-import')
  },
  /** Agent:写入记忆(add/remove/update/replaceAll,返回最新列表) */
  agentMemorySet(patch) {
    return ipcRenderer.invoke('agent:memory-set', patch)
  },
  /** Agent:触发记忆自我进化(后台,完成发系统通知) */
  agentEvolve(focus) {
    return ipcRenderer.invoke('agent:evolve', typeof focus === 'string' ? focus : undefined)
  },
  /** Agent:自我进化日志 */
  agentEvolutionLog() {
    return ipcRenderer.invoke('agent:evolution-log')
  },
  /** Agent:回滚到最近一次进化前快照 */
  agentEvolutionRollback() {
    return ipcRenderer.invoke('agent:evolution-rollback')
  },
  /** Agent:清除全部进化版本(回到初始状态) */
  agentEvolutionReset() {
    return ipcRenderer.invoke('agent:evolution-reset')
  },
  /** Agent:导入技能(选择技能包文件夹或单个 .md 文件) */
  agentSkillImport() {
    return ipcRenderer.invoke('agent:skill-import')
  },
  /** Agent:静默总结对话标题(后台,不打扰用户) */
  agentSummarize(messages) {
    return ipcRenderer.invoke('agent:summarize', messages)
  },
  /** Agent:心理揣测(独立 Sub Agent,紧凑态文字区展示) */
  agentMindGuess(messages) {
    return ipcRenderer.invoke('agent:mind-guess', messages)
  },
  /** Agent:写入配置(增量补丁) */
  agentSetConfig(patch) {
    return ipcRenderer.invoke('agent:config-set', patch)
  },
  /** Agent:主动陪伴 tick(渲染端调度器触发;返回 {started, reason?}
   * 供 in-flight 复位与 judge 否决回退时钟) */
  agentProactiveTick(messages, idleMinutes) {
    return ipcRenderer.invoke('agent:proactive-tick', messages, Number(idleMinutes) || 0)
  },
  /** 模式切换(托盘右键菜单):订阅回调(payload = { mode, source })。
   * 返回取消订阅函数(dev StrictMode 双挂载防重复注册) */
  onSetMode(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('widget:set-mode', listener)
    return () => ipcRenderer.removeListener('widget:set-mode', listener)
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

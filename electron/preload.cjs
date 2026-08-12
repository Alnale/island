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
  /** 消息气泡链接:用系统浏览器打开(不新建 Electron 窗口) */
  openExternal(url) {
    ipcRenderer.send('app:open-external', String(url))
  },
  /** 媒体降级打开(2026-08-08):岛内播放失败时用系统默认播放器打开
   * (island-media://local/ 或 http/https URL;主进程按媒体扩展名校验) */
  openMediaExternal(url) {
    ipcRenderer.send('app:open-media-external', String(url))
  },
  /** 调整窗口尺寸(Agent 面板缩放需要宽度;高度用于高空间视图;
   * widget:set-height 死通道已删,统一走 set-size)。
   * immediate(2026-08-10):窗口补间直通主进程 setBounds,跳过 100ms
   * 合帧(合帧把补间压成 ~10Hz 台阶,与岛体平滑过渡不同步 = 抖动) */
  setWindowSize(width, height, immediate) {
    ipcRenderer.send('widget:set-size', Number(width), Number(height), immediate === true)
  },
  /** 窗口层级(2026-08-10 用户要求):展开态不严格置顶。渲染端在展开/
   * 收起时上报形态——紧凑(灵动岛/多媒体岛)= true 置顶,展开面板 =
   * false 不置顶。主进程尊重托盘"总在最前"开关(用户显式关闭时不动作) */
  setTopmost(on) {
    ipcRenderer.send('widget:topmost', Boolean(on))
  },
  /** 全屏状态上报(2026-08-08):fullscreenchange 时通知主进程,主进程
   * 在全屏期间兜底忽略 widget:set-size——全屏层(100% viewport)跟随
   * 窗口 resize 放大 = "全屏界面越来越大",渲染端守卫之外的漏网路径
   * 由主进程兜底。
   * inMini(2026-08-10):全屏元素是否在媒体岛内——岛全屏放大窗口到
   * 显示器,对话窗口内媒体全屏只覆盖 Agent 窗口(不放大) */
  setFullscreen(fs, inMini) {
    ipcRenderer.send('widget:fullscreen', Boolean(fs), Boolean(inMini))
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
  /** Agent:发送一轮对话(引擎无状态,history 为完整历史;sessionId =
   * 会话 ID——工具输出按对话分类存放,2026-08-12;source='qq'(私聊,
   * target = QQ 号)/'group'(群聊,target = 群号)/'ask'(询问轮,target =
   * 陌生人 QQ——回复发到主人 QQ 同步询问,2026-08-12)= NapCat 触发轮 */
  agentSend(text, history, sessionId, source, target) {
    ipcRenderer.send(
      'agent:send',
      String(text),
      history,
      typeof sessionId === 'string' ? sessionId : undefined,
      source === 'qq' || source === 'group' || source === 'ask' ? source : undefined,
      (source === 'qq' || source === 'group' || source === 'ask') && typeof target === 'string' ? target : undefined,
    )
  },
  /** NapCat 私聊消息订阅(2026-08-12):payload = {qq, text, messageId,
   * time}——收到 QQ 私聊消息,渲染端作为用户消息进入对话。返回取消
   * 订阅函数 */
  onNapcatMessage(callback) {
    const listener = (_event, msg) => callback(msg)
    ipcRenderer.on('napcat:message', listener)
    return () => ipcRenderer.removeListener('napcat:message', listener)
  },
  /** NapCat 群消息订阅(2026-08-12):payload = {groupId, qq, text,
   * atMe}——群消息经自主判断接话后进入对话(回复发回群) */
  onNapcatGroupMessage(callback) {
    const listener = (_event, msg) => callback(msg)
    ipcRenderer.on('napcat:group-message', listener)
    return () => ipcRenderer.removeListener('napcat:group-message', listener)
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
  /** Agent:账户余额查询(2026-08-11 设置界面「账号」功能;引擎与 LLM
   * 工具 get_deepseek_balance 同一实现,结构化数据;失败返回 {error}) */
  agentGetBalance() {
    return ipcRenderer.invoke('agent:balance')
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
  /** Agent:清除数据(2026-08-10,Agent 设置「数据管理」区)
   * scope 'app' = 灵动岛所有数据(记忆/进化/settings.json);
   * scope 'tools' = 所有工具的下载记录及源文件(bili 下载与登录态、
   * xxt 登录态与截图)。渲染端已清 localStorage + IndexedDB */
  agentClearData(scope) {
    return ipcRenderer.invoke('agent:clear-data', scope)
  },
  /** 穿透轮询校正(2026-08-10):返回窗口屏幕 bounds + 光标屏幕位置,
   * 渲染端核对岛体 rect 校正穿透状态(防 mouseleave 后穿透死锁) */
  pointerPoll() {
    return ipcRenderer.invoke('widget:pointer-poll')
  },
  /** Agent:导入技能(选择技能包文件夹或单个 .md 文件) */
  agentSkillImport() {
    return ipcRenderer.invoke('agent:skill-import')
  },
  /** Agent:彻底删除技能(仅 userData/skills 下的应用自有技能;删除即
   * 从磁盘消失,不进排除/恢复区;payload {slug}) */
  agentSkillDelete(slug) {
    return ipcRenderer.invoke('agent:skill-delete', { slug })
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
   * 供 in-flight 复位与 judge 否决回退时钟;sessionId = 当前会话 ID,
   * 主动回合的工具输出归属该对话,2026-08-12) */
  agentProactiveTick(messages, idleMinutes, sessionId) {
    return ipcRenderer.invoke(
      'agent:proactive-tick',
      messages,
      Number(idleMinutes) || 0,
      typeof sessionId === 'string' ? sessionId : undefined,
    )
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
  /** 多媒体库视频导入:系统对话框选视频文件 → [{path, name, size}]
   * (视频库路径引用,浏览器 File 无绝对路径,必须经主进程 dialog) */
  pickMediaFiles() {
    return ipcRenderer.invoke('app:pick-media-files')
  },
  /** 托盘"多媒体库"菜单:订阅回调(渲染端展开岛体进入多媒体库视图)。
   * 返回取消订阅函数(与 onOpenSettings 同款) */
  onOpenMediaLibrary(callback) {
    const listener = () => callback()
    ipcRenderer.on('widget:open-media-library', listener)
    return () => ipcRenderer.removeListener('widget:open-media-library', listener)
  },
})

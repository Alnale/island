/**
 * Electron 桌面预加载脚本暴露的桌面 API。
 * 由 electron/preload.cjs 注入,Web 演示环境(纯浏览器)不存在,访问时可选链。
 */
interface DesktopApi {
  /** 鼠标进入/离开灵动岛交互区:通知主进程开关"点击穿透"(挂件核心体验) */
  pointer(active: boolean): void
  /** 隐藏挂件窗口(托盘可恢复) */
  hide(): void
  /** 退出应用 */
  quit(): void
  /** 置顶开关 */
  setAlwaysOnTop(on: boolean): void
  /** 托盘菜单"设置":订阅回调(渲染端在岛内展开设置视图) */
  onOpenSettings(callback: () => void): void
  /** 初次安装引导:订阅回调(渲染端在岛内展开帮助手册) */
  onOpenHelp(callback: () => void): void
  /** 调整窗口高度(背景编辑器视图需要更高空间) */
  setWindowHeight(height: number): void
  /** 调整窗口尺寸(Agent 面板缩放需要宽度;高度用于高空间视图) */
  setWindowSize(width: number, height: number): void
  /** 右键长按拖拽移动挂件:开始(记录基准位置) */
  dragStart(screenX: number, screenY: number): void
  /** 右键长按拖拽移动挂件:移动(指针屏幕坐标,与窗口同坐标系) */
  dragMove(screenX: number, screenY: number): void
  /** 右键长按拖拽移动挂件:结束 */
  dragEnd(): void
  /** Agent:发送一轮对话(引擎无状态,history 为完整历史) */
  agentSend(text: string, history: unknown[]): void
  /** Agent:中止当前轮 */
  agentAbort(): void
  /** Agent:订阅引擎事件流(状态/文本增量/工具调用/工具结果/消息落定);
   * 返回取消订阅函数(effect cleanup 用) */
  onAgentEvent(callback: (event: unknown) => void): () => void
  /** Agent:读取配置(API Key / Base URL / 模型 / 系统提示词 / MCP / 技能目录) */
  agentGetConfig(): Promise<{
    apiKey: string
    baseURL: string
    model: string
    systemPrompt: string
    reasoningEffort: string
    mcpServers: Array<{
      name: string
      command: string
      type?: 'stdio' | 'sse'
      args?: string[]
      env?: Record<string, string>
      url?: string
      headers?: Record<string, string>
    }>
    skillsDirs: string[]
    excludedSkills: string[]
    excludedTools: string[]
  }>
  /** Agent:写入配置(增量补丁) */
  agentSetConfig(
    patch: Partial<
      Record<
        'apiKey' | 'baseURL' | 'model' | 'systemPrompt' | 'reasoningEffort',
        string
      > & {
        mcpServers?: Array<{
          name: string
          command: string
          type?: 'stdio' | 'sse'
          args?: string[]
          env?: Record<string, string>
          url?: string
          headers?: Record<string, string>
        }>
        skillsDirs?: string[]
        excludedSkills?: string[]
        excludedTools?: string[]
      }
    >,
  ): Promise<unknown>
  /** Agent:工具清单(名称/描述/参数 schema,UI 展示用;含 MCP/技能) */
  agentGetTools(): Promise<Array<{ name: string; description: string; parameters: unknown }>>
  /** Agent:测试 MCP 服务连通性(独立连接 → 列工具 → 销毁) */
  agentTestMcp(server: {
    name: string
    command: string
    type?: 'stdio' | 'sse'
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
  }): Promise<{ ok: boolean; error?: string; toolCount?: number }>
  /** Agent:读取记忆条目列表(记忆管理器用) */
  agentMemoryGet(): Promise<unknown[]>
  /** Agent:写入记忆(add/remove/update/replaceAll,返回最新列表) */
  agentMemorySet(patch: unknown): Promise<unknown>
  /** Agent:导出记忆到文件(保存对话框;JSON 结构同 memory.json) */
  agentMemoryExport(): Promise<{ canceled: boolean; path?: string; bytes?: number; error?: string }>
  /** Agent:导入记忆文件(打开对话框选导出文件 → 合并进现有记忆,
   * 返回导入/跳过计数) */
  agentMemoryImport(): Promise<{
    canceled: boolean
    imported?: number
    skipped?: number
    error?: string
  }>
  /** Agent:触发记忆自我进化(后台,完成发系统通知) */
  agentEvolve(focus?: string): Promise<{ started: boolean; message: string }>
  /** Agent:自我进化日志(version = 候选版本号) */
  agentEvolutionLog(): Promise<Array<{ at: number; version: number; before: number; after: number; applied: boolean; summary: string; changes: number }>>
  /** Agent:回滚到最近一次进化前快照 */
  agentEvolutionRollback(): Promise<string>
  /** Agent:清除全部进化版本(回到初始状态) */
  agentEvolutionReset(): Promise<string>
  /** Agent:导入技能(选择技能包文件夹或单个 .md 文件) */
  agentSkillImport(): Promise<{
    canceled: boolean
    imported?: string[]
    skipped?: string[]
    error?: string
  }>
  /** Agent:静默总结对话标题(后台,不打扰用户) */
  agentSummarize(messages: unknown[]): Promise<string>
  /** 模式切换(托盘右键菜单):订阅回调(payload = 目标模式 + 切换来源;
   * source 'tool' = Agent 工具 switch_to_music 触发的切换) */
  onSetMode(callback: (payload: { mode: 'music' | 'agent'; source: 'user' | 'tool' }) => void): void
  /** 请求切换模式(音乐 ↔ agent;Agent 文字区滑动手势退出 → 音乐) */
  setMode(mode: 'music' | 'agent'): void
  /** 启动时询问当前模式(音乐 / agent) */
  getMode(): Promise<'music' | 'agent'>
}

declare global {
  interface Window {
    desktop?: DesktopApi
  }
}

export {}

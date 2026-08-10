/**
 * Electron 桌面预加载脚本暴露的桌面 API。
 * 由 electron/preload.cjs 注入,Web 演示环境(纯浏览器)不存在,访问时可选链。
 */
/** Agent 配置(与 src/agent/types.ts 的 AgentConfig 同构;desktop.d.ts
 * 自包含,不跨层 import——审计 P2 #5 抽具名类型供读写共用) */
type IslandAgentConfig = {
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
  /** exec_command 确认门开关(main 实际返回,补全类型,审计 P1-2) */
  confirmExec?: boolean
  /** 主动陪伴开关(main 默认 true;2026-08-07) */
  proactiveEnabled: boolean
  /** 主动陪伴间隔数值(main 默认 60,钳制 5–480;2026-08-07) */
  proactiveInterval: number
  /** 主动陪伴间隔单位(s=秒 / m=分钟 / h=小时;main 默认 m) */
  proactiveIntervalUnit: 's' | 'm' | 'h'
  /** 总结标题文风(Sub Agent 设置:预设 id 或自定义 ≤100 字) */
  summaryStyle: string
  /** 心理揣测人格(Sub Agent 设置:预设 id 或自定义 ≤100 字) */
  mindPersona: string
}

interface DesktopApi {
  /** 鼠标进入/离开灵动岛交互区:通知主进程开关"点击穿透"(挂件核心体验) */
  pointer(active: boolean): void
  /** 托盘菜单"设置":订阅回调(渲染端在岛内展开设置视图);返回取消订阅函数 */
  onOpenSettings(callback: () => void): () => void
  /** 打开外部链接(http/https 经主进程校验后 shell.openExternal) */
  openExternal(url: string): void
  /** 媒体降级打开(岛内播放失败 → 系统默认播放器;本地路径经媒体扩展
   * 名校验后 shell.openPath,远程 URL 走系统浏览器) */
  openMediaExternal(url: string): void
  /** 调整窗口尺寸(Agent 面板缩放需要宽度;高度用于高空间视图;
   * 死通道 hide/quit/setAlwaysOnTop/setWindowHeight 已删,审计 P2-1)。
   * immediate(2026-08-10):窗口补间直通 setBounds 跳过合帧,
   * 防补间被压成 ~10Hz 台阶与岛体过渡不同步 */
  setWindowSize(width: number, height: number, immediate?: boolean): void
  /** 窗口层级(2026-08-10 用户要求):紧凑态(灵动岛/多媒体岛)= 置顶,
   * 展开面板 = 不置顶。主进程尊重托盘"总在最前"开关 */
  setTopmost(on: boolean): void
  /** 全屏状态上报(2026-08-08):主进程在全屏期间兜底忽略 set-size,
   * 防全屏层(100% viewport)跟随窗口 resize 放大。
   * inMini(2026-08-10):全屏元素是否在媒体岛内——岛全屏放大窗口到
   * 显示器,对话窗口内媒体全屏只覆盖 Agent 窗口(不放大) */
  setFullscreen(fs: boolean, inMini?: boolean): void
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
  /** Agent:exec_command 确认门回执(用户允许/拒绝) */
  agentConfirmTool(approved: boolean): void
  /** Agent:订阅引擎事件流(状态/文本增量/工具调用/工具结果/消息落定);
   * 返回取消订阅函数(effect cleanup 用) */
  onAgentEvent(callback: (event: unknown) => void): () => void
  /** Agent:读取配置(API Key / Base URL / 模型 / 系统提示词 / MCP / 技能目录) */
  agentGetConfig(): Promise<IslandAgentConfig>
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
        confirmExec?: boolean
        proactiveEnabled?: boolean
        proactiveInterval?: number
        proactiveIntervalUnit?: 's' | 'm' | 'h'
        summaryStyle?: string
        mindPersona?: string
      }
    >,
  ): Promise<IslandAgentConfig>
  /** Agent:工具清单(名称/描述/参数 schema,UI 展示用;含 MCP/技能;
   * sourceKind = 技能来源分区,审计 P1-2 补全) */
  agentGetTools(): Promise<
    Array<{
      name: string
      description: string
      parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
      sourceKind?: 'created' | 'imported' | 'scanned'
    }>
  >
  /** Agent:账户余额查询(2026-08-11 设置界面「账号」功能;与 LLM 工具
   * get_deepseek_balance 同一实现;失败返回 {error}) */
  agentGetBalance(): Promise<
    | {
        isAvailable: boolean
        balances: Array<{ currency: string; total: number; granted: number; toppedUp: number }>
      }
    | { error: string }
  >
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
  /** Agent:回滚到最近一次进化前快照(失败返回 {error},safeHandle 统一) */
  agentEvolutionRollback(): Promise<string | { error: string }>
  /** Agent:清除全部进化版本(回到初始状态)(失败返回 {error}) */
  agentEvolutionReset(): Promise<string | { error: string }>
  /** Agent:清除数据(2026-08-10,Agent 设置「数据管理」区):
   * 'app' = 灵动岛所有数据 / 'tools' = 工具下载记录及源文件 */
  agentClearData(scope: 'app' | 'tools'): Promise<{ ok?: boolean; error?: string }>
  /** 穿透轮询校正(2026-08-10):窗口屏幕 bounds + 光标屏幕位置 +
   * 主进程真实穿透状态(渲染端核对岛体 rect 校正穿透,防穿透死锁) */
  pointerPoll(): Promise<{
    bounds: { x: number; y: number; width: number; height: number }
    cursor: { x: number; y: number }
    ignoreMouseEvents: boolean
  } | null>
  /** Agent:导入技能(选择技能包文件夹或单个 .md 文件) */
  agentSkillImport(): Promise<{
    canceled: boolean
    imported?: string[]
    skipped?: string[]
    error?: string
  }>
  /** Agent:静默总结对话标题(后台,不打扰用户) */
  agentSummarize(messages: unknown[]): Promise<string>
  /** Agent:心理揣测(独立 Sub Agent,紧凑态文字区展示) */
  agentMindGuess(messages: unknown[]): Promise<string>
  /** Agent:主动陪伴 tick(渲染端调度器触发;{started} 供 in-flight 复位,
   * reason 'judge-no' 供回退 idle 时钟防高频判断调用) */
  agentProactiveTick(messages: unknown[], idleMinutes: number): Promise<{ started: boolean; reason?: string }>
  /** 模式切换(托盘右键菜单):订阅回调(payload = 目标模式 + 切换来源;
   * source 'tool' = Agent 工具 switch_to_music 触发的切换) */
  onSetMode(
    callback: (payload: { mode: 'music' | 'agent'; source: 'user' | 'tool'; play?: boolean }) => void,
  ): void
  /** 请求切换模式(音乐 ↔ agent;Agent 文字区滑动手势退出 → 音乐) */
  setMode(mode: 'music' | 'agent'): void
  /** 启动时询问当前模式(音乐 / agent) */
  getMode(): Promise<'music' | 'agent'>
  /** 多媒体库视频导入:系统对话框选视频文件 → [{path, name, size}] */
  pickMediaFiles(): Promise<Array<{ path: string; name: string; size: number }>>
  /** 托盘"多媒体库"菜单:订阅回调(展开岛体进入多媒体库视图);返回取消订阅函数 */
  onOpenMediaLibrary(callback: () => void): () => void
}

declare global {
  interface Window {
    desktop?: DesktopApi
  }
}

export {}

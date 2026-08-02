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
  /** 右键拖拽移动挂件:开始(记录基准位置) */
  dragStart(screenX: number, screenY: number): void
  /** 右键拖拽移动挂件:移动(指针屏幕坐标,与窗口同坐标系) */
  dragMove(screenX: number, screenY: number): void
  /** 右键拖拽移动挂件:结束 */
  dragEnd(): void
}

declare global {
  interface Window {
    desktop?: DesktopApi
  }
}

export {}

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
  /** 托盘菜单"自定义背景":订阅回调(渲染端在岛内打开背景编辑器) */
  onOpenBackgroundEditor(callback) {
    ipcRenderer.on('widget:open-background-editor', () => callback())
  },
  /** 调整窗口高度(背景编辑器视图需要更高空间) */
  setWindowHeight(height) {
    ipcRenderer.send('widget:set-height', Number(height))
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
})

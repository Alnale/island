/**
 * Electron stub —— 测试专用:替换 agent.cjs 打包时的 'electron' 依赖。
 * Notification 记录到 global.__notifications(测试断言进化/后台通知),
 * shell 空实现(测试不触发真实系统行为)。
 */
class NotificationStub {
  constructor(opts) {
    this.opts = opts
    const list = globalThis.__notifications ?? []
    list.push(opts)
    globalThis.__notifications = list
  }
  show() {
    // 已构造即记录
  }
  static isSupported() {
    return true
  }
}

module.exports = {
  Notification: NotificationStub,
  shell: {
    async openExternal() {
      return undefined
    },
    async openPath() {
      return ''
    },
  },
}

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
  // tools.ts 经 app.getPath('userData') 取运行时产物落点；测试环境使用
  // 每轮显式注入的临时目录，绝不读取用户真实配置。
  app: {
    getPath() {
      return process.env.DYNAMIC_ISLAND_TEST_USER_DATA || 'C:/__dynamic_island_agent_tests__'
    },
  },
  shell: {
    async openExternal() {
      return undefined
    },
    async openPath() {
      return ''
    },
  },
}

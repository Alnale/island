/**
 * 命令执行确认门业务
 *
 * 职责:confirmExec 开启时每轮首个 exec_command 执行前请求用户确认。
 * 这是一个独立的业务概念,主循环与子代理共用。
 */

export function createTurnConfirmGate(
  config: { confirmExec?: boolean },
  confirmCommand?: (command: string) => Promise<boolean>,
): { reset(): void; check(name: string, args: Record<string, unknown>): Promise<boolean> } {
  let confirmed = false
  return {
    reset() {
      confirmed = false
    },
    async check(name, args) {
      if (!config.confirmExec || name !== 'exec_command' || confirmed) return true
      const approved = (await confirmCommand?.(String(args.command ?? ''))) ?? false
      if (approved) confirmed = true
      return approved
    },
  }
}

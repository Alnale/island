/**
 * 会话管理工具(2026-08-13,用户要求"支持放 LLM 自己生成记录,自己清空
 * 当前会话上下文")
 *
 * - set_session_note:LLM 为当前会话生成/更新情况记录(主人可在会话横幅
 *   查看与编辑;每轮回复参考;清空上下文不清除);
 * - clear_session_context:清空当前会话的对话上下文(消息历史)——会话
 *   太长/话题跑偏时使用;当前回复照常完成,下一条消息起全新上下文;
 *   不清除情况记录/长期记忆/联系人档案。
 *
 * 主进程注入 deps 才注册(挂件环境;Web 演示版无主进程)。key = 当前
 * 会话键(引擎 currentSessionKey:main / private:<QQ> / group:<群号>)。
 */

import type { AgentTool } from '../types'

export function createSessionTools(deps: {
  /** 当前会话键(null = 无会话上下文,工具拒绝) */
  getSessionKey(): string | null
  getNote(key: string): Promise<string>
  setNote(key: string, note: string): Promise<unknown>
  clearContext(key: string): Promise<unknown>
}): AgentTool[] {
  return [
    {
      name: 'get_session_note',
      description:
        `查看当前会话的情况记录(主人写的会话上下文备忘,或本工具此前生成的记录)。` +
        `返回空 = 尚无记录,可用 set_session_note 生成。`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      async execute() {
        const key = deps.getSessionKey()
        if (!key) return '当前没有可操作的会话'
        const note = String(await deps.getNote(key)).trim()
        return note ? `当前会话(${key})的情况记录:${note}` : `当前会话(${key})暂无情况记录`
      },
    },
    {
      name: 'set_session_note',
      description:
        `设置当前会话的情况记录(给主人看的会话上下文备忘:对方身份/最近在聊什么/回复风格等——` +
        `主人可在会话横幅查看与编辑,每轮回复都会参考,用于记住本会话的长期情况)。` +
        `记录不随清空上下文删除。参数 note ≤500 字,传空字符串 = 清除记录。` +
        `执行前可先用 get_session_note 查看当前记录(空 = 尚无)。`,
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: '情况记录内容(≤500 字);空字符串 = 清除' },
        },
        required: ['note'],
      },
      async execute(args) {
        const key = deps.getSessionKey()
        if (!key) return '当前没有可操作的会话'
        const note = String(args?.note ?? '').trim().slice(0, 500)
        await deps.setNote(key, note)
        return note
          ? `已更新当前会话(${key})的情况记录:${note}`
          : `已清除当前会话(${key})的情况记录`
      },
    },
    {
      name: 'clear_session_context',
      description:
        `清空当前会话的对话上下文(消息历史)——上下文太长/话题跑偏/对方换了新话题时使用,` +
        `清空后本会话从全新上下文开始。当前这条回复照常完成;` +
        `**不清除**情况记录、长期记忆与联系人档案。`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      async execute() {
        const key = deps.getSessionKey()
        if (!key) return '当前没有可操作的会话'
        await deps.clearContext(key)
        return `已清空当前会话(${key})的对话上下文,下一条消息起全新开始。情况记录与长期记忆保留。`
      },
    },
  ]
}

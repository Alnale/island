/**
 * NapCat QQ 机器人桥——领域入口与工具工厂
 *
 * 八期细分(2026-08-14)后的模块边界:
 * - napcat-client.ts  OneBot 11 WS 客户端实现(连接/重连熔断/收发/去重,
 *   协议细节说明在该文件头);
 * - napcat-message.ts 消息段解析与类型;napcat-store.ts 持久化域;
 * - napcat-session.ts 会话键/防重发;napcat-text.ts g_tk/出站文本清洗;
 * - 本文件:napcat 工具工厂(createNapcatTools,给 LLM 用)+ barrel 兼容
 *   re-export(engine.ts/main.cjs 既有导入路径零改动)。
 */

import { existsSync } from 'node:fs'
import type { AgentTool, ToolParams } from '../types'
import { masterQQ } from '../privacy'

// ---- 消息解析/持久化域/客户端实现已拆出,barrel 兼容 re-export(既有路径不变) ----
export * from './napcat-message'
export * from './napcat-store'
export * from './napcat-client'


import type { NapcatClient } from './napcat-client'

// ---- napcat 工具(给 LLM 用) ----
export interface NapcatToolDeps {
  client: NapcatClient
  getSessionKey?(): string | null
  /** 危险操作确认回调(群管理/踢人/禁言等) */
  confirmDangerous?(action: string, detail: string): Promise<boolean>
}

export function createNapcatTools(deps: NapcatToolDeps): AgentTool[] {
  const { client, confirmDangerous } = deps
  const opts = { getSessionKey: deps.getSessionKey }
  return [
    {
      name: 'napcat',
      description:
        'NapCat QQ 机器人(2026-08-14):查询连接状态 / 最近 QQ 消息 / **机器人发出的消息(带 ID 可撤回)** / 联系人档案 / **聊天记录备份(工具记忆)** / 主动发私聊或群消息 / **图片收发** / 群成员好友查询 / 撤回消息 / 群管理(需主人确认) / **查看 QQ 空间动态** / 会话管理。' +
        '**QQ 消息自动回复是系统链路**(收到私聊/群聊自动进入对话并回复——无需调用本工具);' +
        '**收到图片自动下载保存并进对话**(主人窗口可见图片,文本标注路径);' +
        '本工具适合:用户问"QQ 那边有消息吗""NapCat 连上没""之前和谁聊过什么""看看我的 QQ 动态"时查询;' +
        '**交流中认识新联系人/群成员时,用 contact_update 记录对方信息**;' +
        '或需要**主动**发消息时(action=send/send_group)。' +
        'action=status 查连接状态;action=recent 最近收到的消息;action=sent 已发出消息(可撤回);' +
        'action=contacts/contact_update/chats/persona/persona_set 档案与人格管理;' +
        'action=send/send_group 发消息(image 发图;file 发文件/视频,大视频上传可达 3 分钟);action=recall 撤回;' +
        'action=zone QQ空间动态;action=members/friends/profile/group_info 查询;' +
        'action=group_manage 群管理(踢人/禁言/全员禁言,需要主人确认);' +
        'action=sessions/session_mute/session_bind 会话管理。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'status', 'recent', 'sent', 'contacts', 'contact_update', 'chats', 'persona', 'persona_set', 'send',
              'send_group', 'recall', 'zone', 'members', 'friends', 'profile', 'group_info', 'group_manage',
              'sessions', 'session_mute', 'session_bind',
            ],
            description: '操作类型',
          },
          user_id: { type: 'string', description: 'send:目标QQ号;chats:按QQ过滤;profile:查询QQ;group_manage(ban/kick):目标成员' },
          group_id: { type: 'string', description: 'send_group:目标群号;chats:按群过滤;members/group_info/group_manage:目标群' },
          message: { type: 'string', description: 'send/send_group:消息文本' },
          image: { type: 'string', description: 'send/send_group:图片路径或URL(真正发图)' },
          file: { type: 'string', description: 'send/send_group:本地文件路径(真正上传文件/视频,如 .mp4)' },
          message_id: { type: 'string', description: 'recall:要撤回的消息ID' },
          qq: { type: 'string', description: 'contact_update:联系人QQ;zone:查看谁的动态(缺省主人)' },
          num: { type: 'number', description: 'zone:条数(1-20,缺省10)' },
          name: { type: 'string', description: 'contact_update:备注名' },
          info: { type: 'string', description: 'contact_update:已知信息' },
          source: { type: 'string', enum: ['private', 'group'], description: 'contact_update:认识来源' },
          scope: { type: 'string', description: 'persona_set:会话范围(private:<QQ>/group:<群号>)' },
          persona: { type: 'string', description: 'persona_set:人格描述(空串=删除)' },
          op: { type: 'string', enum: ['ban', 'kick', 'whole_ban'], description: 'group_manage:操作类型' },
          duration: { type: 'number', description: 'group_manage ban:禁言秒数(0=解除)' },
          enable: { type: 'boolean', description: 'group_manage whole_ban:true开启/false关闭' },
          key: { type: 'string', description: 'session_mute/session_bind:会话键' },
          muted: { type: 'boolean', description: 'session_mute:true屏蔽/false解除' },
        },
        required: ['action'],
      },
      // 引擎兜底超时覆盖(2026-08-14):file 发视频内部上传等待可达 180s,
      // 引擎默认 60s 统一超时会把上传中途杀掉——QQ 实际收到了但工具报
      // 超时,LLM 误报没发成功(与 xxt/doc_convert 同款审计陷阱)
      timeoutMs: 200_000,
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        if (action === 'status') {
          const s = client.status()
          return (
            `NapCat 状态:${s.connected ? '已连接' : s.circuitBroken ? '已熔断(需重启)' : '未连接'}(${s.url})` +
            (s.lastError ? `\n最近错误:${s.lastError}` : '') +
            `\n收到消息 ${s.receivedCount} 条,已回复 ${s.repliedCount} 条` +
            `\n主人:${masterQQ() || '(未配置,privacy.json)'}(在 privacy.json 配置)` +
            `\n私聊扩展信任:${s.allowed && s.allowed.length > 0 ? s.allowed.join('、') : '(仅主人)'}` +
            `\n监听群:${s.allowedGroups && s.allowedGroups.length > 0 ? s.allowedGroups.join('、') : '(无)'}`
          )
        }
        if (action === 'recent') {
          const list = client.getRecentMessages()
          if (list.length === 0) return '(最近没有收到 QQ 消息)'
          return list.slice(0, 10).map((m) =>
            `- ${m.replied ? '[已回复]' : '[未回复]'} ${m.qq}(${new Date(m.time * 1000).toLocaleTimeString('zh-CN')}):${m.text.slice(0, 80)}`
          ).join('\n')
        }
        if (action === 'sent') {
          const list = client.getSentMessages()
          if (list.length === 0) return '(机器人还没有发出过消息)'
          return list.slice(0, 10).map((m) =>
            `- ${new Date(m.time * 1000).toLocaleString('zh-CN')} [${m.type === 'group' ? `群${m.target}` : `QQ${m.target}`}] ${(m.text || '(图片/文件)').slice(0, 60)}(message_id ${m.messageId})`
          ).join('\n')
        }
        if (action === 'zone') {
          const qq = String(params.qq ?? '').trim()
          const num = params.num !== undefined ? Math.floor(Number(params.num)) : 10
          if (!Number.isFinite(num) || num < 1 || num > 20) throw new Error('zone 的 num 需要在 1-20 之间')
          const feeds = await client.getQzoneFeeds(qq || masterQQ(), num)
          if (feeds.length === 0) return `(QQ ${qq || masterQQ()} 的动态为空)`
          return `QQ ${qq || masterQQ()} 的最近动态(${feeds.length} 条):\n` +
            feeds.map((f, i) =>
              `${i + 1}. ${new Date(f.createTime * 1000).toLocaleString('zh-CN')} ${(f.content || '(无文字)').slice(0, 100)}` +
              `${f.picnum > 0 ? ` [图片×${f.picnum}]` : ''}${f.likenum > 0 ? ` 👍${f.likenum}` : ''}${f.commentnum > 0 ? ` 💬${f.commentnum}` : ''}`
            ).join('\n')
        }
        if (action === 'sessions') {
          // 列表直接可查(2026-08-14);增删监听/屏蔽/绑定走 manage_sessions
          const list = client.listSessions?.() ?? []
          if (list.length === 0) return '(暂无已知会话;可用 manage_sessions 工具 action=watch 新建监听会话)'
          return list.map((s) => `- ${s.key}(${s.title})[${s.kind === 'group' ? '群聊' : '私聊'}]${s.muted ? '[已屏蔽]' : ''}`).join('\n')
        }
        if (action === 'session_mute') {
          return '(会话屏蔽请通过 manage_sessions 工具操作)'
        }
        if (action === 'session_bind') {
          return '(会话绑定请通过 manage_sessions 工具操作)'
        }
        if (action === 'contacts') {
          const contacts = await client.getContacts()
          const list = Object.values(contacts)
          if (list.length === 0) return '(联系人档案为空)'
          return list.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((c) =>
            `- ${c.qq}${c.name ? `(${c.name})` : ''}${c.info ? `: ${c.info}` : ''}${c.source === 'group' ? ' [群聊]' : ' [私聊]'}`
          ).join('\n')
        }
        if (action === 'chats') {
          const chats = await client.getChats()
          const qqFilter = String(params.user_id ?? '').trim()
          const groupFilter = String(params.group_id ?? '').trim()
          let list = chats
          if (qqFilter) list = list.filter((c) => c.type === 'private' && c.target === qqFilter)
          if (groupFilter) list = list.filter((c) => c.type === 'group' && c.target === groupFilter)
          if (list.length === 0) return '(聊天记录为空' + (qqFilter || groupFilter ? `(按${qqFilter || groupFilter}过滤)` : '') + ')'
          return list.slice(-20).map((c) =>
            `- ${new Date(c.time * 1000).toLocaleString('zh-CN')} [${c.type === 'group' ? `群${c.target}` : `QQ${c.target}`}] ${c.qq}: ${c.text.slice(0, 80)}${c.atMe ? ' (@鲸鱼娘)' : ''}`
          ).join('\n')
        }
        if (action === 'contact_update') {
          const qq = String(params.qq ?? '').trim()
          if (!qq) throw new Error('contact_update 需要 qq(联系人QQ号)')
          const c = await client.updateContact({
            qq,
            name: params.name !== undefined ? String(params.name) : undefined,
            info: params.info !== undefined ? String(params.info) : undefined,
            source: params.source === 'group' ? 'group' : 'private',
          })
          return `已记录联系人 ${c.qq}${c.name ? `(${c.name})` : ''}${c.info ? `: ${c.info}` : ''}`
        }
        if (action === 'send') {
          let qq = String(params.user_id ?? '').trim()
          if (!qq) {
            const pm = /^private:(\d+)$/.exec(opts?.getSessionKey?.() ?? '')
            if (pm) qq = pm[1]
          }
          if (!qq) throw new Error('send 需要 user_id(目标QQ号)')
          const text = String(params.message ?? '').trim()
          const image = String(params.image ?? '').trim()
          const file = String(params.file ?? '').trim()
          if (!text && !image && !file) throw new Error('send 需要 message/image/file 至少一个')
          if (image && !/^https?:|^data:image\//.test(image) && !existsSync(image)) {
            throw new Error(`图片不存在:${image}`)
          }
          const id = await client.sendToQQ(qq, text, { image: image || undefined, file: file || undefined })
          return `已发送给 ${qq}(message_id ${id}${image ? ',含图片' : ''}${file ? ',含文件' : ''})`
        }
        if (action === 'persona') {
          const personas = await client.getPersonas()
          const list = Object.entries(personas)
          if (list.length === 0) return '(未设置会话人格)'
          return list.sort((a, b) => b[1].updatedAt - a[1].updatedAt).map(([scope, p]) => `- ${scope}: ${p.persona}`).join('\n')
        }
        if (action === 'persona_set') {
          const scope = String(params.scope ?? '').trim()
          if (!/^(private|group):[0-9]+$/.test(scope)) throw new Error('scope 需要是 private:<QQ> 或 group:<群号>')
          const persona = String(params.persona ?? '').trim()
          const next = await client.setPersona(scope, persona)
          if (!next) return `已删除会话 ${scope} 的人格`
          return `已设置会话 ${scope} 的人格:「${next.persona}」`
        }
        if (action === 'send_group') {
          let groupId = String(params.group_id ?? '').trim()
          if (!groupId) {
            const gm = /^group:(\d+)$/.exec(opts?.getSessionKey?.() ?? '')
            if (gm) groupId = gm[1]
          }
          if (!groupId) throw new Error('send_group 需要 group_id(目标群号)')
          const text = String(params.message ?? '').trim()
          const file = String(params.file ?? '').trim()
          const image = String(params.image ?? '').trim()
          if (!text && !file && !image) throw new Error('send_group 需要 message/file/image 至少一个')
          if (image && !/^https?:|^data:image\//.test(image) && !existsSync(image)) {
            throw new Error(`图片不存在:${image}`)
          }
          const id = await client.sendToGroup(groupId, text, file || undefined, image || undefined)
          return `已发送到群 ${groupId}${file ? '(含文件)' : ''}${image ? '(含图片)' : ''}(message_id ${id})`
        }
        if (action === 'recall') {
          const messageId = String(params.message_id ?? '').trim()
          if (!messageId) throw new Error('recall 需要 message_id')
          await client.recallMessage(messageId)
          return `已撤回消息 ${messageId}`
        }
        if (action === 'members') {
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('members 需要 group_id')
          const members = await client.getGroupMembers(groupId)
          if (members.length === 0) return '(群成员列表为空)'
          void client.mergeContactNames(members.map((m) => ({ qq: m.user_id, name: m.card || m.nickname, source: 'group' as const })))
          return members.slice(0, 200).map((m) => `- ${m.user_id}${m.card || m.nickname ? `(${m.card || m.nickname})` : ''}`).join('\n')
        }
        if (action === 'friends') {
          const list = await client.getFriendList()
          if (list.length === 0) return '(好友列表为空)'
          return list.slice(0, 200).map((m) => `- ${m.user_id}${m.remark || m.nickname ? `(${m.remark || m.nickname})` : ''}`).join('\n')
        }
        if (action === 'profile') {
          const qq = String(params.user_id ?? '').trim()
          if (!qq) throw new Error('profile 需要 user_id')
          const p = await client.getStrangerInfo(qq)
          return `QQ ${qq}:${p.nickname ? `昵称${p.nickname}` : '无昵称'}${p.sex ? `,性别${p.sex}` : ''}${p.age !== undefined ? `,年龄${p.age}` : ''}`
        }
        if (action === 'group_info') {
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('group_info 需要 group_id')
          const g = await client.getGroupInfo(groupId)
          return `群 ${groupId}:${g.groupName ? `群名「${g.groupName}」` : '群名未知'}${g.memberCount !== undefined ? `,成员${g.memberCount}人` : ''}`
        }
        if (action === 'group_manage') {
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('group_manage 需要 group_id')
          const op = String(params.op ?? '').trim()
          if (!op) throw new Error('group_manage 需要 op(ban/kick/whole_ban)')
          // 危险操作确认门
          if (confirmDangerous) {
            let confirmMsg = ''
            if (op === 'ban') {
              const qq = String(params.user_id ?? '').trim()
              const duration = params.duration !== undefined ? Number(params.duration) : NaN
              confirmMsg = `确认禁言 QQ ${qq} ${Math.floor(duration)}秒?`
            } else if (op === 'kick') {
              const qq = String(params.user_id ?? '').trim()
              confirmMsg = `确认把 QQ ${qq} 移出群 ${groupId}?`
            } else if (op === 'whole_ban') {
              confirmMsg = `确认${params.enable ? '开启' : '解除'}群 ${groupId} 全员禁言?`
            }
            if (confirmMsg) {
              const ok = await confirmDangerous('group_manage', confirmMsg)
              if (!ok) return '操作已取消(主人未确认)'
            }
          }
          if (op === 'ban') {
            const qq = String(params.user_id ?? '').trim()
            if (!qq) throw new Error('ban 需要 user_id')
            const duration = params.duration !== undefined ? Number(params.duration) : NaN
            if (!Number.isFinite(duration) || duration < 0) throw new Error('ban 需要 duration(秒)')
            await client.setGroupBan(groupId, qq, Math.floor(duration))
            return duration === 0 ? `已解除 ${qq} 的禁言` : `已禁言 ${qq}(${Math.floor(duration)}秒)`
          }
          if (op === 'kick') {
            const qq = String(params.user_id ?? '').trim()
            if (!qq) throw new Error('kick 需要 user_id')
            await client.setGroupKick(groupId, qq)
            return `已把 ${qq} 移出群 ${groupId}`
          }
          if (op === 'whole_ban') {
            if (typeof params.enable !== 'boolean') throw new Error('whole_ban 需要 enable')
            await client.setGroupWholeBan(groupId, params.enable)
            return params.enable ? `已开启全员禁言` : `已解除全员禁言`
          }
          throw new Error('op 仅支持 ban/kick/whole_ban')
        }
        throw new Error('未知action')
      },
    },
    {
      // 会话面板管理(2026-08-14 用户要求"灵动岛设置工具支持接入会话
      // 面板,支持 LLM 直接将监听会话在会话面板中新建"):watch 把
      // QQ/群号写入监听名单 → 配置变更自动广播会话种子 → 会话面板
      // 立即出现新条目(不等消息到达)
      name: 'manage_sessions',
      description:
        '会话面板管理(2026-08-14):灵动岛会话面板展示各 QQ 私聊/群聊会话窗口。' +
        'action=list 列出已知会话(键/名称/类型/是否屏蔽);' +
        'action=watch **把某个 QQ 或群加入监听名单**——对方消息将自动回复,且会话面板立即出现该会话条目' +
        '(用户说"监听某某/接入某群/给他建个会话/盯着这个群"时用;kind=private私聊/group群聊,id=QQ号或群号);' +
        'action=unwatch 移出监听名单(不再自动回复);' +
        'action=mute/unmute 屏蔽/解除屏蔽会话(消息仍记录但不自动回复);' +
        'action=bind 在挂件会话面板中打开指定会话。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'watch', 'unwatch', 'mute', 'unmute', 'bind'], description: '操作类型' },
          kind: { type: 'string', enum: ['private', 'group'], description: 'watch/unwatch:目标类型(private=QQ私聊 / group=群聊)' },
          id: { type: 'string', description: 'watch/unwatch:目标 QQ 号或群号(纯数字)' },
          key: { type: 'string', description: 'mute/unmute/bind:会话键(private:<QQ> 或 group:<群号>;bind 可用 main 打开主对话)' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        if (action === 'list') {
          const list = client.listSessions?.() ?? []
          if (list.length === 0) return '(暂无已知会话;用 action=watch 新建监听会话)'
          return list.map((s) => `- ${s.key}(${s.title})[${s.kind === 'group' ? '群聊' : '私聊'}]${s.muted ? '[已屏蔽]' : ''}`).join('\n')
        }
        if (action === 'watch' || action === 'unwatch') {
          const kind = params.kind === 'group' ? 'group' : params.kind === 'private' ? 'private' : null
          if (!kind) throw new Error(`${action} 需要 kind(private=QQ私聊 / group=群聊)`)
          const id = String(params.id ?? '').trim()
          if (!/^\d+$/.test(id)) throw new Error(`${action} 需要 id(纯数字的 QQ 号或群号)`)
          if (action === 'watch') {
            client.watchSession?.(kind, id)
            return kind === 'group'
              ? `已将群 ${id} 加入监听名单——群消息将自动回复,会话面板已出现该会话条目`
              : `已将 QQ ${id} 加入监听名单(扩展信任)——其私聊消息将自动回复,会话面板已出现该会话条目`
          }
          client.unwatchSession?.(kind, id)
          return kind === 'group' ? `已将群 ${id} 移出监听名单(不再自动回复)` : `已将 QQ ${id} 移出监听名单(不再自动回复)`
        }
        if (action === 'mute' || action === 'unmute') {
          const key = String(params.key ?? '').trim()
          if (!/^(private|group):\d+$/.test(key)) throw new Error('mute/unmute 需要 key(private:<QQ> 或 group:<群号>)')
          client.muteSession?.(key, action === 'mute')
          return action === 'mute' ? `已屏蔽会话 ${key}(消息仍记录,不再自动回复)` : `已解除会话 ${key} 的屏蔽`
        }
        if (action === 'bind') {
          const key = String(params.key ?? '').trim()
          if (!key) throw new Error('bind 需要 key(会话键;main = 主对话)')
          client.bindSession?.(key)
          return `已在会话面板中打开 ${key}`
        }
        throw new Error('manage_sessions action 仅支持 list/watch/unwatch/mute/unmute/bind')
      },
    },
  ]
}

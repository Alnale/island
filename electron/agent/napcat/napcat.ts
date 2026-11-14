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
import { napcatMessageText } from './napcat-message'
import {
  BOT_MENTION_MARK,
  isMasterTurnKind,
  resolveGroupMention,
  resolveGroupSendTarget,
  resolvePrivateSendTarget,
  scopeTranscriptQuery,
  type GroupParticipant,
} from './napcat-session'
import { stripSelfMentions, withoutSelfAt } from './napcat-text'

// ---- 消息解析/持久化域/客户端实现已拆出,barrel 兼容 re-export(既有路径不变) ----
export * from './napcat-message'
export * from './napcat-store'
export * from './napcat-client'
// ---- 扫码登录(2026-09-22):WebUI 登录客户端 + 自动换码状态机 + 零依赖 QR ----
export * from './napcat-login'
export * from './qr'


import type { NapcatClient } from './napcat-client'

// ---- napcat 工具(给 LLM 用) ----
export interface NapcatToolDeps {
  client: NapcatClient
  getSessionKey?(): string | null
  /** 危险操作确认回调(群管理/踢人/禁言等) */
  confirmDangerous?(action: string, detail: string): Promise<boolean>
  /** 打开 QQ 扫码登录小窗(2026-09-22;未注入 = login 动作提示不可用) */
  openLogin?(): void
  /** 主人 QQ(缺省读 privacy.json)。send 省略目标时不得落到这个号上 */
  getMasterQQ?(): string
  /** 当前轮次种类。别人的群会话不能把消息发到别的群，也不能读取别的群的记录 */
  getTurnKind?(): string | null
  /** 机器人自己的 QQ，艾特时排除 */
  getSelfQQ?(): string
  /** 本群可被艾特的人。未注入时，别人的会话不采用模型随手填的 at */
  listGroupParticipants?(groupId: string): Promise<GroupParticipant[]>
  /** 本轮群消息原文，以及它 @ 了谁 */
  getGroupTurn?(): { plain?: string; atQQs?: string[]; speakerQQ?: string; directed?: boolean } | null
}

/** 工具回显辅助(2026-10-25):文件大小与原始 JSON 截断 */
function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '未知大小'
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${Math.round(n / 1024)}KB`
  return `${n}B`
}

function jsonBrief(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s && s.length > 2000 ? `${s.slice(0, 2000)}…` : s || '(空)'
  } catch {
    return String(v)
  }
}

export function createNapcatTools(deps: NapcatToolDeps): AgentTool[] {
  const { client, confirmDangerous } = deps
  const opts = {
    getSessionKey: deps.getSessionKey,
    getMasterQQ: deps.getMasterQQ ?? masterQQ,
    getTurnKind: deps.getTurnKind,
    getSelfQQ: deps.getSelfQQ,
    listGroupParticipants: deps.listGroupParticipants,
    getGroupTurn: deps.getGroupTurn,
  }
  async function resolveSendGroupAt(
    at: string,
    text: string,
    groupId: string,
    turnKind: string | null,
  ): Promise<string | string[] | undefined> {
    if (at === 'all') return 'all'
    const self = String(opts.getSelfQQ?.() ?? '').trim()
    const explicit = at
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{5,12}$/.test(s) && s !== self)
    let people: GroupParticipant[] = []
    if (opts.listGroupParticipants) {
      try {
        people = await opts.listGroupParticipants(groupId)
      } catch {
        people = []
      }
    }
    const turn = opts.getGroupTurn?.() ?? null
    const mentioned = people.length
      ? resolveGroupMention({
          reply: text,
          speakerQQ: turn?.speakerQQ,
          directed: !!turn?.directed,
          participants: people,
          selfQQ: opts.getSelfQQ?.() ?? '',
          trigger: turn?.plain,
          triggerAtQQs: turn?.atQQs,
        })
      : []
    // 没标轮次的旧调用保留显式 at。主人轮也优先用自己写的 QQ。
    const legacy = isMasterTurnKind(turnKind) || !turnKind
    if (legacy) {
      if (explicit.length > 0) return explicit.length === 1 ? explicit[0] : explicit
      if (mentioned.length === 0) return undefined
      return mentioned.length === 1 ? mentioned[0] : mentioned
    }
    // 别人的群回合不采用模型随手填的 at（经常是刚发消息的那个人）。
    // 只信回复正文和触发消息算出来的对象。
    if (mentioned.length === 0) return undefined
    return mentioned.length === 1 ? mentioned[0] : mentioned
  }
  return [
    {
      name: 'napcat',
      description:
        'NapCat QQ 机器人(2026-08-14):查询连接状态 / 最近 QQ 消息 / **机器人发出的消息(带 ID 可撤回)** / 联系人档案 / **聊天记录备份(工具记忆)** / 主动发私聊或群消息 / **图片收发** / 群成员好友查询 / 撤回消息 / 群管理(需主人确认) / **QQ 空间动态(查看/发说说/删说说)** / 会话管理 / **QQ 扫码登录**。' +
        '**QQ 消息自动回复是系统链路**(收到私聊/群聊自动进入对话并回复——无需调用本工具);' +
        '**收到图片自动下载保存并进对话**(主人窗口可见图片,文本标注路径);' +
        '本工具适合:用户问"QQ 那边有消息吗""NapCat 连上没""之前和谁聊过什么""看看我的 QQ 动态"时查询;' +
        '**交流中认识新联系人/群成员时,用 contact_update 记录对方信息**;' +
        '或需要**主动**发消息/发 QQ 动态说说时(action=send/send_group/zone_post)。' +
        'action=login **打开 QQ 扫码登录窗口**(未登录/掉线时用:实时二维码自动换新,手机 QQ 扫码确认即登录);' +
        'action=status 查连接状态;action=reconnect **立即重连 OneBot WS**(熔断冷却中/未连接时用,不必等冷却、不必重启应用);' +
        'action=recent 最近收到的消息;action=sent 已发出消息(可撤回);' +
        'action=contacts/contact_update/chats/persona/persona_set 档案与人格管理;' +
        'action=send/send_group 发消息(image 发图;file 发文件/视频,大视频上传可达 3 分钟;' +
        'voice 发语音条(本地音频路径或 URL,mp3/wav/amr/silk 均可,NapCat 自动转 QQ 语音编码);' +
        'send_group 成功后自动把该群加入监听名单,才能收到群友回复——未监听的群消息会被丢掉;' +
        '群会话里的 send_group 只能发当前群,不能把本群的内容发到别的群,recent/chats 也只返回本群——主人在自己的窗口里指定群号才可以跨群);action=recall 撤回;' +
        'action=zone 查看 QQ空间动态;action=zone_post **发表说说**(content 正文;images 图片列表自动上传空间相册;ugc_right 可见范围 1所有人/4好友/16部分好友可见/64仅自己/128部分好友不可见,16/128 配 target_uins;需主人确认);action=zone_delete 按 tid 删除说说(需主人确认);' +
        'action=members/friends/profile/group_info 查询;' +
        'action=groups 列出机器人已加入的所有群(群号+群名)——**监听/接入某群前先调它拿真实群号**,不要凭群名猜群号;' +
        'action=group_manage 群管理(踢人/禁言/全员禁言,需要主人确认);' +
        'action=sessions/session_mute/session_bind 会话管理。' +
        '**2026-10-25 全量适配新增**:action=requests/request_handle 待处理好友/群请求(带 flag,接受/拒绝需主人确认);' +
        'action=group_file 群文件(op=list 列目录/url 取下载链接/delete 删除/mkdir 建文件夹/rmdir 删文件夹/upload 上传到指定文件夹);' +
        'action=group_admin 群管扩展(op=member_info/set_admin/unset_admin/set_card/set_name/set_title/leave/' +
        'notice_send/notice_list/notice_delete/essence_list/essence_set/essence_delete/sign/honor/at_all_remain/portrait/system_msg);' +
        'action=react 表情回应(emoji);action=poke 戳一戳;action=forward 合并转发(op=get 读取 forward_id / op=send 发到群或私聊);' +
        'action=account 账号(op=info/version/status/profile/online/categories);action=friend_manage(op=remark/delete/categories);' +
        'action=msg 按 message_id 查消息详情;send/send_group 支持 at(QQ号或 all)与 reply_to(引用消息ID)。' +
        '**action=raw 是任意 NapCat 接口逃生口**(raw_action=NapCat 动作名,raw_params=参数对象;' +
        '用于本工具未命名封装的低频接口,如 send_like/get_group_msg_history/ocr_image/频道接口等;执行前需主人确认)。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'login', 'status', 'reconnect', 'recent', 'sent', 'contacts', 'contact_update', 'chats', 'persona', 'persona_set', 'send',
              'send_group', 'recall', 'zone', 'zone_post', 'zone_delete', 'members', 'friends', 'profile', 'group_info', 'group_manage',
              'sessions', 'session_mute', 'session_bind', 'groups',
              'requests', 'request_handle', 'group_file', 'group_admin', 'react', 'poke', 'account',
              'friend_manage', 'forward', 'msg', 'raw',
            ],
            description: '操作类型',
          },
          user_id: { type: 'string', description: 'send:目标QQ号(发给别人必填;只有正在和对方私聊的会话里可以省略。主人自己的会话里省略不会发给主人)' },
          group_id: { type: 'string', description: 'send_group:目标群号(群会话里省略=当前群,不能改发到别的群);chats:按群过滤;members/group_info/group_manage:目标群' },
          message: { type: 'string', description: 'send/send_group:消息文本' },
          image: { type: 'string', description: 'send/send_group:图片路径或URL(真正发图);zone_post:单张图片(多张用 images)' },
          file: { type: 'string', description: 'send/send_group:本地文件路径(真正上传文件/视频,如 .mp4)' },
          voice: { type: 'string', description: 'send/send_group:语音文件路径或URL(真正发语音条,如 .mp3/.wav/.amr,自动转 QQ silk)' },
          message_id: { type: 'string', description: 'recall:要撤回的消息ID' },
          qq: { type: 'string', description: 'contact_update:联系人QQ;zone:查看谁的动态(缺省主人)' },
          num: { type: 'number', description: 'zone:条数(1-20,缺省10)' },
          images: { type: 'array', items: { type: 'string' }, description: 'zone_post:图片列表(本地路径/URL/base64://,自动上传 QQ 空间相册;单张也可用 image)' },
          ugc_right: { type: 'number', description: 'zone_post:可见范围 1所有人可见(缺省)/4好友可见/16部分好友可见/64仅自己可见/128部分好友不可见' },
          target_uins: { type: 'array', items: { type: 'string' }, description: 'zone_post:ugc_right 为 16/128 时权限作用的 QQ 号列表' },
          tid: { type: 'string', description: 'zone_delete:要删除的说说 tid(zone_post 返回)' },
          name: { type: 'string', description: 'contact_update:备注名' },
          info: { type: 'string', description: 'contact_update:已知信息' },
          source: { type: 'string', enum: ['private', 'group'], description: 'contact_update:认识来源' },
          scope: { type: 'string', description: 'persona_set:会话范围(private:<QQ>/group:<群号>)' },
          persona: { type: 'string', description: 'persona_set:人格描述(空串=删除)' },
          op: { type: 'string', description: 'group_manage:ban/kick/whole_ban;group_file:list/url/delete/mkdir/rmdir/upload;group_admin:member_info/set_admin/unset_admin/set_card/set_name/set_title/leave/notice_send/notice_list/notice_delete/essence_list/essence_set/essence_delete/sign/honor/at_all_remain/portrait/system_msg;forward:get/send;account:info/version/status/profile/online/categories;friend_manage:remark/delete/categories' },
          duration: { type: 'number', description: 'group_manage ban:禁言秒数(0=解除)' },
          enable: { type: 'boolean', description: 'group_manage whole_ban:true开启/false关闭;group_admin leave:true解散群(仅群主)' },
          key: { type: 'string', description: 'session_mute/session_bind:会话键' },
          muted: { type: 'boolean', description: 'session_mute:true屏蔽/false解除' },
          at: { type: 'string', description: 'send_group:要 @ 的 QQ 号或 all(全体成员)' },
          reply_to: { type: 'string', description: 'send/send_group:引用回复的消息 ID' },
          flag: { type: 'string', description: 'request_handle:请求 flag(先 requests 查询)' },
          request_kind: { type: 'string', enum: ['friend', 'group'], description: 'request_handle:请求类型' },
          sub_type: { type: 'string', description: 'request_handle 群请求:add/invite(缺省 add)' },
          approve: { type: 'boolean', description: 'request_handle:true 同意/false 拒绝' },
          file_id: { type: 'string', description: 'group_file:文件 ID' },
          busid: { type: 'number', description: 'group_file:文件 busid(缺省 102)' },
          folder_id: { type: 'string', description: 'group_file:文件夹 ID(list 缺省列根目录)' },
          folder_name: { type: 'string', description: 'group_file mkdir:新文件夹名' },
          folder: { type: 'string', description: 'group_file upload:上传到指定文件夹 ID' },
          emoji: { type: 'string', description: 'react:表情 ID(如 76)或表情名' },
          emoji_set: { type: 'boolean', description: 'react:true 添加(默认)/false 取消' },
          notice_id: { type: 'string', description: 'group_admin notice_delete:公告 ID' },
          content: { type: 'string', description: 'group_admin notice_send:公告内容;zone_post:说说正文(可与 images 至少给一个)' },
          title: { type: 'string', description: 'group_admin set_title:专属头衔' },
          card: { type: 'string', description: 'group_admin set_card:群名片' },
          honor_type: { type: 'string', description: 'group_admin honor:talkative/performer/legend/strong_newbie/emotion/all(缺省 all)' },
          online_status: { type: 'number', description: 'account online:10 在线/30 离开/40 隐身/50 忙碌/60 Q我吧/70 请勿打扰(缺省 10);扩展状态用 ext_status' },
          ext_status: { type: 'number', description: 'account online:扩展状态编号(如 1016 睡觉中,缺省 0)' },
          battery_status: { type: 'number', description: 'account online:电量(缺省 0)' },
          nickname: { type: 'string', description: 'account profile:昵称' },
          company: { type: 'string', description: 'account profile:公司' },
          email: { type: 'string', description: 'account profile:邮箱' },
          college: { type: 'string', description: 'account profile:学校' },
          note: { type: 'string', description: 'account profile:个性签名' },
          remark: { type: 'string', description: 'friend_manage remark:好友备注' },
          forward_id: { type: 'string', description: 'forward get:合并转发 ID' },
          messages: { type: 'array', items: { type: 'string' }, description: 'forward send:要合并转发的文本列表(每条一个节点)' },
          raw_action: { type: 'string', description: 'raw:任意 NapCat 动作名(如 send_like/get_group_msg_history/ocr_image)' },
          raw_params: { type: 'object', additionalProperties: true, description: 'raw:动作参数对象(原样透传给 NapCat)' },
        },
        required: ['action'],
      },
      // 引擎兜底超时覆盖(2026-08-14):file 发视频内部上传等待可达 180s,
      // 引擎默认 60s 统一超时会把上传中途杀掉——QQ 实际收到了但工具报
      // 超时,LLM 误报没发成功(与 xxt/doc_convert 同款审计陷阱)
      timeoutMs: 200_000,
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        const turnCtx = () => ({
          sessionKey: opts.getSessionKey?.() ?? null,
          turnKind: opts.getTurnKind?.() ?? null,
        })
        // send_group 先检查有没有正文;chats 用自己的读取范围。
        // 其余动作只要带了群号,别人的会话就不能指向别的群。
        if (action !== 'send_group' && action !== 'chats') {
          const gid = String(params.group_id ?? '').trim()
          if (gid) {
            const decided = resolveGroupSendTarget({ requested: gid, ...turnCtx() })
            if (!decided.ok) throw new Error(decided.error)
          }
        }
        if (action === 'login') {
          // QQ 扫码登录小窗(2026-09-22):实时二维码(失效前自动换新)+
          // 秒级状态轮询——修复"一直显示过期/扫上了说没扫上"(扫的都是死码)
          if (!deps.openLogin) return '本环境不支持打开登录窗口(宿主未注入)'
          deps.openLogin()
          return (
            '已打开 QQ 扫码登录窗口:用手机 QQ「扫一扫」扫窗口里的二维码,扫完在手机上确认登录。' +
            '二维码会在失效前**自动换新**,一直扫屏幕上这张即可(不要扫截图/旧图);登录成功窗口自动关闭,OneBot 随即可用(正向默认 3001,反向按配置监听)。'
          )
        }
        if (action === 'status') {
          const s = client.status()
          return (
            `NapCat 状态(${s.mode === 'reverse' ? '反向 WS' : '正向 WS'}` +
            `${s.mode === 'reverse' ? `,监听${s.listening ? '中' : '未启动'}` : ''}):` +
            `${s.connected ? '已连接' : s.circuitBroken ? '熔断冷却中(自动重试;action=reconnect 可立即重连)' : '未连接'}(${s.url})` +
            (s.lastError ? `\n最近错误:${s.lastError}` : '') +
            (s.lastClose
              ? `\n最近断开:${s.lastClose.code !== undefined ? `code=${s.lastClose.code} ` : ''}${s.lastClose.reason || '(无关闭帧)'} ` +
                `(${new Date(s.lastClose.at).toLocaleTimeString('zh-CN')}${s.lastClose.wasConnected ? ',断开前已连接' : ',从未连上'})`
              : '') +
            `\n收到消息 ${s.receivedCount} 条,已回复 ${s.repliedCount} 条` +
            `\n主人:${masterQQ() || '(未配置,privacy.json)'}(在 privacy.json 配置)` +
            `\n私聊扩展信任:${s.allowed && s.allowed.length > 0 ? s.allowed.join('、') : '(仅主人)'}` +
            `\n监听群:${s.allowedGroups && s.allowedGroups.length > 0 ? s.allowedGroups.join('、') : '(无)'}`
          )
        }
        if (action === 'reconnect') {
          client.start()
          const s = client.status()
          if (s.connected) return `已重新连接 NapCat(${s.url})`
          return (
            `已触发 NapCat 立即重连(${s.url})` +
            (s.lastError ? `。最近错误:${s.lastError}` : '') +
            '。连接是异步的,稍后 action=status 查看是否已连接。'
          )
        }
        if (action === 'recent') {
          const scope = scopeTranscriptQuery({
            sessionKey: opts.getSessionKey?.() ?? null,
            turnKind: opts.getTurnKind?.() ?? null,
          })
          if (scope.error) throw new Error(scope.error)
          let list = client.getRecentMessages()
          if (scope.groupId) list = list.filter((m) => m.groupId === scope.groupId)
          else if (scope.userId) list = list.filter((m) => !m.groupId && m.qq === scope.userId)
          if (list.length === 0) return '(最近没有收到 QQ 消息)'
          return list.slice(0, 10).map((m) => {
            const who = m.groupId ? `群${m.groupId} QQ${m.qq}` : `QQ${m.qq}`
            return `- ${m.replied ? '[已回复]' : '[未回复]'} ${who}(${new Date(m.time * 1000).toLocaleTimeString('zh-CN')}):${m.text.slice(0, 80)}`
          }).join('\n')
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
        if (action === 'zone_post') {
          // 发表 QQ 空间说说(2026-10-28 接入 NapCat send_qzone_msg):公开发动态
          // 是对外动作,与群公告同级走主人确认门
          const content = String(params.content ?? params.message ?? '').trim()
          const images = [
            ...(Array.isArray(params.images) ? params.images.map((x) => String(x).trim()) : []),
            String(params.image ?? '').trim(),
          ].filter(Boolean)
          if (!content && images.length === 0) throw new Error('zone_post 需要 content(说说正文)或 images(图片)至少一个')
          for (const img of images) {
            if (!/^https?:|^data:image\/|^base64:/.test(img) && !existsSync(img)) {
              throw new Error(`图片不存在:${img}`)
            }
          }
          const ugcRight = params.ugc_right !== undefined ? Math.floor(Number(params.ugc_right)) : 1
          if (![1, 4, 16, 64, 128].includes(ugcRight)) {
            throw new Error('ugc_right 仅支持 1(所有人可见)/4(好友可见)/16(部分好友可见)/64(仅自己可见)/128(部分好友不可见)')
          }
          const targetUins = (Array.isArray(params.target_uins) ? params.target_uins.map((x) => String(x).trim()) : []).filter(Boolean)
          if ((ugcRight === 16 || ugcRight === 128) && targetUins.length === 0) {
            throw new Error('ugc_right 为 16/128 时需要 target_uins(权限作用的 QQ 号列表)')
          }
          const scopeText = ({ 1: '所有人可见', 4: '好友可见', 16: '部分好友可见', 64: '仅自己可见', 128: '部分好友不可见' } as Record<number, string>)[ugcRight] ?? String(ugcRight)
          if (confirmDangerous) {
            const ok = await confirmDangerous(
              'zone_post',
              `确认发表 QQ 空间说说(${scopeText}${images.length ? `,含图片×${images.length}` : ''}):${(content || '(纯图片)').slice(0, 50)}`,
            )
            if (!ok) return '操作已取消(主人未确认)'
          }
          const r = await client.sendQzoneMsg(content, { images, ugcRight, targetUins })
          return (
            `已发表 QQ 空间说说(tid ${r.tid},${scopeText}${images.length ? `,含图片×${images.length}` : ''})` +
            `;删除该说说用 action=zone_delete, tid=${r.tid}`
          )
        }
        if (action === 'zone_delete') {
          const tid = String(params.tid ?? '').trim()
          if (!tid) throw new Error('zone_delete 需要 tid(zone_post 返回的说说 ID)')
          if (confirmDangerous) {
            const ok = await confirmDangerous('zone_delete', `确认删除 QQ 空间说说(tid ${tid})?`)
            if (!ok) return '操作已取消(主人未确认)'
          }
          await client.deleteQzoneMsg(tid)
          return `已删除说说 ${tid}`
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
          const scope = scopeTranscriptQuery({
            sessionKey: opts.getSessionKey?.() ?? null,
            turnKind: opts.getTurnKind?.() ?? null,
            groupId: String(params.group_id ?? ''),
            userId: String(params.user_id ?? ''),
          })
          if (scope.error) throw new Error(scope.error)
          const chats = await client.getChats()
          const qqFilter = scope.userId
          const groupFilter = scope.groupId
          let list = chats
          if (qqFilter) list = list.filter((c) => c.type === 'private' && c.target === qqFilter)
          if (groupFilter) list = list.filter((c) => c.type === 'group' && c.target === groupFilter)
          if (list.length === 0) return '(聊天记录为空' + (qqFilter || groupFilter ? `(按${qqFilter || groupFilter}过滤)` : '') + ')'
          return list.slice(-20).map((c) =>
            `- ${new Date(c.time * 1000).toLocaleString('zh-CN')} [${c.type === 'group' ? `群${c.target}` : `QQ${c.target}`}] ${c.qq}: ${c.text.slice(0, 80)}${c.atMe ? ` ${BOT_MENTION_MARK}` : ''}`
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
          const text = String(params.message ?? '').trim()
          const image = String(params.image ?? '').trim()
          const file = String(params.file ?? '').trim()
          const voice = String(params.voice ?? '').trim()
          const replyTo = String(params.reply_to ?? '').trim()
          if (!text && !image && !file && !voice) throw new Error('send 需要 message/image/file/voice 至少一个')
          const decided = resolvePrivateSendTarget({
            requested: String(params.user_id ?? ''),
            ...turnCtx(),
            masterQQ: opts.getMasterQQ?.() ?? '',
          })
          if (!decided.ok) throw new Error(decided.error)
          const qq = decided.userId
          if (image && !/^https?:|^data:image\//.test(image) && !existsSync(image)) {
            throw new Error(`图片不存在:${image}`)
          }
          const id = await client.sendToQQ(qq, text, {
            image: image || undefined,
            file: file || undefined,
            voice: voice || undefined,
            replyTo: replyTo || undefined,
          })
          return `已发送给 ${qq}(message_id ${id}${image ? ',含图片' : ''}${file ? ',含文件' : ''}${voice ? ',含语音' : ''}${replyTo ? ',引用回复' : ''})`
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
          const self = String(opts.getSelfQQ?.() ?? '').trim()
          const rawText = String(params.message ?? '').trim()
          const text = stripSelfMentions(rawText, self)
          const file = String(params.file ?? '').trim()
          const image = String(params.image ?? '').trim()
          const voice = String(params.voice ?? '').trim()
          const at = String(params.at ?? '').trim()
          const replyTo = String(params.reply_to ?? '').trim()
          const turnKind = opts.getTurnKind?.() ?? null
          if (at === 'all' && !isMasterTurnKind(turnKind)) {
            throw new Error('全体成员艾特只受主人指示')
          }
          if (!text && !file && !image && !voice) {
            if (rawText) throw new Error('这条群消息只剩对自己的艾特,已去掉。请直接说话,不要艾特自己。')
            throw new Error('send_group 需要 message/file/image/voice 至少一个')
          }
          const decided = resolveGroupSendTarget({
            requested: String(params.group_id ?? ''),
            sessionKey: opts.getSessionKey?.() ?? null,
            turnKind,
          })
          if (!decided.ok) throw new Error(decided.error)
          const groupId = decided.groupId
          const atValue = withoutSelfAt(await resolveSendGroupAt(at, text, groupId, turnKind), self)
          if (image && !/^https?:|^data:image\//.test(image) && !existsSync(image)) {
            throw new Error(`图片不存在:${image}`)
          }
          const id = await client.sendToGroup(groupId, text, {
            file: file || undefined,
            image: image || undefined,
            voice: voice || undefined,
            at: atValue,
            replyTo: replyTo || undefined,
          })
          const atLabel = Array.isArray(atValue) ? atValue.join(',') : atValue || ''
          return `已发送到群 ${groupId}${file ? '(含文件)' : ''}${image ? '(含图片)' : ''}${voice ? '(含语音)' : ''}${atLabel ? `(@${atLabel})` : ''}${replyTo ? '(引用回复)' : ''}(message_id ${id})`
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
        if (action === 'groups') {
          // 列出机器人已加入的所有群(2026-08-17 修复"监听群凭空捏造群号"):
          // 让 LLM 有真实群号可查,监听/接入前先调它
          const list = await client.getGroupList()
          if (list.length === 0) return '(机器人尚未加入任何群)'
          return list
            .slice(0, 200)
            .map((g) => `- ${g.group_id}${g.group_name ? `(${g.group_name})` : ''}${g.member_count !== undefined ? `[${g.member_count}人]` : ''}`)
            .join('\n')
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
        if (action === 'requests') {
          const list = client.listPendingRequests()
          if (list.length === 0) return '(没有待处理的好友/群请求)'
          return list.map((r, i) =>
            `${i + 1}. [${r.kind === 'friend' ? '好友' : '群'}] QQ ${r.userId ?? '?'}` +
            `${r.groupId ? ` → 群 ${r.groupId}` : ''}${r.subType ? `(${r.subType})` : ''}` +
            `${r.comment ? ` 附言:${r.comment}` : ''}\n   flag=${r.flag} 时间=${new Date(r.at).toLocaleString('zh-CN')}`
          ).join('\n')
        }
        if (action === 'request_handle') {
          const flag = String(params.flag ?? '').trim()
          if (!flag) throw new Error('request_handle 需要 flag(先 requests 查询)')
          const kind = params.request_kind === 'group' ? 'group' : params.request_kind === 'friend' ? 'friend' : null
          if (!kind) throw new Error('request_handle 需要 request_kind(friend/group)')
          if (typeof params.approve !== 'boolean') throw new Error('request_handle 需要 approve(true 同意/false 拒绝)')
          if (confirmDangerous) {
            const actionText = params.approve ? '同意' : '拒绝'
            const ok = await confirmDangerous('request_handle', `确认${actionText}该${kind === 'friend' ? '好友' : '加群'}请求?`)
            if (!ok) return '操作已取消(主人未确认)'
          }
          await client.handleAddRequest(kind, flag, params.approve, params.sub_type !== undefined ? String(params.sub_type) : undefined)
          return `已${params.approve ? '同意' : '拒绝'}该${kind === 'friend' ? '好友' : '加群'}请求`
        }
        if (action === 'group_file') {
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('group_file 需要 group_id')
          const op = String(params.op ?? 'list').trim()
          const folderId = String(params.folder_id ?? '').trim()
          const fileId = String(params.file_id ?? '').trim()
          const busid = params.busid !== undefined ? Math.floor(Number(params.busid)) : 102
          if (op === 'list') {
            const r = folderId ? await client.getGroupFiles(groupId, folderId) : await client.getGroupRootFiles(groupId)
            if (r.files.length === 0 && r.folders.length === 0) return folderId ? `(文件夹 ${folderId} 为空)` : '(群文件根目录为空)'
            const lines: string[] = []
            for (const f of r.folders) {
              lines.push(`- [文件夹] ${f.folder_name}(folder_id ${f.folder_id}${f.total_file_count !== undefined ? `,${f.total_file_count}个文件` : ''})`)
            }
            for (const f of r.files) {
              lines.push(
                `- [文件] ${f.file_name}(file_id ${f.file_id},busid ${f.busid ?? 102}` +
                `${f.file_size !== undefined ? `,${fmtSize(f.file_size)}` : ''}` +
                `${f.uploader_name ? `,上传者 ${f.uploader_name}` : ''})`,
              )
            }
            return lines.join('\n')
          }
          if (op === 'url') {
            if (!fileId) throw new Error('group_file url 需要 file_id')
            const url = await client.getGroupFileUrl(groupId, fileId, busid)
            if (!url) throw new Error('群文件下载链接为空(NapCat 未返回 url)')
            return `群文件下载链接:${url}`
          }
          if (op === 'delete') {
            if (!fileId) throw new Error('group_file delete 需要 file_id')
            if (confirmDangerous) {
              const ok = await confirmDangerous('group_file', `确认删除群 ${groupId} 的文件 ${fileId}?`)
              if (!ok) return '操作已取消(主人未确认)'
            }
            await client.deleteGroupFile(groupId, fileId, busid)
            return `已删除群文件 ${fileId}`
          }
          if (op === 'mkdir') {
            const name = String(params.folder_name ?? '').trim()
            if (!name) throw new Error('group_file mkdir 需要 folder_name')
            await client.createGroupFolder(groupId, name, folderId || undefined)
            return `已在${folderId ? `文件夹 ${folderId}` : '根目录'}创建文件夹「${name}」`
          }
          if (op === 'rmdir') {
            if (!folderId) throw new Error('group_file rmdir 需要 folder_id')
            if (confirmDangerous) {
              const ok = await confirmDangerous('group_file', `确认删除群 ${groupId} 的文件夹 ${folderId}?`)
              if (!ok) return '操作已取消(主人未确认)'
            }
            await client.deleteGroupFolder(groupId, folderId)
            return `已删除群文件夹 ${folderId}`
          }
          if (op === 'upload') {
            const file = String(params.file ?? '').trim()
            if (!file) throw new Error('group_file upload 需要 file(本地绝对路径)')
            if (!existsSync(file)) throw new Error(`文件不存在:${file}`)
            await client.uploadGroupFile(groupId, file, undefined, folderId || undefined)
            return `已上传文件到群 ${groupId}${folderId ? ` 文件夹 ${folderId}` : ''}`
          }
          throw new Error('group_file op 仅支持 list/url/delete/mkdir/rmdir/upload')
        }
        if (action === 'group_admin') {
          const op = String(params.op ?? '').trim()
          if (!op) throw new Error('group_admin 需要 op')
          const groupId = String(params.group_id ?? '').trim()
          const needGroup = op !== 'system_msg' && op !== 'essence_set' && op !== 'essence_delete'
          if (!groupId && needGroup) throw new Error('group_admin 需要 group_id')
          const qq = String(params.user_id ?? '').trim()
          if (op === 'member_info') {
            if (!qq) throw new Error('member_info 需要 user_id')
            const m = await client.getGroupMemberInfo(groupId, qq)
            return (
              `群 ${groupId} 成员 QQ ${qq}:` +
              `${m.nickname ? `昵称${m.nickname}` : ''}` +
              `${m.card ? `,群名片${m.card}` : ''}` +
              `${m.role ? `,角色${m.role}` : ''}` +
              `${m.level !== undefined ? `,等级${m.level}` : ''}` +
              `${m.join_time !== undefined ? `,入群时间${new Date(Number(m.join_time) * 1000).toLocaleString('zh-CN')}` : ''}`
            )
          }
          if (op === 'set_admin' || op === 'unset_admin') {
            if (!qq) throw new Error(`${op} 需要 user_id`)
            const enable = op === 'set_admin'
            if (confirmDangerous) {
              const ok = await confirmDangerous('group_admin', `确认${enable ? '设置' : '取消'} QQ ${qq} 为群 ${groupId} 管理员?`)
              if (!ok) return '操作已取消(主人未确认)'
            }
            await client.setGroupAdmin(groupId, qq, enable)
            return `已${enable ? '设置' : '取消'} QQ ${qq} 的管理员身份`
          }
          if (op === 'set_card') {
            if (!qq) throw new Error('set_card 需要 user_id')
            const card = String(params.card ?? '').trim()
            await client.setGroupCard(groupId, qq, card)
            return card ? `已设置 QQ ${qq} 的群名片为「${card}」` : `已清空 QQ ${qq} 的群名片`
          }
          if (op === 'set_name') {
            const name = String(params.name ?? '').trim()
            if (!name) throw new Error('set_name 需要 name(新群名)')
            if (confirmDangerous) {
              const ok = await confirmDangerous('group_admin', `确认把群 ${groupId} 改名为「${name}」?`)
              if (!ok) return '操作已取消(主人未确认)'
            }
            await client.setGroupName(groupId, name)
            return `已把群 ${groupId} 改名为「${name}」`
          }
          if (op === 'set_title') {
            if (!qq) throw new Error('set_title 需要 user_id')
            const title = String(params.title ?? '').trim()
            await client.setGroupSpecialTitle(groupId, qq, title)
            return title ? `已设置 QQ ${qq} 的头衔为「${title}」` : `已清空 QQ ${qq} 的头衔`
          }
          if (op === 'leave') {
            if (confirmDangerous) {
              const ok = await confirmDangerous('group_admin', `确认让机器人${params.enable ? '解散' : '退出'}群 ${groupId}?`)
              if (!ok) return '操作已取消(主人未确认)'
            }
            await client.leaveGroup(groupId, params.enable === true)
            return `已${params.enable ? '解散' : '退出'}群 ${groupId}`
          }
          if (op === 'notice_send') {
            const content = String(params.content ?? params.message ?? '').trim()
            if (!content) throw new Error('notice_send 需要 content')
            if (confirmDangerous) {
              const ok = await confirmDangerous('group_admin', `确认在群 ${groupId} 发布公告?`)
              if (!ok) return '操作已取消(主人未确认)'
            }
            await client.sendGroupNotice(groupId, content)
            return `已发布群公告`
          }
          if (op === 'notice_list') {
            const list = await client.getGroupNotices(groupId)
            if (list.length === 0) return '(该群没有公告)'
            return list.map((n, i) =>
              `${i + 1}. [${n.id}]${n.publish_time ? ` ${new Date(n.publish_time * 1000).toLocaleString('zh-CN')}` : ''}` +
              `${n.sender_id ? ` 发布者 ${n.sender_id}` : ''}:${String(n.content ?? n.message?.text ?? '').slice(0, 120)}`
            ).join('\n')
          }
          if (op === 'notice_delete') {
            const noticeId = String(params.notice_id ?? '').trim()
            if (!noticeId) throw new Error('notice_delete 需要 notice_id')
            if (confirmDangerous) {
              const ok = await confirmDangerous('group_admin', `确认删除群 ${groupId} 的公告 ${noticeId}?`)
              if (!ok) return '操作已取消(主人未确认)'
            }
            await client.deleteGroupNotice(groupId, noticeId)
            return `已删除群公告 ${noticeId}`
          }
          if (op === 'sign') {
            await client.setGroupSign(groupId)
            return `已在群 ${groupId} 签到`
          }
          if (op === 'honor') {
            const type = String(params.honor_type ?? 'all').trim()
            const data = await client.getGroupHonorInfo(groupId, type)
            return `群 ${groupId} 荣誉(${type}):\n${jsonBrief(data)}`
          }
          if (op === 'at_all_remain') {
            const data = await client.getGroupAtAllRemain(groupId)
            return `群 ${groupId} @全体剩余:\n${jsonBrief(data)}`
          }
          if (op === 'portrait') {
            const file = String(params.file ?? '').trim()
            if (!file) throw new Error('portrait 需要 file(本地绝对路径或 http(s) URL)')
            if (!/^https?:/i.test(file) && !existsSync(file)) throw new Error(`文件不存在:${file}`)
            if (confirmDangerous) {
              const ok = await confirmDangerous('group_admin', `确认更换群 ${groupId} 的头像?`)
              if (!ok) return '操作已取消(主人未确认)'
            }
            await client.setGroupPortrait(groupId, file)
            return `已更换群 ${groupId} 的头像`
          }
          if (op === 'system_msg') {
            const data = await client.getGroupSystemMsg()
            return `群系统消息:\n${jsonBrief(data)}`
          }
          if (op === 'essence_list') {
            const list = await client.getEssenceMsgList(groupId)
            if (list.length === 0) return '(该群没有精华消息)'
            return list.slice(0, 50).map((raw, i) => {
              const m = (raw ?? {}) as Record<string, unknown>
              return `${i + 1}. [${m.message_id ?? '?'}] ${String(m.sender_nick ?? m.sender_id ?? '')}: ${napcatMessageText(m.content ?? '').slice(0, 100)}`
            }).join('\n')
          }
          if (op === 'essence_set') {
            const messageId = String(params.message_id ?? '').trim()
            if (!messageId) throw new Error('essence_set 需要 message_id')
            await client.setEssenceMsg(messageId)
            return `已把消息 ${messageId} 设为精华`
          }
          if (op === 'essence_delete') {
            const messageId = String(params.message_id ?? '').trim()
            if (!messageId) throw new Error('essence_delete 需要 message_id')
            await client.deleteEssenceMsg(messageId)
            return `已把消息 ${messageId} 移出精华`
          }
          throw new Error('group_admin op 不支持')
        }
        if (action === 'react') {
          const messageId = String(params.message_id ?? '').trim()
          if (!messageId) throw new Error('react 需要 message_id')
          const emoji = String(params.emoji ?? '').trim()
          if (!emoji) throw new Error('react 需要 emoji(表情 ID 或表情名)')
          await client.setMsgEmojiLike(messageId, emoji, params.emoji_set !== false)
          return `已${params.emoji_set === false ? '取消' : '添加'}消息 ${messageId} 的表情回应`
        }
        if (action === 'poke') {
          const qq = String(params.user_id ?? '').trim()
          if (!qq) throw new Error('poke 需要 user_id')
          const groupId = String(params.group_id ?? '').trim()
          await client.sendPoke(qq, groupId || undefined)
          return `已戳一戳 ${qq}${groupId ? `(群 ${groupId})` : ''}`
        }
        if (action === 'account') {
          const op = String(params.op ?? 'info').trim()
          if (op === 'info') {
            const info = await client.getLoginInfo()
            return `机器人账号:QQ ${info.user_id ?? '?'}${info.nickname ? `(${info.nickname})` : ''}`
          }
          if (op === 'version') return `NapCat 版本信息:\n${jsonBrief(await client.getVersionInfo())}`
          if (op === 'status') return `账号状态:\n${jsonBrief(await client.getAccountStatus())}`
          if (op === 'categories') return `好友分组:\n${jsonBrief(await client.getFriendCategories())}`
          if (op === 'profile') {
            const patch = {
              nickname: String(params.nickname ?? '').trim() || undefined,
              company: String(params.company ?? '').trim() || undefined,
              email: String(params.email ?? '').trim() || undefined,
              college: String(params.college ?? '').trim() || undefined,
              personalNote: String(params.note ?? '').trim() || undefined,
            }
            if (!Object.values(patch).some(Boolean)) throw new Error('account profile 至少提供 nickname/company/email/college/note 之一')
            if (confirmDangerous) {
              const ok = await confirmDangerous('account', '确认修改机器人 QQ 资料?')
              if (!ok) return '操作已取消(主人未确认)'
            }
            await client.setProfile(patch)
            return '已更新机器人资料'
          }
          if (op === 'online') {
            const status = params.online_status !== undefined ? Math.floor(Number(params.online_status)) : 10
            if (![10, 30, 40, 50, 60, 70].includes(status)) {
              throw new Error('online_status 需要 10/30/40/50/60/70(在线/离开/隐身/忙碌/Q我吧/勿扰)')
            }
            const extStatus = params.ext_status !== undefined ? Math.floor(Number(params.ext_status)) : 0
            const batteryStatus = params.battery_status !== undefined ? Math.floor(Number(params.battery_status)) : 0
            await client.setOnlineStatus(status, extStatus, batteryStatus)
            return `已设置在线状态 status=${status} ext_status=${extStatus}`
          }
          throw new Error('account op 仅支持 info/version/status/profile/online/categories')
        }
        if (action === 'friend_manage') {
          const op = String(params.op ?? '').trim()
          const qq = String(params.user_id ?? '').trim()
          if (op === 'remark') {
            if (!qq) throw new Error('friend_manage remark 需要 user_id')
            const remark = String(params.remark ?? '').trim()
            await client.setFriendRemark(qq, remark)
            return remark ? `已把 QQ ${qq} 的备注设为「${remark}」` : `已清空 QQ ${qq} 的备注`
          }
          if (op === 'delete') {
            if (!qq) throw new Error('friend_manage delete 需要 user_id')
            if (confirmDangerous) {
              const ok = await confirmDangerous('friend_manage', `确认删除好友 QQ ${qq}?`)
              if (!ok) return '操作已取消(主人未确认)'
            }
            await client.deleteFriend(qq)
            return `已删除好友 QQ ${qq}`
          }
          if (op === 'categories') return `好友分组:\n${jsonBrief(await client.getFriendCategories())}`
          throw new Error('friend_manage op 仅支持 remark/delete/categories')
        }
        if (action === 'forward') {
          const op = String(params.op ?? '').trim()
          if (op === 'get') {
            const forwardId = String(params.forward_id ?? params.message_id ?? '').trim()
            if (!forwardId) throw new Error('forward get 需要 forward_id')
            const f = await client.getForward(forwardId)
            const resourceLines: string[] = []
            const ref = (x: { file?: string; url?: string }) => x.url || x.file || ''
            f.media.images.forEach((x, i) => resourceLines.push(`图片${i + 1}: ${ref(x)}`))
            f.media.voices.forEach((x, i) => resourceLines.push(`语音${i + 1}: ${ref(x)}`))
            f.media.videos.forEach((x, i) => resourceLines.push(`视频${i + 1}: ${ref(x)}`))
            f.media.files.forEach((x, i) => resourceLines.push(`文件${i + 1}(${x.name || '未命名'}): ${ref(x)}`))
            const body = f.text || '(无文本)'
            const resources = resourceLines.length > 0 ? `\n【媒体资源】\n${resourceLines.join('\n')}` : ''
            const nested = f.nestedIds.length > 0 ? `\n【嵌套合并转发 ID】${f.nestedIds.join(', ')}(可继续 forward get 展开)` : ''
            return `合并转发内容:\n${body}${resources}${nested}`
          }
          if (op === 'send') {
            const raw = params.messages
            const list = Array.isArray(raw) ? raw.map((x) => String(x)).filter(Boolean) : []
            if (list.length === 0) throw new Error('forward send 需要 messages(文本数组)')
            let groupId = String(params.group_id ?? '').trim()
            const userId = String(params.user_id ?? '').trim()
            if (groupId) {
              const decided = resolveGroupSendTarget({
                requested: groupId,
                sessionKey: opts.getSessionKey?.() ?? null,
                turnKind: opts.getTurnKind?.() ?? null,
              })
              if (!decided.ok) throw new Error(decided.error)
              groupId = decided.groupId
            }
            if (!groupId && userId) {
              const who = resolvePrivateSendTarget({
                requested: userId,
                ...turnCtx(),
                masterQQ: opts.getMasterQQ?.() ?? '',
              })
              if (!who.ok) throw new Error(who.error)
            }
            if (!groupId && !userId) throw new Error('forward send 需要 group_id 或 user_id')
            const id = await client.sendForward({ groupId: groupId || undefined, userId: userId || undefined, messages: list })
            return `已发送合并转发(${list.length} 条节点${id ? `,message_id ${id}` : ''})`
          }
          throw new Error('forward op 仅支持 get/send')
        }
        if (action === 'msg') {
          const messageId = String(params.message_id ?? '').trim()
          if (!messageId) throw new Error('msg 需要 message_id')
          const m = await client.getMessage(messageId)
          if (!m) return `(找不到消息 ${messageId})`
          const sender = (m.sender ?? {}) as Record<string, unknown>
          const text = napcatMessageText(m.message ?? m.raw_message ?? '')
          return (
            `消息 ${messageId}:` +
            `${sender.nickname ? `发送者${sender.nickname}` : ''}${sender.user_id ? `(QQ ${sender.user_id})` : ''}` +
            `${m.message_type === 'group' ? `,群 ${m.group_id}` : ',私聊'}` +
            `\n${text || '(无文本)'}`
          )
        }
        if (action === 'raw') {
          const rawAction = String(params.raw_action ?? '').trim()
          if (!rawAction) throw new Error('raw 需要 raw_action(NapCat 动作名)')
          if (!/^[A-Za-z_.][\w.]*$/.test(rawAction)) throw new Error('raw_action 格式非法')
          const rawParams = (params.raw_params ?? {}) as Record<string, unknown>
          const rawGroup = rawParams.group_id !== undefined && rawParams.group_id !== null ? String(rawParams.group_id).trim() : ''
          if (rawGroup) {
            const decided = resolveGroupSendTarget({ requested: rawGroup, ...turnCtx() })
            if (!decided.ok) throw new Error(decided.error)
          }
          const rawUser = rawParams.user_id !== undefined && rawParams.user_id !== null ? String(rawParams.user_id).trim() : ''
          if (rawUser) {
            const who = resolvePrivateSendTarget({
              requested: rawUser,
              ...turnCtx(),
              masterQQ: opts.getMasterQQ?.() ?? '',
            })
            if (!who.ok) throw new Error(who.error)
          }
          if (confirmDangerous) {
            const ok = await confirmDangerous('raw', `确认直接执行 NapCat 动作 ${rawAction}?`)
            if (!ok) return '操作已取消(主人未确认)'
          }
          const res = await client.callRaw(rawAction, rawParams)
          return `${rawAction} 返回:\n${jsonBrief(res)}`
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
        '**私聊是否自主回复由 set_napcat_config 的 autoReply(默认开启)与扩展信任名单共同决定**:' +
        '主人要求「以后私聊都你自己决定回复/不用问我」→ set_napcat_config(autoReply=true);' +
        '要求「还是先问我」→ autoReply=false;只让某个 QQ 自主/恢复先问 → watch/unwatch 该 QQ;' +
        '口头答应不会改变路由,必须调用工具落地;' +
        '**监听群必须用真实群号**:先调 napcat 工具 action=groups 列出机器人已加入的群,取其中的群号再 watch,' +
        'watch 会校验群号必须是机器人已加入的真实群,凭群名猜/编造的群号会被拒绝;' +
        'action=unwatch 移出监听名单(不再自动回复);' +
        'action=mute/unmute 屏蔽/解除屏蔽会话(消息仍记录但不自动回复);' +
        'action=bind 在挂件会话面板中打开指定会话。' +
        '**监听/信任管理一律走本工具或 set_napcat_config,禁止用 write_file/exec_command 直接修改 NapCat 配置文件' +
        '(napcat.json/config 目录)——手改会写坏配置导致 NapCat 无法启动、QQ 消息全部失联。**',
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
          // 主人 QQ 私聊固定进入主对话(2026-10-23):主人消息与对话窗口
          // 共享同一引擎/上下文,不存在独立的 private:<主人QQ> 外部会话——
          // watch/unwatch 直接如实说明,不落监听名单(避免出现重复会话入口)
          if (kind === 'private' && String(opts.getMasterQQ?.() ?? '').trim() === id) {
            return '主人 QQ 的私聊已固定进入主对话窗口(与对话窗口共享上下文,媒体/视频直接在主对话窗口播放),无需监听,也不存在独立的主人 QQ 会话'
          }
          // 群号真实性校验(2026-08-17 修复"凭空捏造群号"):只允许监听
          // 机器人**已加入**的真实群,防止 LLM 凭群名猜/编造群号落盘
          let hitGroupName = ''
          if (kind === 'group') {
            let realGroups: Array<{ group_id: string; group_name?: string }> = []
            try {
              realGroups = await client.getGroupList()
            } catch { realGroups = [] }
            const hit = realGroups.find((g) => g.group_id === id)
            if (!hit) {
              throw new Error(
                `群 ${id} 不在机器人已加入的群列表中,无法监听(机器人未加入该群或群号有误)。` +
                `请先调用 napcat 工具 action=groups 查看机器人已加入的真实群号,再用其中的群号 watch;` +
                `不要凭群名猜测或编造群号。`
              )
            }
            hitGroupName = hit.group_name || ''
          }
          if (action === 'watch') {
            client.watchSession?.(kind, id)
            if (kind === 'group') {
              return hitGroupName
                ? `已将群 ${id}(${hitGroupName})加入监听名单——群消息将自动回复,会话面板已出现该会话条目`
                : `已将群 ${id} 加入监听名单——群消息将自动回复,会话面板已出现该会话条目`
            }
            return `已将 QQ ${id} 加入监听名单(扩展信任)——其私聊消息将自动回复,会话面板已出现该会话条目`
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

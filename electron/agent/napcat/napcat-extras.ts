/**
 * NapCat 扩展能力(2026-10-25 全量适配)
 *
 * 与 napcat-client 的边界:本模块只做「OneBot 动作封装」——群文件、群管
 * 扩展、账号/好友、表情回应/戳一戳、合并转发;零 IO、零状态、单向依赖
 * napcat-message/napcat-text 的纯函数,由 napcat-client 注入 callAction
 * 后合并进 NapcatClient。连接/重连/去重/媒体落地仍归 napcat-client。
 */

import { buildForwardNodes } from './napcat-text'
import {
  napcatForwardMedia,
  napcatForwardNestedIds,
  napcatForwardText,
  type NapcatForwardMedia,
} from './napcat-message'

/** 注入的动作调用器(napcat-client 的 callAction) */
export type NapcatCall = <T = unknown>(
  action: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<T>

export interface NapcatGroupFile {
  file_id: string
  file_name: string
  file_size?: number
  busid?: number
  upload_time?: number
  dead_time?: number
  modify_time?: number
  download_times?: number
  uploader?: number
  uploader_name?: string
}

export interface NapcatGroupFolder {
  folder_id: string
  folder_name: string
  total_file_count?: number
  create_time?: number
  creator?: number
  creator_name?: string
}

export interface NapcatGroupFilesResult {
  files: NapcatGroupFile[]
  folders: NapcatGroupFolder[]
}

export interface NapcatGroupNotice {
  id: string
  sender_id?: number
  publish_time?: number
  content?: string
  message?: { text?: string; images?: Array<{ id?: string; height?: number; width?: number }> }
}

export interface NapcatForwardResult {
  text: string
  raw: unknown
  /** 节点里的图片/语音/视频/文件资源(2026-10-27:不再只有 [图片] 占位) */
  media: NapcatForwardMedia
  /** 节点里嵌套的合并转发 ID(2026-10-27:可限深继续展开) */
  nestedIds: string[]
}

export interface NapcatExtras {
  // ---- 群文件 ----
  getGroupRootFiles(groupId: string): Promise<NapcatGroupFilesResult>
  getGroupFiles(groupId: string, folderId: string): Promise<NapcatGroupFilesResult>
  getGroupFileUrl(groupId: string, fileId: string, busid?: number): Promise<string>
  deleteGroupFile(groupId: string, fileId: string, busid?: number): Promise<void>
  createGroupFolder(groupId: string, name: string, parentId?: string): Promise<void>
  deleteGroupFolder(groupId: string, folderId: string): Promise<void>
  uploadGroupFile(groupId: string, file: string, name?: string, folder?: string): Promise<void>

  // ---- 群管扩展 ----
  getGroupMemberInfo(groupId: string, qq: string): Promise<Record<string, unknown>>
  setGroupAdmin(groupId: string, qq: string, enable: boolean): Promise<void>
  setGroupCard(groupId: string, qq: string, card: string): Promise<void>
  setGroupName(groupId: string, name: string): Promise<void>
  setGroupSpecialTitle(groupId: string, qq: string, title: string): Promise<void>
  leaveGroup(groupId: string, dismiss?: boolean): Promise<void>
  setGroupSign(groupId: string): Promise<void>
  getGroupHonorInfo(groupId: string, type?: string): Promise<Record<string, unknown>>
  getGroupAtAllRemain(groupId: string): Promise<Record<string, unknown>>
  setGroupPortrait(groupId: string, file: string): Promise<void>
  sendGroupNotice(groupId: string, content: string): Promise<void>
  getGroupNotices(groupId: string): Promise<NapcatGroupNotice[]>
  deleteGroupNotice(groupId: string, noticeId: string): Promise<void>
  getGroupSystemMsg(): Promise<Record<string, unknown>>
  getEssenceMsgList(groupId: string): Promise<unknown[]>
  setEssenceMsg(messageId: string): Promise<void>
  deleteEssenceMsg(messageId: string): Promise<void>

  // ---- 账号 / 好友 ----
  getLoginInfo(): Promise<{ user_id?: string; nickname?: string }>
  getVersionInfo(): Promise<Record<string, unknown>>
  getAccountStatus(): Promise<Record<string, unknown>>
  setProfile(patch: {
    nickname?: string
    company?: string
    email?: string
    college?: string
    personalNote?: string
  }): Promise<void>
  setOnlineStatus(status: number, extStatus?: number, batteryStatus?: number): Promise<void>
  getFriendCategories(): Promise<unknown>
  setFriendRemark(qq: string, remark: string): Promise<void>
  deleteFriend(qq: string): Promise<void>

  // ---- 消息增强 ----
  getMessage(messageId: string, timeoutMs?: number): Promise<Record<string, unknown> | null>
  setMsgEmojiLike(messageId: string, emojiId: string, set?: boolean): Promise<void>
  sendPoke(userId: string, groupId?: string): Promise<void>
  getForward(forwardId: string, timeoutMs?: number): Promise<NapcatForwardResult>
  sendForward(opts: { groupId?: string; userId?: string; messages: string[] }): Promise<string>
  handleAddRequest(
    kind: 'friend' | 'group',
    flag: string,
    approve: boolean,
    subType?: string,
  ): Promise<void>
}

function dataOf<T>(res: unknown, fallback: T): T {
  const d = (res as { data?: T } | null)?.data
  return (d ?? fallback) as T
}

function normalizeFiles(data: Record<string, unknown>): NapcatGroupFilesResult {
  const files = Array.isArray(data.files)
    ? (data.files as Array<Record<string, unknown>>).map((f) => ({
        file_id: String(f.file_id ?? ''),
        file_name: String(f.file_name ?? ''),
        file_size: typeof f.file_size === 'number' ? f.file_size : undefined,
        busid: typeof f.busid === 'number' ? f.busid : undefined,
        upload_time: typeof f.upload_time === 'number' ? f.upload_time : undefined,
        dead_time: typeof f.dead_time === 'number' ? f.dead_time : undefined,
        modify_time: typeof f.modify_time === 'number' ? f.modify_time : undefined,
        download_times: typeof f.download_times === 'number' ? f.download_times : undefined,
        uploader: typeof f.uploader === 'number' ? f.uploader : undefined,
        uploader_name: f.uploader_name !== undefined ? String(f.uploader_name) : undefined,
      }))
    : []
  const folders = Array.isArray(data.folders)
    ? (data.folders as Array<Record<string, unknown>>).map((f) => ({
        folder_id: String(f.folder_id ?? ''),
        folder_name: String(f.folder_name ?? ''),
        total_file_count: typeof f.total_file_count === 'number' ? f.total_file_count : undefined,
        create_time: typeof f.create_time === 'number' ? f.create_time : undefined,
        creator: typeof f.creator === 'number' ? f.creator : undefined,
        creator_name: f.creator_name !== undefined ? String(f.creator_name) : undefined,
      }))
    : []
  return { files, folders }
}

export function createNapcatExtras(call: NapcatCall, getBotQQ: () => string): NapcatExtras {
  return {
    // ---- 群文件 ----
    async getGroupRootFiles(groupId) {
      const res = await call('get_group_root_files', { group_id: groupId })
      return normalizeFiles(dataOf<Record<string, unknown>>(res, {}))
    },
    async getGroupFiles(groupId, folderId) {
      const res = await call('get_group_files_by_folder', { group_id: groupId, folder_id: folderId })
      return normalizeFiles(dataOf<Record<string, unknown>>(res, {}))
    },
    async getGroupFileUrl(groupId, fileId, busid) {
      const res = await call('get_group_file_url', {
        group_id: groupId,
        file_id: fileId,
        busid: busid ?? 102,
      })
      const d = dataOf<Record<string, unknown>>(res, {})
      return String(d.url ?? '')
    },
    async deleteGroupFile(groupId, fileId, busid) {
      await call('delete_group_file', { group_id: groupId, file_id: fileId, busid: busid ?? 102 })
    },
    async createGroupFolder(groupId, name, parentId) {
      await call('create_group_file_folder', {
        group_id: groupId,
        name,
        parent_id: parentId ?? '/',
      })
    },
    async deleteGroupFolder(groupId, folderId) {
      await call('delete_group_folder', { group_id: groupId, folder_id: folderId })
    },
    async uploadGroupFile(groupId, file, name, folder) {
      await call('upload_group_file', {
        group_id: groupId,
        file,
        name: name ?? file.split(/[\\/]/).pop() ?? 'file',
        ...(folder ? { folder } : {}),
      }, 180_000)
    },

    // ---- 群管扩展 ----
    async getGroupMemberInfo(groupId, qq) {
      const res = await call('get_group_member_info', {
        group_id: groupId,
        user_id: qq,
        no_cache: true,
      })
      return dataOf<Record<string, unknown>>(res, {})
    },
    async setGroupAdmin(groupId, qq, enable) {
      await call('set_group_admin', { group_id: groupId, user_id: qq, enable })
    },
    async setGroupCard(groupId, qq, card) {
      await call('set_group_card', { group_id: groupId, user_id: qq, card })
    },
    async setGroupName(groupId, name) {
      await call('set_group_name', { group_id: groupId, group_name: name })
    },
    async setGroupSpecialTitle(groupId, qq, title) {
      await call('set_group_special_title', {
        group_id: groupId,
        user_id: qq,
        special_title: title,
      })
    },
    async leaveGroup(groupId, dismiss) {
      await call('set_group_leave', { group_id: groupId, is_dismiss: !!dismiss })
    },
    async setGroupSign(groupId) {
      await call('set_group_sign', { group_id: groupId })
    },
    async getGroupHonorInfo(groupId, type) {
      const res = await call('get_group_honor_info', {
        group_id: groupId,
        type: type ?? 'all',
      })
      return dataOf<Record<string, unknown>>(res, {})
    },
    async getGroupAtAllRemain(groupId) {
      const res = await call('get_group_at_all_remain', { group_id: groupId })
      return dataOf<Record<string, unknown>>(res, {})
    },
    async setGroupPortrait(groupId, file) {
      await call('set_group_portrait', { group_id: groupId, file, cache: 0 })
    },
    async sendGroupNotice(groupId, content) {
      await call('_send_group_notice', { group_id: groupId, content })
    },
    async getGroupNotices(groupId) {
      const res = await call('_get_group_notice', { group_id: groupId })
      const d = dataOf<unknown>(res, [])
      const list = Array.isArray(d)
        ? d
        : Array.isArray((d as { notices?: unknown[] })?.notices)
          ? (d as { notices: unknown[] }).notices
          : []
      return list.map((n) => {
        const raw = (n ?? {}) as Record<string, unknown>
        return {
          id: String(raw.id ?? raw.notice_id ?? ''),
          sender_id: typeof raw.sender_id === 'number' ? raw.sender_id : undefined,
          publish_time: typeof raw.publish_time === 'number' ? raw.publish_time : undefined,
          content: raw.content !== undefined ? String(raw.content) : undefined,
          message: raw.message as NapcatGroupNotice['message'],
        }
      })
    },
    async deleteGroupNotice(groupId, noticeId) {
      await call('_del_group_notice', { group_id: groupId, notice_id: noticeId })
    },
    async getGroupSystemMsg() {
      const res = await call('get_group_system_msg', {})
      return dataOf<Record<string, unknown>>(res, {})
    },
    async getEssenceMsgList(groupId) {
      const res = await call('get_essence_msg_list', { group_id: groupId })
      const d = dataOf<unknown>(res, [])
      return Array.isArray(d) ? d : []
    },
    async setEssenceMsg(messageId) {
      await call('set_essence_msg', { message_id: messageId })
    },
    async deleteEssenceMsg(messageId) {
      await call('delete_essence_msg', { message_id: messageId })
    },

    // ---- 账号 / 好友 ----
    async getLoginInfo() {
      const res = await call('get_login_info', {})
      const d = dataOf<Record<string, unknown>>(res, {})
      return {
        user_id: d.user_id !== undefined ? String(d.user_id) : undefined,
        nickname: d.nickname !== undefined ? String(d.nickname) : undefined,
      }
    },
    async getVersionInfo() {
      const res = await call('get_version_info', {})
      return dataOf<Record<string, unknown>>(res, {})
    },
    async getAccountStatus() {
      const res = await call('get_status', {})
      return dataOf<Record<string, unknown>>(res, {})
    },
    async setProfile(patch) {
      await call('set_qq_profile', {
        ...(patch.nickname ? { nickname: patch.nickname } : {}),
        ...(patch.company ? { company: patch.company } : {}),
        ...(patch.email ? { email: patch.email } : {}),
        ...(patch.college ? { college: patch.college } : {}),
        ...(patch.personalNote ? { personal_note: patch.personalNote } : {}),
      })
    },
    async setOnlineStatus(status, extStatus, batteryStatus) {
      await call('set_online_status', {
        status,
        ext_status: extStatus ?? 0,
        battery_status: batteryStatus ?? 0,
      })
    },
    async getFriendCategories() {
      const res = await call('get_friends_with_category', {})
      return dataOf<unknown>(res, [])
    },
    async setFriendRemark(qq, remark) {
      await call('set_friend_remark', { user_id: qq, remark })
    },
    async deleteFriend(qq) {
      await call('delete_friend', { user_id: qq })
    },

    // ---- 消息增强 ----
    async getMessage(messageId, timeoutMs) {
      const res = await call('get_msg', { message_id: messageId }, timeoutMs)
      return dataOf<Record<string, unknown> | null>(res, null)
    },
    async setMsgEmojiLike(messageId, emojiId, set) {
      await call('set_msg_emoji_like', {
        message_id: messageId,
        emoji_id: emojiId,
        ...(set !== undefined ? { set } : {}),
      })
    },
    async sendPoke(userId, groupId) {
      await call('send_poke', {
        user_id: userId,
        ...(groupId ? { group_id: groupId } : {}),
      })
    },
    async getForward(forwardId, timeoutMs) {
      const res = await call('get_forward_msg', { id: forwardId }, timeoutMs)
      const d = dataOf<unknown>(res, {})
      return {
        text: napcatForwardText(d),
        raw: d,
        media: napcatForwardMedia(d),
        nestedIds: napcatForwardNestedIds(d),
      }
    },
    async sendForward(opts) {
      const messages = buildForwardNodes(opts.messages, getBotQQ())
      if (messages.length === 0) return ''
      const params: Record<string, unknown> = { messages }
      if (opts.groupId) {
        params.message_type = 'group'
        params.group_id = opts.groupId
      } else if (opts.userId) {
        params.message_type = 'private'
        params.user_id = opts.userId
      } else {
        throw new Error('sendForward 需要 groupId 或 userId')
      }
      const res = await call('send_forward_msg', params)
      const d = dataOf<Record<string, unknown>>(res, {})
      return String(d.message_id ?? d.res_id ?? '')
    },
    async handleAddRequest(kind, flag, approve, subType) {
      if (kind === 'friend') {
        await call('set_friend_add_request', { flag, approve })
        return
      }
      await call('set_group_add_request', {
        flag,
        sub_type: subType === 'invite' ? 'invite' : 'add',
        approve,
      })
    },
  }
}

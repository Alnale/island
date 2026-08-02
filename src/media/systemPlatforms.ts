/** 系统媒体平台定义:通过 SMTC 会话的 SourceAppUserModelId 识别 */
export interface SystemPlatform {
  id: string
  label: string
  color: string
  /** 识别规则(匹配 sourceAppId) */
  match: RegExp
}

export const SYSTEM_PLATFORMS: readonly SystemPlatform[] = [
  { id: 'qqmusic', label: 'QQ音乐', color: '#31c27c', match: /qqmusic|tencent\.qq/i },
  { id: 'netease', label: '网易云音乐', color: '#e43b3b', match: /cloudmusic|netease/i },
  { id: 'kugou', label: '酷狗音乐', color: '#00a5e3', match: /kugou|kgmusic/i },
  { id: 'kuwo', label: '酷我音乐', color: '#ff7a1a', match: /kuwo|kwmusic/i },
  { id: 'soda', label: '汽水音乐', color: '#ff2d55', match: /soda|douyin/i },
]

/** 未知平台兜底 */
export const UNKNOWN_PLATFORM: SystemPlatform = {
  id: 'unknown',
  label: '系统媒体',
  color: '#94a3b8',
  match: /$^/,
}

/** 按 SMTC sourceAppId 识别平台 */
export function recognizePlatform(sourceAppId: string | null | undefined): SystemPlatform {
  if (!sourceAppId) return UNKNOWN_PLATFORM
  for (const p of SYSTEM_PLATFORMS) {
    if (p.match.test(sourceAppId)) return p
  }
  return UNKNOWN_PLATFORM
}

/**
 * 媒体拦截判定簇(open_file / exec_command start 共用)
 *
 * 2026-08-14 插件化六期从 tools.ts 拆出:扩展名 → 媒体类型判定、
 * start 命令媒体路径提取(cmd 引号语义)。全部纯函数,无 IO/无状态。
 * tools.ts barrel 兼容 re-export。
 */

import path from 'node:path'

/** 媒体扩展名 → 媒体类型(open_file / exec_command 媒体拦截共用,
 * 2026-08-08) */
export function mediaKindForPath(target: string): 'img' | 'video' | 'audio' | null {
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(target)) return 'img'
  if (/\.(mp4|m4v|mov|webm)$/i.test(target)) return 'video'
  if (/\.(mp3|wav|flac|ogg|oga|opus|m4a|aac)$/i.test(target)) return 'audio'
  return null
}

/**
 * 从 `start` 命令提取媒体文件路径(2026-08-08,exec_command 媒体拦截):
 * LLM 播放视频常用 `start "标题" "C:\x.mp4"`(cmd 引号语义:第一个引号
 * 串是窗口标题)或 `start C:\x.mp4`(裸 token)。返回绝对路径(相对路径
 * 按 cwd 解析);非 start 命令或提取不出媒体路径返回 null
 */
export function extractMediaPathFromStart(command: string, cwd: string): string | null {
  const m = /^start\s+/i.exec(command)
  if (!m) return null
  const rest = command.slice(m[0].length).trim()
  if (!rest) return null
  let target = ''
  if (rest.startsWith('"')) {
    // 引号形式:start "标题" "路径"(两段)或 start "路径"(单段——
    // cmd 语义单段是标题,不打开文件,不拦截防误判)
    const q1 = /^"([^"]*)"/.exec(rest)
    if (q1) {
      const after = rest.slice(q1[0].length).trim()
      if (after.startsWith('"')) {
        const q2 = /^"([^"]*)"/.exec(after)
        if (q2) target = q2[1]
      }
    }
  } else {
    target = rest.split(/\s+/)[0]
  }
  if (!target) return null
  return path.isAbsolute(target) ? target : path.resolve(cwd, target)
}

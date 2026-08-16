/**
 * 隐私配置(2026-08-17 用户要求"打包的安装器不携带主人QQ等隐私"):
 * 主人 QQ / 扩展信任 / 群白名单 / 机器人自身 QQ 从 userData/privacy.json
 * 运行时读取,源码零硬编码。首次运行生成空模板,用户填写后启用对应功能;
 * masterQQ 为空时 QQ 主人相关能力不启用(身份判定恒为"非主人")。
 */

import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

export interface PrivacyConfig {
  /** 主人 QQ(唯一;空 = 未配置,QQ 主人功能不启用) */
  masterQQ: string
  /** 私聊扩展信任 QQ 号(空数组 = 只信任主人) */
  allowed: string[]
  /** 群白名单(空数组 = 不处理群消息) */
  allowedGroups: string[]
  /** 机器人自身 QQ(群 @ 检测) */
  botQQ: string
}

function privacyFile(): string {
  try {
    return path.join(app.getPath('userData'), 'privacy.json')
  } catch {
    return path.join(process.env.APPDATA ?? '', 'dynamic-island', 'privacy.json')
  }
}

let cache: PrivacyConfig | null = null

/** 读取隐私配置(启动后缓存;文件缺失/损坏时生成空模板并返回空配置) */
export function privacyConfig(): PrivacyConfig {
  if (cache) return cache
  const empty: PrivacyConfig = { masterQQ: '', allowed: [], allowedGroups: [], botQQ: '' }
  try {
    const raw = fs.readFileSync(privacyFile(), 'utf8')
    const p = JSON.parse(raw)
    cache = {
      masterQQ: String(p.masterQQ ?? '').trim(),
      allowed: Array.isArray(p.allowed) ? p.allowed.map(String) : [],
      allowedGroups: Array.isArray(p.allowedGroups) ? p.allowedGroups.map(String) : [],
      botQQ: String(p.botQQ ?? '').trim(),
    }
  } catch {
    cache = empty
    try {
      fs.writeFileSync(privacyFile(), JSON.stringify(empty, null, 2), 'utf8')
    } catch { /* 只读目录等忽略 */ }
  }
  return cache
}

/** 主人 QQ(空 = 未配置) */
export function masterQQ(): string {
  return privacyConfig().masterQQ
}

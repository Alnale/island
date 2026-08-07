/**
 * settings.json 持久化存储
 * (2026-08-07 从 main.cjs 拆出,审计 P1:原子写 + 损坏恢复 + apiKey
 * 加密 + 防抖合帧,首次可单元测试)
 *
 * 依赖经工厂注入(safeStorage / getUserDataPath):main.cjs 用真实
 * 实现,测试用内存 stub。
 *
 * 语义:
 * - 内存缓存(启动读一次,写透更新;损坏时从 .bak 恢复);
 * - 原子写(tmp + rename)+ .bak 保留最近成功版本(强杀截断可恢复);
 * - apiKey 经 safeStorage(Windows DPAPI)加密落盘(enc: 前缀),内存
 *   缓存/读者始终明文,解密失败返回 null 重填;
 * - 写盘 150ms 防抖合帧(agent 配置工具一轮内连发多次 patch)。
 */

const path = require('node:path')
const fs = require('node:fs')

function createSettingsStore({ safeStorage, getUserDataPath }) {
  let settingsCache = null
  let settingsSaveTimer = null

  const settingsPath = () => path.join(getUserDataPath(), 'settings.json')

  // ---- API Key 加密(safeStorage/Windows DPAPI) ----
  // settings.json 曾明文存 apiKey;加密只在磁盘上(enc: 前缀 + base64),
  // 内存缓存/引擎读取始终是明文。解密失败(换机/DPAPI 变更)返回 null,
  // 用户重填即可;isEncryptionAvailable 为 false(无 DPAPI)时原样透传
  function encryptSecret(value) {
    try {
      if (typeof value !== 'string' || !value || value.startsWith('enc:')) return value
      if (!safeStorage.isEncryptionAvailable()) return value
      return 'enc:' + safeStorage.encryptString(value).toString('base64')
    } catch {
      return value
    }
  }
  function decryptSecret(value) {
    try {
      if (typeof value !== 'string' || !value.startsWith('enc:')) return value
      if (!safeStorage.isEncryptionAvailable()) return value
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    } catch {
      return null
    }
  }

  function load() {
    if (settingsCache !== null) return settingsCache
    try {
      settingsCache = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    } catch {
      // 主文件损坏/缺失:尝试从 .bak 恢复(原子写留下的最近一次成功版本)
      try {
        settingsCache = JSON.parse(fs.readFileSync(settingsPath() + '.bak', 'utf8'))
        console.error('[widget] settings.json 损坏,已从 .bak 恢复')
      } catch {
        settingsCache = {}
      }
    }
    // 解密一次:缓存持有明文(引擎/模式读取无感知),仅落盘时加密
    if (settingsCache.agent && typeof settingsCache.agent.apiKey === 'string') {
      settingsCache.agent.apiKey = decryptSecret(settingsCache.agent.apiKey)
    }
    return settingsCache
  }

  // 防抖:agent 配置工具(mcp_config → skills_config)同一轮内连发多次 patch,
  // 合帧到 150ms 内最后一次(原子写保证每次落盘都是完整文件)
  function flush() {
    clearTimeout(settingsSaveTimer)
    settingsSaveTimer = null
    try {
      const p = settingsPath()
      if (settingsCache === null) return
      // 写盘前加密 apiKey(浅拷贝,内存缓存保持明文)
      const disk = { ...settingsCache }
      if (disk.agent && typeof disk.agent.apiKey === 'string' && !disk.agent.apiKey.startsWith('enc:')) {
        disk.agent = { ...disk.agent, apiKey: encryptSecret(disk.agent.apiKey) }
      }
      if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak')
      fs.writeFileSync(p + '.tmp', JSON.stringify(disk, null, 2))
      fs.renameSync(p + '.tmp', p)
    } catch (err) {
      console.error('[widget] flush settings failed:', err)
    }
  }

  function save(patch) {
    // 缓存同步更新(读者即时拿到新值),磁盘写防抖合帧
    settingsCache = { ...load(), ...patch }
    clearTimeout(settingsSaveTimer)
    settingsSaveTimer = setTimeout(flush, 150)
  }

  /** 丢弃内存缓存(巡检恢复磁盘文件后调用:flush 对 null 缓存是 no-op,
   * 磁盘恢复即生效,不会被退出时的旧缓存 flush 覆盖) */
  function resetCache() {
    clearTimeout(settingsSaveTimer)
    settingsSaveTimer = null
    settingsCache = null
  }

  return { load, save, flush, resetCache, path: settingsPath }
}

module.exports = { createSettingsStore }

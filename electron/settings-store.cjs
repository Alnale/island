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
 * - 所有 Agent 密钥经 safeStorage(Windows DPAPI)加密落盘(enc:v1: 前缀),
 *   包括多供应商 apiKey 与 MCP env/header；内存缓存/读者始终明文；
 * - 写盘 150ms 防抖合帧(agent 配置工具一轮内连发多次 patch)。
 */

const path = require('node:path')
const fs = require('node:fs')

const SECRET_PREFIX = 'enc:v1:'
const LEGACY_SECRET_PREFIX = 'enc:'
const SETTINGS_SCHEMA_VERSION = 4

function cloneJson(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value
}

function createSettingsStore({ safeStorage, getUserDataPath }) {
  let settingsCache = null
  let settingsSaveTimer = null
  let destroyed = false
  let secretPersistOk = true

  const settingsPath = () => path.join(getUserDataPath(), 'settings.json')

  function encryptionAvailable() {
    try { return !!safeStorage.isEncryptionAvailable() } catch { return false }
  }

  // ---- 密钥加密(safeStorage/Windows DPAPI) ----
  // 不能安全加密时绝不把新密钥明文写盘：本次运行仍保留内存值，但重启后
  // 需要重新填写。这比静默把凭据落成明文更符合「本地安全存储」语义。
  function encryptSecret(value) {
    try {
      if (typeof value !== 'string' || !value || value.startsWith(SECRET_PREFIX) || value.startsWith(LEGACY_SECRET_PREFIX)) return value
      if (!encryptionAvailable()) {
        secretPersistOk = false
        return undefined
      }
      return SECRET_PREFIX + safeStorage.encryptString(value).toString('base64')
    } catch {
      secretPersistOk = false
      return undefined
    }
  }
  function decryptSecret(value) {
    try {
      if (typeof value !== 'string' || (!value.startsWith(SECRET_PREFIX) && !value.startsWith(LEGACY_SECRET_PREFIX))) return value
      // 密文不能被当作 API Key 使用；不可解密时明确返回空值，引导重填。
      if (!encryptionAvailable()) return null
      const encoded = value.startsWith(SECRET_PREFIX) ? value.slice(SECRET_PREFIX.length) : value.slice(LEGACY_SECRET_PREFIX.length)
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch {
      return null
    }
  }

  function mapSecretRecord(record, transform) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return record
    const result = { ...record }
    for (const [key, value] of Object.entries(result)) {
      if (typeof value !== 'string') continue
      const next = transform(value)
      if (next === undefined) delete result[key]
      else result[key] = next
    }
    return result
  }

  /** 仅转换公认的凭据字段，其他配置按原样保留。 */
  function transformSecrets(settings, transform) {
    const next = cloneJson(settings) ?? {}
    const agent = next.agent
    if (!agent || typeof agent !== 'object') return next
    if (typeof agent.apiKey === 'string') {
      const value = transform(agent.apiKey)
      if (value === undefined) delete agent.apiKey
      else agent.apiKey = value
    }
    if (agent.providers && typeof agent.providers === 'object') {
      for (const provider of Object.values(agent.providers)) {
        if (!provider || typeof provider !== 'object' || typeof provider.apiKey !== 'string') continue
        const value = transform(provider.apiKey)
        if (value === undefined) delete provider.apiKey
        else provider.apiKey = value
      }
    }
    if (Array.isArray(agent.mcpServers)) {
      agent.mcpServers = agent.mcpServers.map((server) => {
        if (!server || typeof server !== 'object') return server
        const copy = { ...server }
        copy.env = mapSecretRecord(copy.env, transform)
        copy.headers = mapSecretRecord(copy.headers, transform)
        return copy
      })
    }
    return next
  }

  function serializeForDisk(settings) {
    const sealed = transformSecrets(settings, encryptSecret)
    sealed.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION
    return JSON.stringify(sealed, null, 2)
  }

  function hasPersistedSecrets(settings) {
    const needsMigration = (value) => typeof value === 'string' && value !== '' && !value.startsWith(SECRET_PREFIX)
    const agent = settings?.agent
    if (!agent || typeof agent !== 'object') return false
    if (needsMigration(agent.apiKey)) return true
    if (agent.providers && typeof agent.providers === 'object') {
      if (Object.values(agent.providers).some((provider) => provider && typeof provider === 'object' && needsMigration(provider.apiKey))) return true
    }
    return Array.isArray(agent.mcpServers) && agent.mcpServers.some((server) =>
      server && typeof server === 'object' &&
      ((server.env && typeof server.env === 'object' && Object.values(server.env).some(needsMigration)) ||
       (server.headers && typeof server.headers === 'object' && Object.values(server.headers).some(needsMigration))),
    )
  }

  function load() {
    if (destroyed) return settingsCache ?? {}
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
    const needsSecretMigration = hasPersistedSecrets(settingsCache)
    // 解密一次:缓存持有明文(引擎/模式读取无感知),仅落盘时加密。
    settingsCache = transformSecrets(settingsCache, decryptSecret)
    // 读取旧版明文或 enc: 格式时立即安排一次幂等迁移；不等待后续设置
    // 修改，避免旧密钥长期留在磁盘。不可安全加密时不触发写回。
    if (needsSecretMigration && encryptionAvailable()) {
      settingsSaveTimer = setTimeout(flush, 0)
    }
    return settingsCache
  }

  function writeAtomic(filePath, contents) {
    const tmp = filePath.endsWith('.bak') ? filePath + '.tmp' : filePath + '.tmp'
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, contents)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, filePath)
  }

  // 防抖:agent 配置工具(mcp_config → skills_config)同一轮内连发多次 patch,
  // 合帧到 150ms 内最后一次(原子写保证每次落盘都是完整文件)
  function flush() {
    clearTimeout(settingsSaveTimer)
    settingsSaveTimer = null
    if (destroyed || settingsCache === null) return
    try {
      const p = settingsPath()
      const disk = serializeForDisk(settingsCache)
      // 历史版本可能包含明文，不能直接 copy 到 .bak；能加密时按同一规则
      // 迁移。不能加密时原样复制上一份（可能已是密文），避免把备份洗成无 Key。
      if (fs.existsSync(p)) {
        try {
          if (encryptionAvailable()) {
            const previous = JSON.parse(fs.readFileSync(p, 'utf8'))
            writeAtomic(p + '.bak', serializeForDisk(transformSecrets(previous, decryptSecret)))
          } else {
            fs.copyFileSync(p, p + '.bak')
          }
        } catch {
          // 保留既有 .bak；主文件仍按原子路径刷新。
        }
      }
      writeAtomic(p, disk)
    } catch (err) {
      console.error('[widget] flush settings failed:', err)
    }
  }

  function save(patch) {
    if (destroyed) return
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

  /** 取消待写入并清空内存明文。失败的重置可 revive() 再读盘。 */
  function destroy() {
    resetCache()
    destroyed = true
  }

  function revive() {
    destroyed = false
    settingsCache = null
  }

  return {
    load,
    save,
    flush,
    resetCache,
    destroy,
    revive,
    path: settingsPath,
    isSecretStorageAvailable: encryptionAvailable,
    didSecretPersist: () => secretPersistOk && encryptionAvailable(),
  }
}

module.exports = { createSettingsStore }

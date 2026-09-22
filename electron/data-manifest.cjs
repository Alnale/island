/**
 * 应用自有持久化数据清单。
 *
 * 这是「恢复出厂设置 / 清除工具数据」的唯一权威来源：新增持久化文件
 * 时必须在这里登记，避免 UI 已宣称重置完成、旧文件却在下次启动时把
 * 状态恢复回来。
 */
const path = require('node:path')
const fs = require('node:fs')

/** 工厂重置删除的 userData 相对路径（文件或目录）。顺序无意义。 */
const APP_DATA_ENTRIES = Object.freeze([
  'memory.json',
  'memory-state.json',
  'evolution.json',
  'memory-snapshots',
  'settings.json',
  'settings.json.bak',
  'settings.json.tmp',
  'privacy.json',
  'session-log.jsonl',
  'session-log.1.jsonl',
  'session-log.2.jsonl',
  'napcat-contacts.json',
  'napcat-chats.json',
  'napcat-personas.json',
  'napcat-seen.json',
  'napcat-media',
  'undo-snapshots.json',
  'napcat-sessions.json',
])

/** 渲染端 IndexedDB；主进程在 prepare-reset 时把这份名单发给页面。 */
const RENDERER_DATABASES = Object.freeze([
  'island-uploads',
  'island-background',
  'island-font',
  'island-audio-library',
  'island-video-library',
])

const TOOL_DATA_ENTRIES = Object.freeze([
  'bili',
  'xxt-profile',
  'xxt-screenshots',
  'docflow',
])

function entriesForScope(scope) {
  if (scope === 'app' || scope === 'factory') return APP_DATA_ENTRIES
  if (scope === 'tools') return TOOL_DATA_ENTRIES
  return null
}

/**
 * 解析清单项到 userData 内的绝对路径。相对路径若逃出 userData
 * （含 `..` 或绝对路径）则抛错，调用方记为失败项，不得删除。
 */
function resolveManagedPath(userDataPath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new Error('清单项缺少相对路径')
  }
  const root = path.resolve(userDataPath)
  const target = path.resolve(root, relativePath)
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝清除 userData 之外的路径:${relativePath}`)
  }
  return target
}

function statusOf(exists, failed) {
  if (failed) return 'failed'
  return exists ? 'deleted' : 'not-found'
}

/** 删除清单中所有项；逐项执行以便某个被占用文件不会阻止其余清理。 */
function clearManagedData(userDataPath, scope, remove = fs.rmSync) {
  const entries = entriesForScope(scope)
  if (!entries) return { ok: false, error: `未知的清除范围:${String(scope)}`, removed: [], failures: [], entries: [] }

  const removed = []
  const failures = []
  const report = []
  for (const entry of entries) {
    let target
    try {
      target = resolveManagedPath(userDataPath, entry)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      failures.push({ entry, error })
      report.push({ id: entry, status: 'failed', error })
      continue
    }
    const existed = fs.existsSync(target)
    try {
      remove(target, { recursive: true, force: true })
      if (existed && fs.existsSync(target)) {
        const error = '删除后仍存在'
        failures.push({ entry, error })
        report.push({ id: entry, status: 'failed', error })
        continue
      }
      if (existed) removed.push(entry)
      report.push({ id: entry, status: statusOf(existed, false) })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      failures.push({ entry, error })
      report.push({ id: entry, status: 'failed', error })
    }
  }

  for (const entry of entries) {
    try {
      const target = resolveManagedPath(userDataPath, entry)
      if (fs.existsSync(target) && !failures.some((item) => item.entry === entry)) {
        const error = '二次核验仍存在'
        failures.push({ entry, error })
        const row = report.find((item) => item.id === entry)
        if (row) {
          row.status = 'failed'
          row.error = error
        } else report.push({ id: entry, status: 'failed', error })
      }
    } catch {
      // 解析失败已在第一轮记录
    }
  }

  if (failures.length) {
    return {
      ok: false,
      error: `无法清除:${failures.map((item) => item.entry).join(', ')}`,
      removed,
      failures,
      entries: report,
    }
  }
  return { ok: true, removed, failures, entries: report }
}

module.exports = {
  APP_DATA_ENTRIES,
  TOOL_DATA_ENTRIES,
  RENDERER_DATABASES,
  entriesForScope,
  resolveManagedPath,
  clearManagedData,
}

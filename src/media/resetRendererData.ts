import { closeAllIdb } from './idb'

export interface RendererResetEntry {
  id: string
  status: 'deleted' | 'not-found' | 'failed'
  error?: string
}

function deleteDatabase(name: string): Promise<RendererResetEntry> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      resolve({ id: name, status: 'failed', error: 'timeout' })
    }, 4000)
    try {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => {
        window.clearTimeout(timer)
        resolve({ id: name, status: 'deleted' })
      }
      req.onerror = () => {
        window.clearTimeout(timer)
        resolve({ id: name, status: 'failed', error: req.error?.message ?? 'error' })
      }
      // blocked：等 success/error/超时，不立刻当成功
    } catch (err) {
      window.clearTimeout(timer)
      resolve({ id: name, status: 'failed', error: err instanceof Error ? err.message : String(err) })
    }
  })
}

/** 工厂重置的渲染端半边：关连接、清 localStorage、按清单删 IndexedDB。 */
export async function resetRendererStorage(databases: string[]): Promise<RendererResetEntry[]> {
  const entries: RendererResetEntry[] = []
  try {
    await closeAllIdb()
  } catch {
    // 继续删库
  }
  try {
    localStorage.clear()
    entries.push({ id: 'localStorage', status: 'deleted' })
  } catch (err) {
    entries.push({
      id: 'localStorage',
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
  }
  for (const name of databases) {
    entries.push(await deleteDatabase(name))
  }
  return entries
}

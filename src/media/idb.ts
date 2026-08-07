/**
 * 共享 IndexedDB 工具:库打开(按库名缓存连接)+ 事务包装。
 * backgroundStore / fontStore / uploadStore 三个存储模块原各有一份
 * 几乎相同的 openDb/run 样板代码,统一收敛到这里。
 */

/** 库名 → 打开的连接(同页面生命周期内复用) */
const dbCache = new Map<string, Promise<IDBDatabase>>()

/**
 * 打开(或复用)指定名称的 IndexedDB 库;
 * onUpgrade 在升级事务内执行(建库/迁移)。
 */
export function openIdb(
  dbName: string,
  version: number,
  onUpgrade?: (db: IDBDatabase, tx: IDBTransaction | null) => void,
): Promise<IDBDatabase> {
  let cached = dbCache.get(dbName)
  if (!cached) {
    cached = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, version)
      req.onupgradeneeded = () => {
        const db = req.result
        onUpgrade?.(db, req.transaction ?? null)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        // 打开失败(磁盘繁忙/存储损坏/配额等瞬时错误)不能把失败 Promise
        // 永久缓存在 cache——否则后续所有同库操作全部走同一失败路径,
        // 背景/字体/上传功能直到应用重启才恢复;失败即移除,下次重试
        dbCache.delete(dbName)
        reject(req.error)
      }
    })
    dbCache.set(dbName, cached)
  }
  return cached
}

/**
 * 事务包装:在指定 store 上执行请求,事务完成时以请求结果 resolve。
 * 读(get/getAll)与写(put/delete)通吃;请求失败/事务中止时 reject。
 */
export function idbRun<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * 上传音乐持久化存储(IndexedDB):
 * 上传的音频以 ArrayBuffer 存入本地,刷新页面后重建 blob URL 恢复曲目。
 * 删除曲目时同步删除记录,避免残留。
 */

export interface StoredUpload {
  key: string
  name: string
  type: string
  data: ArrayBuffer
}

const DB_NAME = 'island-uploads'
const STORE = 'tracks'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'key' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const req = fn(tx.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

/** 保存上传文件,返回存储 key */
export async function saveUpload(file: File): Promise<string> {
  const data = await file.arrayBuffer()
  const key = `${Date.now()}-${file.name}`
  await run('readwrite', (s) => s.put({ key, name: file.name, type: file.type, data }))
  return key
}

/** 读取全部持久化曲目 */
export async function loadUploads(): Promise<StoredUpload[]> {
  const all = await run<StoredUpload[]>('readonly', (s) => s.getAll())
  return all ?? []
}

/** 删除持久化曲目 */
export async function removeUpload(key: string): Promise<void> {
  await run('readwrite', (s) => s.delete(key))
}

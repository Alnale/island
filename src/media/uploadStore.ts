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

import { idbRun, openIdb } from './idb'

const DB_NAME = 'island-uploads'
const STORE = 'tracks'

function openDb(): Promise<IDBDatabase> {
  return openIdb(DB_NAME, 1, (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: 'key' })
    }
  })
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then((db) => idbRun(db, STORE, mode, fn))
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

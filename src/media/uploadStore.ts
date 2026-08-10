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

/** 常见音频扩展名 → MIME(上传时 File.type 可能为空,按扩展名推断;
 * 恢复播放的 Blob 需要正确 type,空 type 的 blob URL 音频无法识别,
 * 2026-08-08 修复) */
const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
}

/** 推断音频 MIME:File.type 合法则原样,否则按扩展名,再无则原样 */
export function inferAudioType(name: string, fileType: string): string {
  if (fileType.startsWith('audio/')) return fileType
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXT[ext] ?? fileType
}

/** 保存上传文件,返回存储 key */
export async function saveUpload(file: File): Promise<string> {
  const data = await file.arrayBuffer()
  const key = `${Date.now()}-${file.name}`
  // 存储推断后的 MIME:重启恢复的 Blob 用它建 URL,播放器才能识别
  await run('readwrite', (s) => s.put({ key, name: file.name, type: inferAudioType(file.name, file.type), data }))
  return key
}

/** 保存已持有的音频数据(音频库导入播放列表用,2026-08-08):
 * 与 saveUpload 同款存储(播放列表重启恢复共用 island-uploads) */
export async function saveUploadData(name: string, type: string, data: ArrayBuffer): Promise<string> {
  const key = `${Date.now()}-${name}`
  await run('readwrite', (s) => s.put({ key, name, type: inferAudioType(name, type), data }))
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

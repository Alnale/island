/**
 * 多媒体库存储(2026-08-08,多媒体库面板):
 * - **音频库**(IndexedDB `island-audio-library`):条目存 ArrayBuffer
 *   (音频一般几 MB~几十 MB,IndexedDB 可行;上限 200MB);
 * - **视频库**(IndexedDB `island-video-library`):条目**只存文件路径引用**
 *   (视频动辄 GB 级,ArrayBuffer 进 IndexedDB 不现实;播放经
 *   island-media:// 协议流式,按路径读取);
 * - 图片库 = 现有 island-background 的 library store(同一数据源,
 *   多媒体库"图片"tab 直接复用,不重复建库)。
 *
 * 播放列表 ↔ 音频库同步(useMediaPlayer.addTracks):上传歌曲到播放
 * 列表时,若音频库**没有同名歌曲**则自动补录(按文件名判重),已有则
 * 不重复导入——参考图片库导入机制。
 */

import { idbRun, openIdb } from './idb'

/** 音频库条目(ArrayBuffer 全量存储,播放列表恢复/播放用 Blob URL) */
export interface AudioLibraryItem {
  id: string
  name: string
  type: string
  data: ArrayBuffer
  createdAt: number
}

/** 视频库条目(路径引用:导入时记录绝对路径,播放经 island-media:// 流式) */
export interface VideoLibraryItem {
  id: string
  name: string
  /** 源文件绝对路径(移动/删除后失效,播放时报错提示) */
  path: string
  size: number
  createdAt: number
}

const AUDIO_DB = 'island-audio-library'
const VIDEO_DB = 'island-video-library'
const STORE = 'tracks'

/** 音频文件大小上限(200MB;与原有上传限制一致,超出提示) */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024

function openAudioDb(): Promise<IDBDatabase> {
  return openIdb(AUDIO_DB, 1, (db) => {
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
  })
}
function openVideoDb(): Promise<IDBDatabase> {
  return openIdb(VIDEO_DB, 1, (db) => {
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
  })
}

/** 生成条目 id(时间戳 + 随机段,与背景/字体库同款) */
export function genLibraryId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/* ------------------------- 音频库 ------------------------- */

export async function loadAudioLibrary(): Promise<AudioLibraryItem[]> {
  const db = await openAudioDb()
  const all = await idbRun<AudioLibraryItem[]>(db, STORE, 'readonly', (s) => s.getAll())
  return all ?? []
}

/** 按名称查音频库(播放列表上传自动补录判重用;大小写不敏感) */
export async function findAudioByName(name: string): Promise<AudioLibraryItem | null> {
  const items = await loadAudioLibrary()
  const target = String(name ?? '').trim().toLowerCase()
  return items.find((it) => it.name.trim().toLowerCase() === target) ?? null
}

/** 入库音频(名称查重由调用方决定;返回条目) */
export async function saveAudioItem(item: AudioLibraryItem): Promise<void> {
  const db = await openAudioDb()
  await idbRun(db, STORE, 'readwrite', (s) => s.put(item))
}

export async function removeAudioItem(id: string): Promise<void> {
  const db = await openAudioDb()
  await idbRun(db, STORE, 'readwrite', (s) => s.delete(id))
}

/** 批量落库(面板整体变更保存用:同名条目覆盖,删除的条目从库移除) */
export async function saveAudioItems(items: AudioLibraryItem[]): Promise<void> {
  if (items.length === 0) return
  const db = await openAudioDb()
  await idbRun(db, STORE, 'readwrite', (s) => {
    items.forEach((it) => s.put(it))
    return s.count()
  })
}

export async function renameAudioItem(id: string, name: string): Promise<AudioLibraryItem | null> {
  const items = await loadAudioLibrary()
  const item = items.find((it) => it.id === id)
  if (!item) return null
  const next = { ...item, name: String(name ?? '').trim().slice(0, 100) }
  await saveAudioItem(next)
  return next
}

/* ------------------------- 视频库 ------------------------- */

export async function loadVideoLibrary(): Promise<VideoLibraryItem[]> {
  const db = await openVideoDb()
  const all = await idbRun<VideoLibraryItem[]>(db, STORE, 'readonly', (s) => s.getAll())
  return all ?? []
}

export async function saveVideoItem(item: VideoLibraryItem): Promise<void> {
  const db = await openVideoDb()
  await idbRun(db, STORE, 'readwrite', (s) => s.put(item))
}

export async function removeVideoItem(id: string): Promise<void> {
  const db = await openVideoDb()
  await idbRun(db, STORE, 'readwrite', (s) => s.delete(id))
}

/** 批量落库(面板整体变更保存用) */
export async function saveVideoItems(items: VideoLibraryItem[]): Promise<void> {
  if (items.length === 0) return
  const db = await openVideoDb()
  await idbRun(db, STORE, 'readwrite', (s) => {
    items.forEach((it) => s.put(it))
    return s.count()
  })
}

export async function renameVideoItem(id: string, name: string): Promise<VideoLibraryItem | null> {
  const items = await loadVideoLibrary()
  const item = items.find((it) => it.id === id)
  if (!item) return null
  const next = { ...item, name: String(name ?? '').trim().slice(0, 100) }
  await saveVideoItem(next)
  return next
}

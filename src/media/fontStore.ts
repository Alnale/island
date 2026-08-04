/**
 * 自定义字体库持久化存储:
 * 多字体管理(IndexedDB 按 id 存字体 data URL,字体可能数 MB,超出
 * localStorage 容量);当前应用字体 id 与颜色设置走 localStorage(小数据)。
 * 旧版单字体数据(键 'font')自动迁移为库项。
 */

import { idbRun, openIdb } from './idb'

const DB_NAME = 'island-font'
const STORE = 'fonts'
/** 旧版单字体 store 名(版本 1,迁移用) */
const LEGACY_STORE = 'font'
/** 字体设置持久化键 */
const FONT_SETTINGS_KEY = 'widget-font'

function openDb(): Promise<IDBDatabase> {
  // 版本 2:创建 'fonts' 库,并把旧版 store 'font'(版本 1 的单字体)
  // 复制为新库条目后删除旧 store。注意旧库版本同为 1 时 open(1) 不会
  // 触发 onupgradeneeded——不升版本号新 store 永远不会被创建
  return openIdb(DB_NAME, 2, (db, tx) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE)
    }
    if (db.objectStoreNames.contains(LEGACY_STORE)) {
      if (!tx) return
      const oldReq = tx.objectStore(LEGACY_STORE).get('font')
      oldReq.onsuccess = () => {
        const legacy = oldReq.result
        if (typeof legacy === 'string') {
          const item: FontLibraryItem = {
            id: genFontId(),
            name: '自定义字体',
            dataUrl: legacy,
            createdAt: Date.now(),
          }
          tx.objectStore(STORE).put(item, item.id)
        }
      }
      db.deleteObjectStore(LEGACY_STORE)
    }
  })
}

/** 在字体库 store 上执行事务(写操作,忽略结果) */
function run(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return openDb()
    .then((db) => idbRun(db, STORE, mode, fn))
    .then(() => undefined)
}

/** 字体库条目 */
export interface FontLibraryItem {
  id: string
  name: string
  /** 字体文件 data URL */
  dataUrl: string
  createdAt: number
}

/** 生成库条目 id(时间戳 + 随机后缀) */
export function genFontId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 保存字体库条目(新增或按 id 覆盖,改名也走这里) */
export function saveFontItem(item: FontLibraryItem): Promise<void> {
  return run('readwrite', (s) => s.put(item, item.id))
}

/** 读取全部字体库条目(数组按创建时间升序;
 *  旧版单字体(store 'font')在数据库升级时已自动迁移) */
export async function loadFontItems(): Promise<FontLibraryItem[]> {
  try {
    const db = await openDb()
    const result = await idbRun(db, STORE, 'readonly', (s) => s.getAll())
    return (result as unknown[])
      .filter(
        (v): v is FontLibraryItem =>
          typeof v === 'object' &&
          v !== null &&
          typeof (v as FontLibraryItem).id === 'string' &&
          typeof (v as FontLibraryItem).dataUrl === 'string',
      )
      .sort((a, b) => a.createdAt - b.createdAt)
  } catch {
    return []
  }
}

/** 删除字体库条目 */
export function deleteFontItem(id: string): Promise<void> {
  return run('readwrite', (s) => s.delete(id))
}

/** 字体颜色模式:auto = 按背景亮度自动黑白;custom = 自定义颜色 */
export type FontColorMode = 'auto' | 'custom'

/** 字体设置(不含字体文件本体,文件走 IndexedDB 库) */
export interface FontSettings {
  /** 当前应用字体的 id(null = 系统默认字体) */
  currentFontId: string | null
  /** 颜色模式 */
  colorMode: FontColorMode
  /** 自定义颜色(custom 模式生效,hex) */
  colorValue: string | null
  /** 字体粗细(400 常规 / 600 中等 / 800 粗体,单字重字体由浏览器合成) */
  weight: number
}

/** 默认字体设置 */
export const DEFAULT_FONT_SETTINGS: FontSettings = {
  currentFontId: null,
  colorMode: 'auto',
  colorValue: null,
  weight: 400,
}

/** 允许的字重档位 */
export const FONT_WEIGHTS = [400, 600, 800]

/** 读取字体设置(localStorage,损坏时回退默认) */
export function loadFontSettings(): FontSettings {
  try {
    const raw = localStorage.getItem(FONT_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_FONT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<FontSettings>
    return {
      currentFontId: typeof parsed.currentFontId === 'string' ? parsed.currentFontId : null,
      colorMode: parsed.colorMode === 'custom' ? 'custom' : 'auto',
      colorValue: typeof parsed.colorValue === 'string' ? parsed.colorValue : null,
      weight: FONT_WEIGHTS.includes(Number(parsed.weight)) ? Number(parsed.weight) : 400,
    }
  } catch {
    return { ...DEFAULT_FONT_SETTINGS }
  }
}

/** 保存字体设置(localStorage) */
export function saveFontSettings(settings: FontSettings): void {
  try {
    localStorage.setItem(FONT_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // 忽略存储失败
  }
}

/** 字体文件上限:30MB(中文字体常见 10-20MB,10MB 太严会频繁拒绝) */
export const MAX_FONT_BYTES = 30 * 1024 * 1024

/** 允许的字体扩展名(上传校验) */
export const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2']

/** 文件扩展名是否被支持 */
export function isSupportedFontFile(name: string): boolean {
  const lower = name.toLowerCase()
  return FONT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

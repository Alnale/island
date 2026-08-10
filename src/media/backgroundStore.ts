/**
 * 自定义背景持久化存储(IndexedDB):
 * 背景图以 data URL 字符串存入独立库(图片可能超出 localStorage 容量),
 * 启动时恢复;透明度走 localStorage(小数值)。
 */

import { idbRun, openIdb } from './idb'

const DB_NAME = 'island-background'
const STORE = 'bg'
/** 图片库 objectStore(多图管理,按 id 存条目) */
const LIB_STORE = 'library'
/** 旧版单图键(迁移用) */
const LEGACY_IMAGE_KEY = 'image'

function openDb(): Promise<IDBDatabase> {
  return openIdb(DB_NAME, 2, (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE)
    }
    if (!db.objectStoreNames.contains(LIB_STORE)) {
      db.createObjectStore(LIB_STORE)
    }
  })
}

/** 在图片库 store 上执行事务(写操作,忽略结果) */
function runLib(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<void> {
  return openDb()
    .then((db) => idbRun(db, LIB_STORE, mode, fn))
    .then(() => undefined)
}

/** 在背景图 store 上执行事务(写操作,忽略结果) */
function run(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return openDb()
    .then((db) => idbRun(db, STORE, mode, fn))
    .then(() => undefined)
}

/** 默认裁切(cover 居中) */
export const DEFAULT_BG_CROP = { zoom: 1, posX: 50, posY: 50 }

/** 背景参数持久化键(不透明度/裁切;图片本体走 IndexedDB) */
export const BACKGROUND_PARAMS_KEY = 'widget-background'
/** 旧版单独存储的不透明度键(兼容读取) */
export const LEGACY_BACKGROUND_OPACITY_KEY = 'widget-background-opacity'
/** 默认不透明度(双槽位) */
export const DEFAULT_BG_OPACITY = { expanded: 0.4, compact: 0.4 }

/**
 * 读取背景参数(不透明度/裁切;图片本体走 IndexedDB)。
 * 挂件初始状态与设置桥事件重读共用——localStorage 损坏时回退默认;
 * 旧版单一数值 opacity / 单独键 widget-background-opacity 自动迁移为双槽位。
 * (设置桥与 WidgetApp 共用同一实现,避免旧数据下 LLM 读到 0.4 而 UI 显示真实值)
 */
export function readBackgroundParams(): Pick<BackgroundState, 'opacity' | 'expanded' | 'compact'> {
  let opacity: { expanded: number; compact: number } = { ...DEFAULT_BG_OPACITY }
  const expanded = { ...DEFAULT_BG_CROP }
  const compact = { ...DEFAULT_BG_CROP }
  const readCrop = (
    c: Partial<{ zoom: number; posX: number; posY: number }> | null | undefined,
  ): { zoom: number; posX: number; posY: number } => ({
    zoom: typeof c?.zoom === 'number' && c.zoom >= 1 && c.zoom <= 4 ? c.zoom : DEFAULT_BG_CROP.zoom,
    posX:
      typeof c?.posX === 'number' && c.posX >= 0 && c.posX <= 100 ? c.posX : DEFAULT_BG_CROP.posX,
    posY:
      typeof c?.posY === 'number' && c.posY >= 0 && c.posY <= 100 ? c.posY : DEFAULT_BG_CROP.posY,
  })
  try {
    const raw = localStorage.getItem(BACKGROUND_PARAMS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as {
        opacity?: unknown
        expanded?: Partial<{ zoom: number; posX: number; posY: number }>
        compact?: Partial<{ zoom: number; posX: number; posY: number }>
        // 旧版单形态字段(迁移:旧裁切归展开态,紧凑态保持默认)
        zoom?: unknown
        posX?: unknown
        posY?: unknown
      }
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.opacity === 'number' && parsed.opacity >= 0 && parsed.opacity <= 1) {
          // 旧版单一数值:迁移为双槽位(两形态同值,保持旧外观)
          opacity = { expanded: parsed.opacity, compact: parsed.opacity }
        } else if (parsed.opacity && typeof parsed.opacity === 'object') {
          const o = parsed.opacity as { expanded?: unknown; compact?: unknown }
          opacity = {
            expanded:
              typeof o.expanded === 'number' && o.expanded >= 0 && o.expanded <= 1
                ? o.expanded
                : 0.4,
            compact:
              typeof o.compact === 'number' && o.compact >= 0 && o.compact <= 1
                ? o.compact
                : 0.4,
          }
        }
        if (parsed.expanded && typeof parsed.expanded === 'object') {
          Object.assign(expanded, readCrop(parsed.expanded))
        } else if (
          typeof parsed.zoom === 'number' ||
          typeof parsed.posX === 'number' ||
          typeof parsed.posY === 'number'
        ) {
          Object.assign(
            expanded,
            readCrop({
              zoom: typeof parsed.zoom === 'number' ? parsed.zoom : undefined,
              posX: typeof parsed.posX === 'number' ? parsed.posX : undefined,
              posY: typeof parsed.posY === 'number' ? parsed.posY : undefined,
            }),
          )
        }
        if (parsed.compact && typeof parsed.compact === 'object') {
          Object.assign(compact, readCrop(parsed.compact))
        }
      }
    } else {
      // 兼容旧版:单独存储的不透明度(迁移为双槽位)
      const old = Number(localStorage.getItem(LEGACY_BACKGROUND_OPACITY_KEY))
      if (Number.isFinite(old) && old >= 0 && old <= 1) {
        opacity = { expanded: old, compact: old }
      }
    }
  } catch {
    // 忽略存储失败
  }
  return { opacity, expanded, compact }
}

/** 保存背景参数(不透明度/裁切;图片本体走 IndexedDB) */
export function saveBackgroundParams(
  params: Pick<BackgroundState, 'opacity' | 'expanded' | 'compact'>,
): void {
  try {
    localStorage.setItem(BACKGROUND_PARAMS_KEY, JSON.stringify(params))
  } catch {
    // 忽略存储失败
  }
}

/** 自定义背景完整状态:展开态 / 紧凑态各自独立的图片、不透明度与裁切参数 */
export interface BackgroundState {
  expandedImage: string | null
  compactImage: string | null
  /** 不透明度(展开态 / 紧凑态各自独立,0-1;旧版单一数值自动迁移为双槽位) */
  opacity: { expanded: number; compact: number }
  expanded: { zoom: number; posX: number; posY: number }
  compact: { zoom: number; posX: number; posY: number }
}

/** 背景槽位:展开态 / 紧凑态各自独立的图片 */
export type BackgroundSlot = 'expanded' | 'compact'

/** 保存背景图(data URL)到指定槽位 */
export function saveBackgroundImage(dataUrl: string, slot: BackgroundSlot): Promise<void> {
  return run('readwrite', (s) => s.put(dataUrl, slot))
}

/** 读取指定槽位的背景图,无则返回 null */
export async function loadBackgroundImage(slot: BackgroundSlot): Promise<string | null> {
  try {
    const db = await openDb()
    const result = await idbRun(db, STORE, 'readonly', (s) => s.get(slot))
    return typeof result === 'string' ? result : null
  } catch {
    return null
  }
}

/** 清除指定槽位的背景图 */
export function clearBackgroundImage(slot: BackgroundSlot): Promise<void> {
  return run('readwrite', (s) => s.delete(slot))
}

/** 图片库条目 */
export interface ImageLibraryItem {
  id: string
  name: string
  /** 图片 data URL(已降采样) */
  dataUrl: string
  createdAt: number
}

/** 生成图片库条目 id(时间戳 + 随机后缀) */
export function genImageId(): string {
  return `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 保存图片库条目(新增或按 id 覆盖,改名也走这里) */
export function saveImageItem(item: ImageLibraryItem): Promise<void> {
  return runLib('readwrite', (s) => s.put(item, item.id))
}

/** 读取全部图片库条目(按创建时间升序)。
 * **逐条容错(2026-08-08 修复"图片库永远空")**:原 getAll 一把梭——
 * library store 里有一条损坏记录(blob 文件丢失,Chromium 报
 * NotReadableError "Data lost due to missing file",实测)时,整个
 * 事务失败 → loadImageItems 恒返回 [] → 多媒体库图片 tab 永远空 →
 * "初次进入无法右键"。改为:先取键列表(不碰值),再逐条独立事务
 * get——坏记录只失败自身,其余正常;失败条目尝试删除(数据已不可
 * 恢复,移除毒瘤防继续毒害,下次读取自愈) */
export async function loadImageItems(): Promise<ImageLibraryItem[]> {
  try {
    const db = await openDb()
    const keys = await idbRun<IDBValidKey[]>(db, LIB_STORE, 'readonly', (s) => s.getAllKeys())
    const items: ImageLibraryItem[] = []
    for (const key of keys) {
      try {
        const v = await idbRun(db, LIB_STORE, 'readonly', (s) => s.get(key))
        if (v == null) continue
        if (
          v &&
          typeof v === 'object' &&
          typeof (v as ImageLibraryItem).id === 'string' &&
          typeof (v as ImageLibraryItem).dataUrl === 'string'
        ) {
          items.push(v as ImageLibraryItem)
        }
      } catch {
        // 坏记录(blob 丢失):数据不可恢复,尝试删除防继续毒害
        try {
          await idbRun(db, LIB_STORE, 'readwrite', (s) => s.delete(key))
        } catch {
          // 删除也失败则忽略(下次读取再试)
        }
      }
    }
    return items.sort((a, b) => a.createdAt - b.createdAt)
  } catch (err) {
    // 读取失败不静默(2026-08-08:静默返回空让用户看到"图片库空"却
    // 不知原因——多媒体库初次进入无法右键的隐藏根因之一;暴露真实错误)
    console.error('[backgroundStore] loadImageItems failed:', err)
    return []
  }
}

/** 删除图片库条目 */
export function deleteImageItem(id: string): Promise<void> {
  return runLib('readwrite', (s) => s.delete(id))
}

/**
 * 旧版单图迁移:老键 'image' 的图片复制到两个槽位(保持旧外观),
 * 随后删除老键。启动时调用一次。
 */
export async function migrateLegacyBackground(): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(LEGACY_IMAGE_KEY)
    const data = await new Promise<string | null>((resolve) => {
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null)
      req.onerror = () => resolve(null)
    })
    if (!data) return
    await saveBackgroundImage(data, 'expanded')
    await saveBackgroundImage(data, 'compact')
    await run('readwrite', (s) => s.delete(LEGACY_IMAGE_KEY))
  } catch {
    // 忽略迁移失败
  }
}

/** 背景图长边上限(px):岛体最大显示约 500×260(150% DPI 下 ~2 倍)。
 *  原图直存会导致形变(宽度/高度逐帧动画)时每帧重栅格化整张大图,
 *  是"带背景切换卡顿"的主因;降采样后重栅格化成本可忽略 */
const BG_MAX_EDGE_PX = 1024

/**
 * 背景图降采样(data URL → data URL):长边超过上限时经 canvas 缩放,
 *  PNG 保留透明(走 PNG),其余转 JPEG 压缩;不需要缩放时原样返回。
 */
export function downscaleBackgroundImage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const longEdge = Math.max(img.naturalWidth, img.naturalHeight)
      if (longEdge <= BG_MAX_EDGE_PX) {
        resolve(dataUrl)
        return
      }
      const scale = BG_MAX_EDGE_PX / longEdge
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const isPng = dataUrl.startsWith('data:image/png')
      resolve(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.85))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

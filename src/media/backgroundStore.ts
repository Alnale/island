/**
 * 自定义背景持久化存储(IndexedDB):
 * 背景图以 data URL 字符串存入独立库(图片可能超出 localStorage 容量),
 * 启动时恢复;透明度走 localStorage(小数值)。
 */

const DB_NAME = 'island-background'
const STORE = 'bg'
/** 旧版单图键(迁移用) */
const LEGACY_IMAGE_KEY = 'image'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function run(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        fn(tx.objectStore(STORE))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }),
  )
}

/** 默认裁切(cover 居中) */
export const DEFAULT_BG_CROP = { zoom: 1, posX: 50, posY: 50 }

/** 自定义背景完整状态:展开态 / 紧凑态各自独立的图片与裁切参数 */
export interface BackgroundState {
  expandedImage: string | null
  compactImage: string | null
  opacity: number
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
    return await new Promise<string | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(slot)
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

/** 清除指定槽位的背景图 */
export function clearBackgroundImage(slot: BackgroundSlot): Promise<void> {
  return run('readwrite', (s) => s.delete(slot))
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

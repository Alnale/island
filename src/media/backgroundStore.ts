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
 * 用户不透明度 → 叠在背景图上的深色蒙层。
 * 岛体在透明窗口里,背景图层不能用 CSS opacity:半透明层的 alpha
 * 会透出桌面,图被洗成发灰(约 90% 最明显)。蒙层和图片画在同一元素
 * 内,底下还有不透明实底,合成结果 alpha 为 1。
 * 缺省 / 非法值按完全显示(蒙层全透明)。
 */
export function backgroundVeilColor(opacity: number | undefined): string {
  const value =
    typeof opacity === 'number' && Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1
  const alpha = Math.round((1 - value) * 1000) / 1000
  return `rgba(8, 10, 14, ${alpha})`
}

/**
 * 新图落到不透明度为 0 的槽位时抬回默认值。
 * 0 会把图层完全盖住,上传后岛上看不到图。另一槽位不动。
 */
export function revealBackgroundOpacity(
  opacity: { expanded: number; compact: number },
  slot: BackgroundSlot,
): { expanded: number; compact: number } {
  if (opacity[slot] > 0) return opacity
  return { ...opacity, [slot]: DEFAULT_BG_OPACITY[slot] }
}
/**
 * 背景参数结构版本(写入时随参数落盘)。缺 v 字段 = 旧版写入的数据,
 * 其中的 0 不透明度按误伤修复(见 readBackgroundParams);带 v 的数据
 * 一律尊重用户取值(含有意设置的 0)。
 */
export const BACKGROUND_PARAMS_VERSION = 2

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
        /** 结构版本(saveBackgroundParams 写入;缺省 = 旧版数据) */
        v?: unknown
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
        // 旧版数据(无 v 标记)里的 0 不透明度自愈回默认(2026-10-22):
        // 旧读取逻辑把"键不存在"误判为旧值 0(见下方 else 分支),首改
        // 即把 0 写死进存储——用户导入背景后图层 opacity:0 完全不可见。
        // 0 = 背景图层全透明(等价于没有背景),旧数据里几乎必为误伤;
        // 修复后 saveBackgroundParams 一律带 v 标记,之后有意设置的 0
        // 不再被改写。
        if (typeof parsed.v !== 'number') {
          if (opacity.expanded === 0) opacity.expanded = DEFAULT_BG_OPACITY.expanded
          if (opacity.compact === 0) opacity.compact = DEFAULT_BG_OPACITY.compact
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
      // 兼容旧版:单独存储的不透明度(迁移为双槽位)。
      // 键不存在时 getItem 返回 null,而 Number(null) === 0 能通过 0~1
      // 校验——必须先判空,否则全新用户被当成"旧值 0",默认 0.4 被覆盖
      // 成 0(导入背景后 opacity 恒 0、图层不可见的根因)
      const legacy = localStorage.getItem(LEGACY_BACKGROUND_OPACITY_KEY)
      if (legacy != null && legacy.trim() !== '') {
        const old = Number(legacy)
        if (Number.isFinite(old) && old >= 0 && old <= 1) {
          opacity = { expanded: old, compact: old }
        }
      }
    }
  } catch {
    // 忽略存储失败
  }
  return { opacity, expanded, compact }
}

/** 保存背景参数(不透明度/裁切;图片本体走 IndexedDB)。
 *  随参数落盘结构版本 v:标记"新逻辑写入的数据",读取端据此不再对
 *  有意设置的 0 不透明度做误伤自愈 */
export function saveBackgroundParams(
  params: Pick<BackgroundState, 'opacity' | 'expanded' | 'compact'>,
): void {
  try {
    localStorage.setItem(
      BACKGROUND_PARAMS_KEY,
      JSON.stringify({ ...params, v: BACKGROUND_PARAMS_VERSION }),
    )
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
  /** 图片原始 data URL（不重采样、不转码） */
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

/**
 * 背景图导入预处理（兼容旧调用名）。
 *
 * 对话窗口现在可以扩展到 2K 甚至更宽，旧的 1024px 长边上限会把背景
 * 永久缩小后再由 CSS 放大，非 PNG 还会被转成 quality=0.85 的 JPEG，
 * 因此出现明显模糊和压缩痕迹。IndexedDB 可以保存完整 data URL，这里
 * 保留上传文件的原始字节，不再经过 Canvas 重采样或转码。
 */
export function downscaleBackgroundImage(dataUrl: string): Promise<string> {
  return Promise.resolve(dataUrl)
}

/** data URL → 显示用 blob URL。键是原始 data URL，值是 blob URL。 */
const backgroundDisplayUrls = new Map<string, string>()

/** Chromium 对超长 CSS 自定义属性会直接丢弃(约 200 万字符以上实测失败)。
 *  手机图 / 插画 data URL 经常有 4–6MB,写进 --bg-img-* 后背景层只剩实底,
 *  裁切框(直接写 background-image)却能看到图,像上传没生效。 */
const CSS_VAR_URL_MAX = 1_500_000

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('invalid data url')
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  const mime = /^data:([^;,]+)/i.exec(meta)?.[1] || 'application/octet-stream'
  if (/;base64/i.test(meta)) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  }
  return new Blob([decodeURIComponent(payload)], { type: mime })
}

/**
 * 给岛体背景层使用的短 URL。data URL 转成 blob URL,CSS 变量放得下;
 * 同一张图重复取用同一个 URL,避免滑杆拖动时反复解码。
 * 转码失败且原文过长时返回 null(写进变量也显示不出来)。
 */
export function backgroundDisplayUrl(src: string | null | undefined): string | null {
  if (!src) return null
  if (!src.startsWith('data:')) return src
  const cached = backgroundDisplayUrls.get(src)
  if (cached) return cached
  try {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return src.length > CSS_VAR_URL_MAX ? null : src
    }
    const url = URL.createObjectURL(dataUrlToBlob(src))
    backgroundDisplayUrls.set(src, url)
    return url
  } catch {
    return src.length > CSS_VAR_URL_MAX ? null : src
  }
}

/** `background-image` / CSS 变量用的 url() 值。没有可用地址时是 none。 */
export function backgroundCssUrl(src: string | null | undefined): string {
  const url = backgroundDisplayUrl(src)
  if (!url) return 'none'
  return `url("${url.replace(/[\n\r"\\]/g, '')}")`
}

/** 释放不再显示的 blob URL。keep 里的 data URL 继续留着。 */
export function releaseBackgroundDisplayUrls(keep: Iterable<string | null | undefined>): void {
  const stay = new Set<string>()
  for (const src of keep) {
    if (src) stay.add(src)
  }
  for (const [src, url] of backgroundDisplayUrls) {
    if (stay.has(src)) continue
    try {
      URL.revokeObjectURL(url)
    } catch {
      // 忽略已经失效的 URL
    }
    backgroundDisplayUrls.delete(src)
  }
}

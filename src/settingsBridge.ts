/**
 * 灵动岛设置桥 —— 渲染端暴露给主进程(LLM 设置工具)的设置操作入口
 *
 * 架构:引擎设置工具(electron/agent/settingsTools.ts,主进程)经
 * runIslandSettings → executeJavaScript 在页面上下文调用本桥的
 * window.__islandSettings 方法。每个操作:写 localStorage / IndexedDB
 * (与设置界面 UI 同款存储层)→ **派发 island-settings-changed 事件**
 * (带 scopes)→ WidgetApp / DynamicIsland 监听重读 React 状态 →
 * 即时生效(无需用户进设置界面)。
 *
 * 仅在挂件版注册(WidgetApp 挂载时);Web 演示版无主进程工具调用,不注册。
 * 桥只做存储写入与事件通知,不直接操作 React 状态(状态刷新统一走监听)。
 */

import {
  deleteImageItem,
  downscaleBackgroundImage,
  genImageId,
  loadImageItems,
  saveBackgroundImage,
  saveImageItem,
  type ImageLibraryItem,
} from './media/backgroundStore'
import {
  deleteFontItem as deleteFontItemStore,
  genFontId,
  loadFontItems,
  loadFontSettings,
  saveFontItem,
  saveFontSettings,
  type FontLibraryItem,
} from './media/fontStore'

/** 主题色持久化键(与 WidgetApp 的 THEME_STORAGE_KEY 一致) */
export const THEME_STORAGE_KEY = 'widget-theme-color'
/** Agent 界面缩放持久化键(与 DynamicIsland 的 AGENT_SCALE_KEY 一致) */
export const AGENT_SCALE_STORAGE_KEY = 'widget-agent-scale'
/** 设置变更事件名(桥写完存储后派发,UI 监听重读) */
export const ISLAND_SETTINGS_EVENT = 'island-settings-changed'
/** 变更涉及的状态域(监听方按域重读对应状态) */
export type IslandSettingsScope = 'theme' | 'scale' | 'font' | 'background' | 'imageLibrary'

/** 桥方法(主进程 executeJavaScript 调用;方法名与 settingsTools 的 op 一致) */
export interface IslandSettingsBridge {
  setThemeColor(color: string): Promise<{ ok: true; color: string }>
  setAgentScale(percent: number): Promise<{ ok: true; scale: number }>
  importFont(dataUrl: string, name: string): Promise<{ ok: true; id: string; name: string }>
  listFonts(): Promise<Array<{ id: string; name: string }>>
  renameFont(id: string, name: string): Promise<{ ok: true; id: string; name: string }>
  importBackground(dataUrl: string, name: string): Promise<{ ok: true; id: string; name: string }>
  listLibraryImages(): Promise<Array<{ id: string; name: string }>>
  renameLibraryImage(id: string, name: string): Promise<{ ok: true; id: string; name: string }>
  /** 删除字体库条目(巡检清理用;不暴露给 LLM 工具) */
  deleteFontItem(id: string): Promise<{ ok: true }>
  /** 删除图片库条目(巡检清理用;不暴露给 LLM 工具) */
  deleteLibraryImage(id: string): Promise<{ ok: true }>
}

/** 通知 UI 重读对应状态域 */
function notify(scopes: IslandSettingsScope[]) {
  window.dispatchEvent(new CustomEvent(ISLAND_SETTINGS_EVENT, { detail: { scopes } }))
}

function hexColor(color: string): string {
  const t = String(color ?? '').trim()
  const hex = t.startsWith('#') ? t : `#${t}`
  return hex.toLowerCase()
}

export function registerIslandSettingsBridge(): void {
  if (window.__islandSettings) return
  const bridge: IslandSettingsBridge = {
    // 主题色:写 localStorage,UI 经事件重读(WidgetApp setCustomTheme)
    async setThemeColor(color) {
      const hex = hexColor(color)
      try {
        localStorage.setItem(THEME_STORAGE_KEY, hex)
      } catch {
        // 存储失败(如隐私模式)仍按成功处理,UI 层重读不到就保持原样
      }
      notify(['theme'])
      return { ok: true, color: hex }
    },
    // Agent 界面缩放:写 localStorage,UI 经事件重读(DynamicIsland agentScale)
    async setAgentScale(percent) {
      const scale = Math.min(300, Math.max(100, Math.round(Number(percent) || 100)))
      try {
        localStorage.setItem(AGENT_SCALE_STORAGE_KEY, String(scale))
      } catch {
        // 同上
      }
      notify(['scale'])
      return { ok: true, scale }
    },
    // 字体导入:入库并应用为当前字体(与设置界面字体上传一致)
    async importFont(dataUrl, name) {
      const item: FontLibraryItem = {
        id: genFontId(),
        name: String(name ?? '导入字体').slice(0, 50),
        dataUrl: String(dataUrl),
        createdAt: Date.now(),
      }
      await saveFontItem(item)
      const settings = loadFontSettings()
      saveFontSettings({ ...settings, currentFontId: item.id })
      notify(['font'])
      return { ok: true, id: item.id, name: item.name }
    },
    async listFonts() {
      const items = await loadFontItems()
      return items.map((f) => ({ id: f.id, name: f.name }))
    },
    async renameFont(id, name) {
      const items = await loadFontItems()
      const item = items.find((f) => f.id === id)
      if (!item) throw new Error(`字体不存在:${id}`)
      await saveFontItem({ ...item, name: String(name ?? '').slice(0, 50) })
      notify(['font'])
      return { ok: true, id, name: item.name }
    },
    // 背景导入:降采样(长边 ≤1024,与上传同款防卡顿)→ 展开/紧凑
    // 两槽位都应用(任意形态立即可见)→ 自动入库(名称按传入的)
    async importBackground(dataUrl, name) {
      const small = await downscaleBackgroundImage(String(dataUrl))
      await Promise.all([
        saveBackgroundImage(small, 'expanded'),
        saveBackgroundImage(small, 'compact'),
      ])
      const item: ImageLibraryItem = {
        id: genImageId(),
        name: String(name ?? '导入背景').slice(0, 50),
        dataUrl: small,
        createdAt: Date.now(),
      }
      await saveImageItem(item)
      notify(['background', 'imageLibrary'])
      return { ok: true, id: item.id, name: item.name }
    },
    async listLibraryImages() {
      const items = await loadImageItems()
      return items.map((img) => ({ id: img.id, name: img.name }))
    },
    async renameLibraryImage(id, name) {
      const items = await loadImageItems()
      const item = items.find((img) => img.id === id)
      if (!item) throw new Error(`图片不存在:${id}`)
      await saveImageItem({ ...item, name: String(name ?? '').slice(0, 50) })
      notify(['imageLibrary'])
      return { ok: true, id, name: item.name }
    },
    // 删除(巡检清理用;LLM 工具不暴露,防误删用户数据)
    async deleteFontItem(id) {
      await deleteFontItemStore(id)
      notify(['font'])
      return { ok: true }
    },
    async deleteLibraryImage(id) {
      await deleteImageItem(id)
      notify(['imageLibrary'])
      return { ok: true }
    },
  }
  window.__islandSettings = bridge
}

declare global {
  interface Window {
    __islandSettings?: IslandSettingsBridge
  }
}

/**
 * 双宿主(Web 演示版 App.tsx / 桌面挂件 WidgetApp.tsx)共用的定制状态管理:
 * 主题色 / 操作提示 / 背景图+图片库 / 字体库。
 *
 * 两端曾逐字重复 ~300 行(连注释都相同)——重复块正是 bug 高发区
 * (背景自动入库、字体库删除回退当前字体),统一后修一处两端生效
 * (2026-08-06 架构优化)。存储层与设置桥共用同一实现:
 * - 各 hook 内部按 scope 订阅 island-settings-changed(LLM 设置工具
 *   写入后自动重读;Web 演示版无桥、事件永不触发,监听无害);
 * - 读写一律走 backgroundStore / fontStore / settingsBridge 的共享函数。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearBackgroundImage,
  deleteImageItem,
  downscaleBackgroundImage,
  genImageId,
  loadBackgroundImage,
  loadImageItems,
  migrateLegacyBackground,
  readBackgroundParams,
  saveBackgroundImage,
  saveBackgroundParams,
  saveImageItem,
  type BackgroundState,
  type ImageLibraryItem,
} from '../media/backgroundStore'
import {
  deleteFontItem,
  loadFontItems,
  loadFontSettings,
  saveFontItem,
  saveFontSettings,
  type FontColorMode,
  type FontLibraryItem,
} from '../media/fontStore'
import { onSettingsChange, THEME_STORAGE_KEY } from '../settingsBridge'

/** 操作结果提示(模式/跳转不被客户端接受时在岛内短暂显示:
 *  紧凑态 = 左侧文字区文字,展开态 = 播放键下方,均为岛体原生文本样式) */
export function useHint() {
  const [hint, setHint] = useState<string | null>(null)
  const hintTimerRef = useRef(0)
  const showHint = useCallback((text: string) => {
    setHint(text)
    window.clearTimeout(hintTimerRef.current)
    hintTimerRef.current = window.setTimeout(() => setHint(null), 2600)
  }, [])
  // 卸载时清理提示计时器
  useEffect(() => () => window.clearTimeout(hintTimerRef.current), [])
  return { hint, showHint }
}

/** 自定义主题色(null = 跟随播放模式/状态色),localStorage 持久化(与挂件一致) */
export function useCustomTheme() {
  const [customTheme, setCustomTheme] = useState<string | null>(() => {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY)
    } catch {
      return null
    }
  })
  const applyCustomTheme = useCallback((color: string | null) => {
    setCustomTheme(color)
    try {
      if (color) localStorage.setItem(THEME_STORAGE_KEY, color)
      else localStorage.removeItem(THEME_STORAGE_KEY)
    } catch {
      // 忽略存储失败
    }
  }, [])
  // LLM 设置工具(set_theme_color)写存储后即时重读
  useEffect(
    () =>
      onSettingsChange(['theme'], () => {
        try {
          setCustomTheme(localStorage.getItem(THEME_STORAGE_KEY))
        } catch {
          // 忽略存储失败
        }
      }),
    [],
  )
  return { customTheme, setCustomTheme, applyCustomTheme }
}

/**
 * 自定义背景(双形态图片 + 裁切参数)+ 图片库:
 * 图片持久化 IndexedDB,裁切/不透明度参数走 localStorage(backgroundStore 共享读写)。
 * handleBackgroundChange 自动把新出现的背景图加入图片库(同名同图不重复)。
 */
export function useBackgroundStore() {
  const [background, setBackground] = useState<BackgroundState>(() => ({
    expandedImage: null,
    compactImage: null,
    ...readBackgroundParams(),
  }))
  // 图片库(背景视图"图片库"入口):条目 IndexedDB
  const [imageLibrary, setImageLibrary] = useState<ImageLibraryItem[]>([])
  const imageLibraryRef = useRef<ImageLibraryItem[]>([])
  // 旧版单图迁移后恢复两个槽位(IndexedDB);旧版本可能存了未降采样的
  // 大图,降采样后再用并回存(形变逐帧重栅格化大图是卡顿主因)
  useEffect(() => {
    void migrateLegacyBackground().then(() => {
      loadBackgroundImage('expanded').then((img) => {
        if (!img) return
        downscaleBackgroundImage(img).then((small) => {
          if (small !== img) {
            // 迁移回存前校验槽位当前值仍是迁移读出的旧图(启动期间用户
            // 可能已换背景,不能覆盖用户刚保存的新图)
            loadBackgroundImage('expanded').then((now) => {
              if (now === img) saveBackgroundImage(small, 'expanded').catch(() => {})
            })
          }
          setBackground((prev) => ({ ...prev, expandedImage: small }))
        })
      })
      loadBackgroundImage('compact').then((img) => {
        if (!img) return
        downscaleBackgroundImage(img).then((small) => {
          if (small !== img) {
            loadBackgroundImage('compact').then((now) => {
              if (now === img) saveBackgroundImage(small, 'compact').catch(() => {})
            })
          }
          setBackground((prev) => ({ ...prev, compactImage: small }))
        })
      })
    })
  }, [])
  useEffect(() => {
    void loadImageItems().then((items) => {
      imageLibraryRef.current = items
      setImageLibrary(items)
    })
  }, [])
  // 引用稳定:内联对象字面量每次渲染都是新引用,会击穿 DynamicIsland 的 memo
  const backgroundCropProp = useMemo(
    () => ({ expanded: background.expanded, compact: background.compact }),
    [background.expanded, background.compact],
  )
  const handleBackgroundChange = useCallback((bg: BackgroundState) => {
    setBackground(bg)
    saveBackgroundParams({ opacity: bg.opacity, expanded: bg.expanded, compact: bg.compact })
    if (bg.expandedImage) saveBackgroundImage(bg.expandedImage, 'expanded').catch(() => {})
    else clearBackgroundImage('expanded').catch(() => {})
    if (bg.compactImage) saveBackgroundImage(bg.compactImage, 'compact').catch(() => {})
    else clearBackgroundImage('compact').catch(() => {})
    // 自动入库:新出现的背景图(上传/图片库选择)加入图片库,同名同图不重复
    for (const dataUrl of [bg.expandedImage, bg.compactImage]) {
      if (!dataUrl) continue
      if (imageLibraryRef.current.some((img) => img.dataUrl === dataUrl)) continue
      const item: ImageLibraryItem = {
        id: genImageId(),
        name: `背景图 ${imageLibraryRef.current.length + 1}`,
        dataUrl,
        createdAt: Date.now(),
      }
      imageLibraryRef.current = [...imageLibraryRef.current, item]
      setImageLibrary(imageLibraryRef.current)
      void saveImageItem(item).catch(() => {})
    }
  }, [])
  const handleImageLibraryChange = useCallback((items: ImageLibraryItem[]) => {
    const newIds = new Set(items.map((img) => img.id))
    for (const item of items) void saveImageItem(item).catch(() => {})
    for (const item of imageLibraryRef.current) {
      if (!newIds.has(item.id)) void deleteImageItem(item.id).catch(() => {})
    }
    imageLibraryRef.current = items
    setImageLibrary(items)
  }, [])
  // LLM 设置工具(import_background / rename_library_image 等)写存储后即时重读
  useEffect(
    () =>
      onSettingsChange(['background', 'imageLibrary'], (scopes) => {
        if (scopes.includes('background')) {
          loadBackgroundImage('expanded').then((img) =>
            setBackground((prev) => ({ ...prev, expandedImage: img })),
          )
          loadBackgroundImage('compact').then((img) =>
            setBackground((prev) => ({ ...prev, compactImage: img })),
          )
          setBackground((prev) => ({ ...prev, ...readBackgroundParams() }))
        }
        if (scopes.includes('imageLibrary')) {
          void loadImageItems().then((items) => {
            imageLibraryRef.current = items
            setImageLibrary(items)
          })
        }
      }),
    [],
  )
  return {
    background,
    setBackground,
    backgroundCropProp,
    handleBackgroundChange,
    imageLibrary,
    imageLibraryRef,
    handleImageLibraryChange,
  }
}

/**
 * 自定义字体库:库条目 IndexedDB,当前字体 id 与颜色/粗细 localStorage。
 * 全量同步(增/删/改名):新数组逐条写入,不在新数组的旧条目删除;
 * 若当前应用字体被删,回退系统默认。
 */
export function useFontStore() {
  const [font, setFont] = useState<{
    currentFontId: string | null
    colorMode: FontColorMode
    colorValue: string | null
    weight: number
  }>(() => {
    const s = loadFontSettings()
    return {
      currentFontId: s.currentFontId,
      colorMode: s.colorMode,
      colorValue: s.colorValue,
      weight: s.weight,
    }
  })
  const [fontLibrary, setFontLibrary] = useState<FontLibraryItem[]>([])
  const fontLibraryRef = useRef<FontLibraryItem[]>([])
  const fontRef = useRef(font)
  fontRef.current = font
  useEffect(() => {
    void loadFontItems().then((items) => {
      fontLibraryRef.current = items
      setFontLibrary(items)
    })
  }, [])
  // 引用稳定:内联对象字面量每次渲染都是新引用,会击穿 DynamicIsland 的 memo
  const fontColorProp = useMemo(
    () => ({ mode: font.colorMode, value: font.colorValue }),
    [font.colorMode, font.colorValue],
  )
  const handleFontLibraryChange = useCallback((items: FontLibraryItem[]) => {
    const newIds = new Set(items.map((f) => f.id))
    for (const item of items) void saveFontItem(item).catch(() => {})
    for (const item of fontLibraryRef.current) {
      if (!newIds.has(item.id)) void deleteFontItem(item.id).catch(() => {})
    }
    fontLibraryRef.current = items
    setFontLibrary(items)
    if (fontRef.current.currentFontId && !newIds.has(fontRef.current.currentFontId)) {
      setFont((prev) => ({ ...prev, currentFontId: null }))
      saveFontSettings({ ...fontRef.current, currentFontId: null })
    }
  }, [])
  const handleFontAdd = useCallback((item: FontLibraryItem) => {
    void saveFontItem(item).catch(() => {})
    fontLibraryRef.current = [...fontLibraryRef.current, item]
    setFontLibrary(fontLibraryRef.current)
    setFont((prev) => ({ ...prev, currentFontId: item.id }))
    saveFontSettings({ ...fontRef.current, currentFontId: item.id })
  }, [])
  const handleFontSelect = useCallback((id: string | null) => {
    setFont((prev) => ({ ...prev, currentFontId: id }))
    saveFontSettings({ ...fontRef.current, currentFontId: id })
  }, [])
  const handleFontColorChange = useCallback(
    (colorMode: FontColorMode, colorValue: string | null) => {
      // auto 模式保留自定义色值(值为 null 时不覆盖),切回 custom 不丢失
      setFont((prev) => {
        const next = { ...prev, colorMode }
        if (colorValue !== null) next.colorValue = colorValue
        return next
      })
      saveFontSettings({
        ...fontRef.current,
        colorMode,
        colorValue: colorValue !== null ? colorValue : fontRef.current.colorValue,
      })
    },
    [],
  )
  const handleFontWeightChange = useCallback((weight: number) => {
    setFont((prev) => ({ ...prev, weight }))
    saveFontSettings({ ...fontRef.current, weight })
  }, [])
  // LLM 设置工具(import_font / set_font_color 等)写存储后即时重读
  useEffect(
    () =>
      onSettingsChange(['font'], () => {
        const s = loadFontSettings()
        setFont({
          currentFontId: s.currentFontId,
          colorMode: s.colorMode,
          colorValue: s.colorValue,
          weight: s.weight,
        })
        void loadFontItems().then((items) => {
          fontLibraryRef.current = items
          setFontLibrary(items)
        })
      }),
    [],
  )
  return {
    font,
    setFont,
    fontLibrary,
    setFontLibrary,
    fontLibraryRef,
    fontColorProp,
    handleFontLibraryChange,
    handleFontAdd,
    handleFontSelect,
    handleFontColorChange,
    handleFontWeightChange,
  }
}

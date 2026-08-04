import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { IslandColorPicker } from '../IslandColorPicker'
import { THEME_PRESETS } from '../layout'
import { BackFoot, PanelHead } from './shared'

export interface ThemeViewProps {
  /** 当前自定义主题色(null = 跟随播放模式/状态色) */
  customTheme?: string | null
  /** 当前生效的主题色(跟随模式/状态色或自定义) */
  theme: string
  /** 主题色涟漪:从触发位置扩散到全岛的流体动画 */
  onRipple: (color: string, x?: number, y?: number) => void
  islandRef: RefObject<HTMLDivElement | null>
  onThemeChange: (color: string | null) => void
  onBack: () => void
}

/** 主题色视图:预设色板(跟随播放模式 + 7 常用色)+ 岛内自绘取色器 + hex 输入 */
export function ThemeView({
  customTheme,
  theme,
  onRipple,
  islandRef,
  onThemeChange,
  onBack,
}: ThemeViewProps) {
  // 主题色 hex 输入(颜色页复用字体取色器,hex 防抖 200ms 联动)
  const [themeHex, setThemeHex] = useState(() => customTheme ?? theme)
  const themeHexDebounceRef = useRef(0)
  useEffect(() => {
    setThemeHex(customTheme ?? theme)
  }, [customTheme, theme])
  const handleThemeHexChange = (raw: string) => {
    setThemeHex(raw)
    window.clearTimeout(themeHexDebounceRef.current)
    themeHexDebounceRef.current = window.setTimeout(() => {
      const hex = /^#[0-9a-f]{6}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null
      if (!hex) return
      onThemeChange(hex)
    }, 200)
  }
  return (
    <div className="island-panel-list island-theme-view">
      <PanelHead title="主题色" count="岛体强调色" />
      <div className="island-color-main">
        {/* 预设色板(单行:跟随播放模式 + 7 常用色) */}
        <div className="island-theme-presets island-font-presets">
          <button
            type="button"
            className={`island-theme-swatch island-theme-swatch--follow${customTheme == null ? ' active' : ''}`}
            title="跟随播放模式/状态色"
            onClick={(event) => {
              event.stopPropagation()
              const rect = islandRef.current?.getBoundingClientRect()
              onRipple(
                theme,
                event.clientX - (rect?.left ?? 0),
                event.clientY - (rect?.top ?? 0),
              )
              onThemeChange(null)
            }}
          />
          {THEME_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              className={`island-theme-swatch${customTheme === c ? ' active' : ''}`}
              style={{ background: c, '--swatch-color': c } as CSSProperties}
              title={c}
              onClick={(event) => {
                event.stopPropagation()
                const rect = islandRef.current?.getBoundingClientRect()
                onRipple(c, event.clientX - (rect?.left ?? 0), event.clientY - (rect?.top ?? 0))
                onThemeChange(c)
              }}
            />
          ))}
        </div>
        {/* 取色器:与字体自定义颜色同款(SV 面 + 色相条) */}
        <IslandColorPicker
          value={customTheme ?? theme}
          onChange={(hex) => {
            onThemeChange(hex)
          }}
        />
        {/* hex 输入 + 当前色预览圆点 */}
        <div className="island-font-custom-row">
          <span className="island-font-custom-label">自定义颜色</span>
          <input
            type="text"
            className="island-font-hex"
            value={themeHex}
            maxLength={7}
            spellCheck={false}
            placeholder="#4ade80"
            onChange={(event) => {
              event.stopPropagation()
              handleThemeHexChange(event.target.value)
            }}
          />
          <span
            className="island-font-preview-dot"
            style={{ background: customTheme ?? theme }}
            aria-hidden="true"
          />
        </div>
      </div>
      <BackFoot onBack={onBack} />
    </div>
  )
}

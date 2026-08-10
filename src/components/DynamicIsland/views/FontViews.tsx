import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  FONT_WEIGHTS,
  type FontColorMode,
  type FontLibraryItem,
} from '../../../media/fontStore'
import { IslandColorPicker } from '../IslandColorPicker'
import { THEME_PRESETS } from '../layout'
import { BackButton, BackFoot, FontUploadControl, PanelHead } from './shared'

export interface FontViewProps {
  fontLibrary?: FontLibraryItem[]
  /** 当前应用字体的 dataUrl(null = 系统默认字体) */
  fontDataUrl: string | null
  fontFamilyName: string | null
  /** 上传/读取错误提示(预览行状态位短暂显示) */
  fontError: string | null
  fontWeight?: number
  fontColor?: { mode: FontColorMode; value: string | null }
  onFontWeightChange?: (weight: number) => void
  onFontSelect?: (id: string | null) => void
  onFontAdd?: (item: FontLibraryItem) => void
  onFontColorChange?: (mode: FontColorMode, value: string | null) => void
  onError: (msg: string) => void
  onOpenLibrary: () => void
  /** 进入自定义颜色页(独立大面板,色板 + 取色器 + hex) */
  onOpenColorView: () => void
  onBack: () => void
}

/** 字体设置视图(设置视图"字体"入口,岛内打开):
 *  上传自定义字体(注入 @font-face 应用到岛体全部文字)、
 *  字体颜色:自动(按背景亮度选黑/白保证可读)或自定义色。
 *  内容紧凑(预览单行 + 色板单行),复用列表容器样式 */
export function FontView({
  fontLibrary,
  fontDataUrl,
  fontFamilyName,
  fontError,
  fontWeight,
  fontColor,
  onFontWeightChange,
  onFontSelect,
  onFontAdd,
  onFontColorChange,
  onError,
  onOpenLibrary,
  onOpenColorView,
  onBack,
}: FontViewProps) {
  return (
    <div className="island-panel-list island-font-view">
      <PanelHead title="字体" count={`${fontLibrary?.length ?? 0} 款`} />
      {/* 预览行:示例文字(当前字体渲染)+ 字体名 + 启用状态/上传错误 */}
      <div className="island-font-preview">
        <span className="island-font-sample" aria-hidden="true">
          Aa 好
        </span>
        <span className="island-font-name">{fontFamilyName ?? '系统默认字体'}</span>
        <span className={`island-font-status${fontError ? ' island-font-status--error' : ''}`}>
          {fontError ?? (fontDataUrl ? '已启用' : '默认')}
        </span>
        {onFontWeightChange && (
          <span className="island-font-weights" role="group" aria-label="字体粗细">
            {FONT_WEIGHTS.map((w) => (
              <button
                key={w}
                type="button"
                className={`island-font-weight${(fontWeight ?? 400) === w ? ' on' : ''}`}
                style={{ fontWeight: w }}
                title={w === 400 ? '常规' : w >= 700 ? '粗体' : '细体'}
                onClick={(event) => {
                  event.stopPropagation()
                  onFontWeightChange(w)
                }}
              >
                {w === 400 ? '常规' : String(w)}
              </button>
            ))}
          </span>
        )}
      </div>
      {/* 操作行:上传字体(自动入库并应用)/ 字体库 / 恢复默认(取消应用) */}
      <div className="island-font-actions">
        <FontUploadControl
          className="island-ctl"
          label="上传字体"
          fontLibrary={fontLibrary}
          onFontAdd={onFontAdd}
          onFontSelect={onFontSelect}
          onError={onError}
        />
        <button
          type="button"
          className="island-ctl"
          onClick={(event) => {
            event.stopPropagation()
            onOpenLibrary()
          }}
        >
          <svg
            className="island-ctl-svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>
          <span>字体库</span>
        </button>
        {fontDataUrl && (
          <button
            type="button"
            className="island-ctl"
            onClick={(event) => {
              event.stopPropagation()
              onFontSelect?.(null)
            }}
          >
            <svg
              className="island-ctl-svg"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            <span>恢复默认</span>
          </button>
        )}
      </div>
      {/* 颜色模式:自动(按背景亮度选黑白)/ 自定义(独立颜色页,
          色板 + hex + 拾色器,避免内嵌区被压缩截断) */}
      <div
        className={`island-bg-seg island-font-seg${fontColor?.mode === 'custom' ? ' island-bg-seg--compact' : ''}`}
        role="tablist"
        aria-label="字体颜色模式"
      >
        <span className="island-bg-seg-thumb" aria-hidden="true" />
        <button
          type="button"
          className={fontColor?.mode === 'auto' ? 'on' : ''}
          onClick={(event) => {
            event.stopPropagation()
            onFontColorChange?.('auto', null)
          }}
        >
          自动黑白
        </button>
        <button
          type="button"
          className={fontColor?.mode === 'custom' ? 'on' : ''}
          onClick={(event) => {
            event.stopPropagation()
            onFontColorChange?.('custom', fontColor?.value ?? '#ffffff')
            onOpenColorView()
          }}
        >
          自定义
          {fontColor?.mode === 'custom' && (
            <span
              className="island-font-seg-dot"
              style={{ background: fontColor.value ?? '#fff' }}
              aria-hidden="true"
            />
          )}
        </button>
      </div>
      {/* 返回设置视图(与背景/帮助/主题色同款扁平返回键);
          margin-top:auto 贴底,auto 模式折叠岛体后不留空档 */}
      <div className="island-panel-list-foot island-bg-foot island-font-foot">
        <BackButton onClick={onBack} />
      </div>
    </div>
  )
}

export interface FontColorViewProps {
  fontColor?: { mode: FontColorMode; value: string | null }
  onFontColorChange?: (mode: FontColorMode, value: string | null) => void
  onBack: () => void
}

/** 自定义颜色页(字体视图"自定义"入口,岛内打开):
 *  预设色板 + 岛内自绘取色器(SV 面 + 色相条)+ hex 输入,
 *  不弹系统对话框,UI 不出岛 */
export function FontColorView({ fontColor, onFontColorChange, onBack }: FontColorViewProps) {
  // 字体自定义颜色:hex 输入(防抖 200ms 联动;非法输入不提交)
  const [fontHex, setFontHex] = useState(() =>
    fontColor?.value && /^#[0-9a-f]{6}$/i.test(fontColor.value) ? fontColor.value : '#ffffff',
  )
  const fontHexDebounceRef = useRef(0)
  const fontColorRef = useRef(fontColor)
  fontColorRef.current = fontColor
  useEffect(() => {
    setFontHex(
      fontColor?.value && /^#[0-9a-f]{6}$/i.test(fontColor.value) ? fontColor.value : '#ffffff',
    )
  }, [fontColor?.value])
  useEffect(() => () => window.clearTimeout(fontHexDebounceRef.current), [])
  const handleFontHexChange = (raw: string) => {
    setFontHex(raw)
    window.clearTimeout(fontHexDebounceRef.current)
    fontHexDebounceRef.current = window.setTimeout(() => {
      const hex = /^#[0-9a-f]{6}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null
      if (!hex) return
      // 防抖期间切走了模式(如点了自动黑白)则不提交,避免把模式改回自定义
      if (fontColorRef.current?.mode !== 'custom') return
      onFontColorChange?.('custom', hex)
    }, 200)
  }
  return (
    <div className="island-panel-list island-font-color-view">
      <PanelHead title="自定义颜色" count="字体文字颜色" />
      <div className="island-color-main">
        {/* 预设色板(单行,7 色) */}
        <div className="island-theme-presets island-font-presets">
          {THEME_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              className={`island-theme-swatch${fontColor?.value === c ? ' active' : ''}`}
              style={{ background: c, '--swatch-color': c } as CSSProperties}
              title={c}
              onClick={(event) => {
                event.stopPropagation()
                setFontHex(c)
                onFontColorChange?.('custom', c)
              }}
            />
          ))}
        </div>
        {/* 取色器:SV 面 + 色相条(与主题色共用组件) */}
        <IslandColorPicker
          value={fontColor?.value ?? '#ffffff'}
          onChange={(hex) => onFontColorChange?.('custom', hex)}
        />
        {/* 自定义颜色:hex 输入 + 当前色预览圆点 */}
        <div className="island-font-custom-row">
          <span className="island-font-custom-label">自定义颜色</span>
          <input
            type="text"
            className="island-font-hex"
            value={fontHex}
            maxLength={7}
            spellCheck={false}
            placeholder="#ffffff"
            onChange={(event) => {
              event.stopPropagation()
              handleFontHexChange(event.target.value)
            }}
          />
          <span
            className="island-font-preview-dot"
            style={{ background: fontColor?.value ?? '#fff' }}
            aria-hidden="true"
          />
        </div>
      </div>
      <BackFoot onBack={onBack} />
    </div>
  )
}

export interface FontLibraryViewProps {
  fontLibrary?: FontLibraryItem[]
  currentFontId?: string | null
  onFontSelect?: (id: string | null) => void
  onFontLibraryChange?: (items: FontLibraryItem[]) => void
  onFontAdd?: (item: FontLibraryItem) => void
  onError: (msg: string) => void
  onBack: () => void
}

/** 字体库页面(字体视图"字体库"入口,岛内打开,大面板):
 *  搜索 / 列表(点击应用、行内编辑名称、删除)/ 上传入库 */
export function FontLibraryView({
  fontLibrary,
  currentFontId,
  onFontSelect,
  onFontLibraryChange,
  onFontAdd,
  onError,
  onBack,
}: FontLibraryViewProps) {
  // 字体库页面:搜索 / 行内编辑名称
  const [fontSearch, setFontSearch] = useState('')
  const [editingFontId, setEditingFontId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const filteredFonts = (fontLibrary ?? []).filter((f) =>
    fontSearch.trim() ? f.name.toLowerCase().includes(fontSearch.trim().toLowerCase()) : true,
  )
  const startFontRename = (item: FontLibraryItem) => {
    setEditingFontId(item.id)
    setRenameDraft(item.name)
  }
  const commitFontRename = () => {
    const id = editingFontId
    const name = renameDraft.trim()
    setEditingFontId(null)
    if (!id || !name || !onFontLibraryChange || !fontLibrary) return
    onFontLibraryChange(fontLibrary.map((f) => (f.id === id ? { ...f, name } : f)))
  }
  const deleteFontRow = (item: FontLibraryItem) => {
    if (!onFontLibraryChange || !fontLibrary) return
    onFontLibraryChange(fontLibrary.filter((f) => f.id !== item.id))
  }
  return (
    <div className="island-panel-list island-lib-view">
      <PanelHead title="字体库" count={`${fontLibrary?.length ?? 0} 款`} />
      <input
        type="text"
        className="island-lib-search"
        placeholder="搜索字体名称…"
        value={fontSearch}
        onChange={(event) => {
          event.stopPropagation()
          setFontSearch(event.target.value)
        }}
      />
      <ul className="island-lib-list">
        {filteredFonts.length === 0 && (
          <li className="island-track-empty">
            {fontSearch.trim() ? '没有匹配的字体' : '暂无字体,点击下方上传'}
          </li>
        )}
        {filteredFonts.map((f) => (
          <li
            key={f.id}
            className={`island-lib-row${currentFontId === f.id ? ' active' : ''}`}
          >
            {editingFontId === f.id ? (
              <input
                type="text"
                className="island-lib-edit-input"
                value={renameDraft}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation()
                  setRenameDraft(event.target.value)
                }}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') commitFontRename()
                  if (event.key === 'Escape') setEditingFontId(null)
                }}
                onBlur={commitFontRename}
              />
            ) : (
              <>
                <button
                  type="button"
                  className="island-lib-row-main"
                  onClick={(event) => {
                    event.stopPropagation()
                    onFontSelect?.(f.id)
                  }}
                >
                  <span className="island-lib-row-name">{f.name}</span>
                  <span className="island-lib-row-sub">
                    {currentFontId === f.id ? '已应用' : '点击应用'}
                  </span>
                </button>
                <button
                  type="button"
                  className="island-lib-row-act"
                  title="编辑名称"
                  aria-label={`编辑 ${f.name} 名称`}
                  onClick={(event) => {
                    event.stopPropagation()
                    startFontRename(f)
                  }}
                >
                  <svg
                    className="island-ctl-svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="island-lib-row-act island-lib-row-del"
                  title="删除"
                  aria-label={`删除 ${f.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    deleteFontRow(f)
                  }}
                >
                  <svg
                    className="island-ctl-svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="island-lib-foot">
        <FontUploadControl
          className="island-ctl island-ctl--upload"
          label="上传字体"
          fontLibrary={fontLibrary}
          onFontAdd={onFontAdd}
          onFontSelect={onFontSelect}
          onError={onError}
        />
        <button
          type="button"
          className="island-ctl island-ctl--back"
          onClick={(event) => {
            event.stopPropagation()
            onBack()
          }}
        >
          <svg
            className="island-ctl-svg"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>返回</span>
        </button>
      </div>
    </div>
  )
}

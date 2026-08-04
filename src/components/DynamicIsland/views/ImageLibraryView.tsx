import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  DEFAULT_BG_CROP,
  downscaleBackgroundImage,
  genImageId,
  type ImageLibraryItem,
} from '../../../media/backgroundStore'
import { PanelHead } from './shared'

/** 图片库条目应用后卡片短暂高亮时长(ms) */
const APPLIED_HIGHLIGHT_MS = 1200

export interface ImageLibraryViewProps {
  imageLibrary?: ImageLibraryItem[]
  onImageLibraryChange?: (items: ImageLibraryItem[]) => void
  onBackgroundChange?: (bg: {
    expandedImage: string | null
    compactImage: string | null
    opacity: { expanded: number; compact: number }
    expanded: { zoom: number; posX: number; posY: number }
    compact: { zoom: number; posX: number; posY: number }
  }) => void
  backgroundOpacity?: { expanded: number; compact: number }
  expandedImage: string | null
  compactImage: string | null
  /** 应用目标形态(图片库选择应用到当前编辑形态的槽位) */
  bgTarget: 'expanded' | 'compact'
  expandedCrop: { zoom: number; posX: number; posY: number }
  compactCrop: { zoom: number; posX: number; posY: number }
  onBack: () => void
}

/** 图片库页面(背景视图"图片库"入口,岛内打开,大面板):
 *  搜索 / 网格(点击应用当前形态、行内编辑名称、删除)/ 上传入库 */
export function ImageLibraryView({
  imageLibrary,
  onImageLibraryChange,
  onBackgroundChange,
  backgroundOpacity,
  expandedImage,
  compactImage,
  bgTarget,
  expandedCrop,
  compactCrop,
  onBack,
}: ImageLibraryViewProps) {
  // 图片库页面:搜索 / 行内编辑名称 / 上传入库 / 选择应用
  const [imageSearch, setImageSearch] = useState('')
  const [editingImageId, setEditingImageId] = useState<string | null>(null)
  const [imageRenameDraft, setImageRenameDraft] = useState('')
  const imageLibInputRef = useRef<HTMLInputElement>(null)
  const filteredImages = (imageLibrary ?? []).filter((img) =>
    imageSearch.trim() ? img.name.toLowerCase().includes(imageSearch.trim().toLowerCase()) : true,
  )
  const startImageRename = (item: ImageLibraryItem) => {
    setEditingImageId(item.id)
    setImageRenameDraft(item.name)
  }
  const commitImageRename = () => {
    const id = editingImageId
    const name = imageRenameDraft.trim()
    setEditingImageId(null)
    if (!id || !name || !onImageLibraryChange || !imageLibrary) return
    onImageLibraryChange(imageLibrary.map((img) => (img.id === id ? { ...img, name } : img)))
  }
  const deleteImageRow = (item: ImageLibraryItem) => {
    if (!onImageLibraryChange || !imageLibrary) return
    onImageLibraryChange(imageLibrary.filter((img) => img.id !== item.id))
  }
  // 图片库应用反馈:点击卡片短暂高亮(1.2s 后消除)
  const [appliedImageId, setAppliedImageId] = useState<string | null>(null)
  const appliedImageTimerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(appliedImageTimerRef.current), [])
  // 应用库中图片到当前编辑形态的背景槽位(与直接上传同一路径)
  const applyLibraryImage = (item: ImageLibraryItem) => {
    if (!onBackgroundChange) return
    setAppliedImageId(item.id)
    window.clearTimeout(appliedImageTimerRef.current)
    appliedImageTimerRef.current = window.setTimeout(() => setAppliedImageId(null), APPLIED_HIGHLIGHT_MS)
    onBackgroundChange({
      expandedImage: bgTarget === 'expanded' ? item.dataUrl : expandedImage,
      compactImage: bgTarget === 'compact' ? item.dataUrl : compactImage,
      opacity: backgroundOpacity ?? { expanded: 0.4, compact: 0.4 },
      expanded: bgTarget === 'expanded' ? DEFAULT_BG_CROP : expandedCrop,
      compact: bgTarget === 'compact' ? DEFAULT_BG_CROP : compactCrop,
    })
  }
  // 图片库上传:降采样 → 入库(保留文件名)并应用到当前形态
  const handleImageLibraryUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !onImageLibraryChange) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') return
      void downscaleBackgroundImage(reader.result).then((small) => {
        const item: ImageLibraryItem = {
          id: genImageId(),
          name: file.name.replace(/\.[^.]+$/, ''),
          dataUrl: small,
          createdAt: Date.now(),
        }
        onImageLibraryChange([...(imageLibrary ?? []), item])
        applyLibraryImage(item)
      })
    }
    reader.readAsDataURL(file)
  }
  return (
    <div className="island-panel-list island-lib-view">
      <PanelHead title="图片库" count={`${imageLibrary?.length ?? 0} 张`} />
      <input
        type="text"
        className="island-lib-search"
        placeholder="搜索图片名称…"
        value={imageSearch}
        onChange={(event) => {
          event.stopPropagation()
          setImageSearch(event.target.value)
        }}
      />
      <ul className="island-lib-grid">
        {filteredImages.length === 0 && (
          <li className="island-track-empty">
            {imageSearch.trim() ? '没有匹配的图片' : '暂无图片,点击下方上传'}
          </li>
        )}
        {filteredImages.map((img) => (
          <li
            key={img.id}
            className={`island-lib-card${appliedImageId === img.id ? ' applied' : ''}${editingImageId === img.id ? ' editing' : ''}`}
          >
            {editingImageId === img.id ? (
              <input
                type="text"
                className="island-lib-edit-input island-lib-edit-input--card"
                value={imageRenameDraft}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation()
                  setImageRenameDraft(event.target.value)
                }}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') commitImageRename()
                  if (event.key === 'Escape') setEditingImageId(null)
                }}
                onBlur={commitImageRename}
              />
            ) : (
              <>
                <button
                  type="button"
                  className="island-lib-card-main"
                  title={img.name}
                  onClick={(event) => {
                    event.stopPropagation()
                    applyLibraryImage(img)
                  }}
                >
                  <span
                    className="island-lib-card-thumb"
                    style={{ backgroundImage: `url("${img.dataUrl}")` }}
                    aria-hidden="true"
                  />
                  <span className="island-lib-card-name">{img.name}</span>
                </button>
                <span className="island-lib-card-acts">
                  <button
                    type="button"
                    className="island-lib-row-act"
                    title="编辑名称"
                    aria-label={`编辑 ${img.name} 名称`}
                    onClick={(event) => {
                      event.stopPropagation()
                      startImageRename(img)
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
                    aria-label={`删除 ${img.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      deleteImageRow(img)
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
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="island-lib-foot">
        <button
          type="button"
          className="island-ctl island-ctl--upload"
          onClick={(event) => {
            event.stopPropagation()
            imageLibInputRef.current?.click()
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
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>上传图片</span>
        </button>
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
      {/* 图片库上传(隐藏输入,由"上传图片"按钮触发) */}
      <input
        ref={imageLibInputRef}
        type="file"
        accept="image/*"
        hidden
        onClick={(event) => event.stopPropagation()}
        onChange={handleImageLibraryUpload}
      />
    </div>
  )
}

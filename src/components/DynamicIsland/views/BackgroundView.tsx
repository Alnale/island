import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react'
import { downscaleBackgroundImage } from '../../../media/backgroundStore'
import { BackFoot } from './shared'

/** 默认裁切(cover 居中) */
const DEFAULT_CROP = { zoom: 1, posX: 50, posY: 50 }
// 裁切参考尺寸:展开态 400×244、紧凑态 280×56(挂件典型宽度)
const BG_CROP_REF_W = 400
const BG_CROP_REF_H = 244
const BG_COMPACT_REF_W = 280
const BG_COMPACT_REF_H = 56

export interface BackgroundViewProps {
  /** 当前编辑目标(展开态 / 紧凑态):视口蒙版与滑杆作用于该形态 */
  bgTarget: 'expanded' | 'compact'
  expandedImage: string | null
  compactImage: string | null
  /** 不透明度(展开态 / 紧凑态各自独立,0-1) */
  backgroundOpacity?: { expanded: number; compact: number }
  backgroundCrop: {
    expanded: { zoom: number; posX: number; posY: number }
    compact: { zoom: number; posX: number; posY: number }
  }
  onBackgroundChange: (bg: {
    expandedImage: string | null
    compactImage: string | null
    opacity: { expanded: number; compact: number }
    expanded: { zoom: number; posX: number; posY: number }
    compact: { zoom: number; posX: number; posY: number }
  }) => void
  onTargetChange: (target: 'expanded' | 'compact') => void
  /** 宿主支持图片库时显示"图片库"入口 */
  imageLibraryAvailable: boolean
  onOpenImageLibrary: () => void
  onBack: () => void
}

/**
 * 自定义背景视图(托盘菜单入口,岛内打开):
 * 一键上传即应用(cover 居中),之后可用双形态蒙版裁切
 * (展开态视口拖拽平移 + 紧凑态胶囊预览,岛体本身即实时预览);
 * 无预览区——上传后默认就已更换
 */
export function BackgroundView({
  bgTarget,
  expandedImage,
  compactImage,
  backgroundOpacity,
  backgroundCrop,
  onBackgroundChange,
  onTargetChange,
  imageLibraryAvailable,
  onOpenImageLibrary,
  onBack,
}: BackgroundViewProps) {
  const expandedCrop = backgroundCrop.expanded
  const compactCrop = backgroundCrop.compact
  const activeCrop = bgTarget === 'expanded' ? expandedCrop : compactCrop
  const activeImage = bgTarget === 'expanded' ? expandedImage : compactImage
  // 不透明度按形态独立:滑杆只改当前编辑形态,另一形态不受影响
  const opacity = backgroundOpacity ?? { expanded: 0.4, compact: 0.4 }
  // 各形态背景图的自然尺寸(计算 cover 基准与可平移余量)
  const [bgNaturalE, setBgNaturalE] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!expandedImage) {
      setBgNaturalE(null)
      return
    }
    const img = new Image()
    img.onload = () => setBgNaturalE({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = expandedImage
  }, [expandedImage])
  const [bgNaturalC, setBgNaturalC] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!compactImage) {
      setBgNaturalC(null)
      return
    }
    const img = new Image()
    img.onload = () => setBgNaturalC({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = compactImage
  }, [compactImage])
  // 背景尺寸 %(相对元素宽度):1x = cover;null = 图片尺寸未知(加载中)
  const bgSizePctFor = (refW: number, refH: number, zoom: number, w: number, h: number): number =>
    Math.max(100, (refH / refW) * (w / h) * 100) * zoom
  const bgSizeExpanded = bgNaturalE
    ? bgSizePctFor(BG_CROP_REF_W, BG_CROP_REF_H, expandedCrop.zoom, bgNaturalE.w, bgNaturalE.h)
    : null
  const bgSizeCompact = bgNaturalC
    ? bgSizePctFor(
        BG_COMPACT_REF_W,
        BG_COMPACT_REF_H,
        compactCrop.zoom,
        bgNaturalC.w,
        bgNaturalC.h,
      )
    : null
  const bgStyleFor = (
    image: string,
    sizePct: number | null,
    posX: number,
    posY: number,
  ): CSSProperties => ({
    backgroundImage: `url("${image}")`,
    backgroundSize: sizePct ? `${sizePct}%` : 'cover',
    backgroundPosition: sizePct ? `${posX}% ${posY}%` : '50% 50%',
  })
  // 更新当前编辑目标的裁切参数(另一形态的图片与裁切均不受影响)
  const patchActiveCrop = (patch: Partial<{ zoom: number; posX: number; posY: number }>) => {
    const next = { ...activeCrop, ...patch }
    onBackgroundChange({
      expandedImage,
      compactImage,
      opacity,
      expanded: bgTarget === 'expanded' ? next : expandedCrop,
      compact: bgTarget === 'compact' ? next : compactCrop,
    })
  }
  // 视口图片切换的淡出层:background-image 不支持过渡,切换编辑形态时
  // 记下旧图快照覆盖在新图上淡出(crossfade),避免图片生硬瞬切
  const [fadeSnapshot, setFadeSnapshot] = useState<{
    image: string
    size: number | null
    posX: number
    posY: number
  } | null>(null)
  const [fadeOut, setFadeOut] = useState(false)
  const bgFadeTimerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(bgFadeTimerRef.current), [])
  // 切换编辑目标:先留旧图快照做淡出层,再切形态(350ms 后清理快照)
  const handleBgTargetChange = (target: 'expanded' | 'compact') => {
    if (target === bgTarget) return
    const cur = bgTarget === 'expanded' ? expandedImage : compactImage
    const curCrop = bgTarget === 'expanded' ? expandedCrop : compactCrop
    if (cur) {
      setFadeSnapshot({
        image: cur,
        size: bgTarget === 'expanded' ? bgSizeExpanded : bgSizeCompact,
        posX: curCrop.posX,
        posY: curCrop.posY,
      })
      setFadeOut(false)
      // 下一帧再淡出:先让新图与淡出层同帧就位,opacity 过渡才会触发
      requestAnimationFrame(() => setFadeOut(true))
      window.clearTimeout(bgFadeTimerRef.current)
      bgFadeTimerRef.current = window.setTimeout(() => setFadeSnapshot(null), 360)
    } else {
      setFadeSnapshot(null)
    }
    onTargetChange(target)
  }
  // 裁切视口拖拽平移:拖动图片选择可见区域(位置 % 相对"图片超出视口"的余量)
  const bgPanRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startPosX: number
    startPosY: number
  } | null>(null)
  const handleBgPanDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    bgPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosX: activeCrop.posX,
      startPosY: activeCrop.posY,
    }
  }
  const handleBgPanMove = (event: PointerEvent<HTMLDivElement>) => {
    const pan = bgPanRef.current
    if (!pan || event.pointerId !== pan.pointerId) return
    const natural = bgTarget === 'expanded' ? bgNaturalE : bgNaturalC
    if (!natural) return
    const sizePct = bgTarget === 'expanded' ? bgSizeExpanded : bgSizeCompact
    if (sizePct === null) return
    const el = event.currentTarget
    const vw = el.clientWidth
    const vh = el.clientHeight
    const overflowW = (sizePct / 100 - 1) * vw
    const overflowH = (sizePct / 100) * vw * (natural.h / natural.w) - vh
    const dx = event.clientX - pan.startX
    const dy = event.clientY - pan.startY
    const clamp01 = (v: number) => Math.max(0, Math.min(100, v))
    const nextX = overflowW > 0 ? clamp01(pan.startPosX - (dx / overflowW) * 100) : 50
    const nextY = overflowH > 0 ? clamp01(pan.startPosY - (dy / overflowH) * 100) : 50
    if (nextX !== activeCrop.posX || nextY !== activeCrop.posY) {
      patchActiveCrop({ posX: nextX, posY: nextY })
    }
  }
  const handleBgPanEnd = (event: PointerEvent<HTMLDivElement>) => {
    const pan = bgPanRef.current
    if (pan && pan.pointerId === event.pointerId) bgPanRef.current = null
  }
  // 滚轮缩放(以视口中心为锚:位置 % 不变,中心内容保持)
  const handleBgWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
    const next = Math.max(1, Math.min(4, activeCrop.zoom * factor))
    if (next === activeCrop.zoom) return
    patchActiveCrop({ zoom: next })
  }
  // 双击复位当前形态的裁切(cover 居中)
  const handleBgDoubleClick = () => {
    if (activeCrop.zoom === 1 && activeCrop.posX === 50 && activeCrop.posY === 50) return
    patchActiveCrop({ zoom: 1, posX: 50, posY: 50 })
  }
  // 背景图片上传输入(自定义背景视图)
  const bgFileInputRef = useRef<HTMLInputElement>(null)
  /** 上传背景图:读取为 data URL 后一键应用(cover 居中),之后可裁切微调 */
  const handleBackgroundFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        // 先降采样(形变逐帧重栅格化大图是卡顿主因),再一键应用到当前形态
        // (该形态 cover 居中,另一形态的图片与裁切不受影响)
        void downscaleBackgroundImage(reader.result).then((small) => {
          onBackgroundChange({
            expandedImage: bgTarget === 'expanded' ? small : expandedImage,
            compactImage: bgTarget === 'compact' ? small : compactImage,
            opacity,
            expanded: bgTarget === 'expanded' ? DEFAULT_CROP : expandedCrop,
            compact: bgTarget === 'compact' ? DEFAULT_CROP : compactCrop,
          })
        })
      }
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="island-panel-bg">
      <div className="island-panel-list-head">
        <span className="island-panel-list-count">自定义背景</span>
        {imageLibraryAvailable && (
          <button
            type="button"
            className="island-lib-link"
            onClick={(event) => {
              event.stopPropagation()
              onOpenImageLibrary()
            }}
          >
            {/* 图片库入口:图标 + 文字 + 数量徽标的中性胶囊 */}
            <svg
              className="island-lib-link-svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
            <span>图片库</span>
          </button>
        )}
      </div>
      {/* 分段切换始终可见:即使当前形态没有图片(刚被移除),也能切到
          另一形态继续管理其图片与裁切 */}
      <div
        className={`island-bg-seg${bgTarget === 'compact' ? ' island-bg-seg--compact' : ''}`}
        role="tablist"
        aria-label="裁切目标"
      >
        {/* 滑动指示条:随目标切换回弹平移 */}
        <span className="island-bg-seg-thumb" aria-hidden="true" />
        <button
          type="button"
          className={bgTarget === 'expanded' ? 'on' : ''}
          onClick={(event) => {
            event.stopPropagation()
            handleBgTargetChange('expanded')
          }}
        >
          展开态
        </button>
        <button
          type="button"
          className={bgTarget === 'compact' ? 'on' : ''}
          onClick={(event) => {
            event.stopPropagation()
            handleBgTargetChange('compact')
          }}
        >
          紧凑态
        </button>
      </div>
      {activeImage ? (
        <>
          {/* 裁切区:当前形态的蒙版视口(拖拽平移/滚轮缩放/双击复位) */}
          <div className="island-bg-crop">
            <div
              className={`island-bg-viewport${bgTarget === 'compact' ? ' island-bg-viewport--compact' : ''}`}
              onPointerDown={handleBgPanDown}
              onPointerMove={handleBgPanMove}
              onPointerUp={handleBgPanEnd}
              onPointerCancel={handleBgPanEnd}
              onWheel={handleBgWheel}
              onDoubleClick={handleBgDoubleClick}
              style={bgStyleFor(
                activeImage ?? '',
                bgTarget === 'expanded' ? bgSizeExpanded : bgSizeCompact,
                activeCrop.posX,
                activeCrop.posY,
              )}
            >
              {/* 切换前的旧图淡出层:与新图 crossfade,图片切换不生硬 */}
              {fadeSnapshot && (
                <span
                  className={`island-bg-viewport-fade${fadeOut ? ' out' : ''}`}
                  style={bgStyleFor(
                    fadeSnapshot.image,
                    fadeSnapshot.size,
                    fadeSnapshot.posX,
                    fadeSnapshot.posY,
                  )}
                  aria-hidden="true"
                />
              )}
              <span className="island-bg-mask-tag">
                {bgTarget === 'expanded' ? '展开态' : '紧凑态'}
              </span>
              <span className="island-bg-hint">拖拽平移 · 滚轮缩放 · 双击复位</span>
            </div>
          </div>
          <div className="island-bg-controls">
            <div className="island-bg-sliders">
              <label className="island-bg-slider">
                <span className="island-bg-opacity-row">
                  <span>缩放</span>
                  <span>{activeCrop.zoom.toFixed(1)}x</span>
                </span>
                <input
                  type="range"
                  min={100}
                  max={400}
                  value={Math.round(activeCrop.zoom * 100)}
                  onChange={(event) => {
                    event.stopPropagation()
                    patchActiveCrop({ zoom: Number(event.target.value) / 100 })
                  }}
                />
              </label>
              <label className="island-bg-slider">
                <span className="island-bg-opacity-row">
                  <span>不透明度</span>
                  {/* 当前编辑形态的不透明度(展开态 / 紧凑态各自独立) */}
                  <span>{Math.round(opacity[bgTarget] * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(opacity[bgTarget] * 100)}
                  onChange={(event) => {
                    event.stopPropagation()
                    // 只改当前编辑形态,另一形态的不透明度不受影响
                    onBackgroundChange({
                      expandedImage,
                      compactImage,
                      opacity: { ...opacity, [bgTarget]: Number(event.target.value) / 100 },
                      expanded: expandedCrop,
                      compact: compactCrop,
                    })
                  }}
                />
              </label>
            </div>
            <div className="island-bg-actions">
              <button
                type="button"
                className="island-ctl island-ctl--upload"
                onClick={(event) => {
                  event.stopPropagation()
                  bgFileInputRef.current?.click()
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
                <span>更换图片</span>
              </button>
              {/* 重置裁切:常驻渲染(条件卸载会瞬间弹出/消失且两侧按钮
                  瞬跳让位),仅切换 .on 类经 CSS 过渡平滑展开/收起 */}
              <button
                type="button"
                className={`island-ctl island-ctl--clear island-ctl--reset${activeCrop.zoom !== 1 || activeCrop.posX !== 50 || activeCrop.posY !== 50 ? ' on' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  patchActiveCrop({ zoom: 1, posX: 50, posY: 50 })
                }}
              >
                <svg
                  className="island-ctl-svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                <span>重置裁切</span>
              </button>
              <button
                type="button"
                className="island-ctl island-ctl--clear"
                onClick={(event) => {
                  event.stopPropagation()
                  // 移除当前形态的背景(另一形态不受影响)
                  onBackgroundChange({
                    expandedImage: bgTarget === 'expanded' ? null : expandedImage,
                    compactImage: bgTarget === 'compact' ? null : compactImage,
                    opacity,
                    expanded: bgTarget === 'expanded' ? DEFAULT_CROP : expandedCrop,
                    compact: bgTarget === 'compact' ? DEFAULT_CROP : compactCrop,
                  })
                }}
              >
                <svg
                  className="island-ctl-svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                <span>移除背景</span>
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="island-bg-empty">
          <p className="island-bg-empty-text">
            上传一张图片作为{bgTarget === 'expanded' ? '展开态' : '紧凑态'}背景,
            岛体将实时预览
          </p>
          <button
            type="button"
            className="island-ctl island-ctl--upload"
            onClick={(event) => {
              event.stopPropagation()
              bgFileInputRef.current?.click()
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
        </div>
      )}
      <BackFoot onBack={onBack} />
      {/* 背景图片上传(隐藏输入,由"上传图片"按钮触发) */}
      <input
        ref={bgFileInputRef}
        type="file"
        accept="image/*"
        hidden
        onClick={(event) => event.stopPropagation()}
        onChange={handleBackgroundFileChange}
      />
    </div>
  )
}

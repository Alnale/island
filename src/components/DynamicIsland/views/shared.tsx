import { useRef, type ChangeEvent } from 'react'
import {
  MAX_FONT_BYTES,
  genFontId,
  isSupportedFontFile,
  type FontLibraryItem,
} from '../../../media/fontStore'

/** 列表类视图头部:状态圆点 + 标题 + 右侧计数/说明 */
export function PanelHead({ title, count }: { title: string; count?: string }) {
  return (
    <div className="island-panel-list-head">
      <span className="island-panel-state">
        <span className="island-panel-state-dot" aria-hidden="true" />
        {title}
      </span>
      {count !== undefined && <span className="island-panel-list-count">{count}</span>}
    </div>
  )
}

/** 设置类视图统一的扁平返回键(占满整行、强调色描边) */
export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="island-bg-back"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
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
  )
}

/** 设置类视图脚注(BackButton 独占一行,贴底) */
export function BackFoot({ onBack }: { onBack: () => void }) {
  return (
    <div className="island-panel-list-foot island-bg-foot">
      <BackButton onClick={onBack} />
    </div>
  )
}

/**
 * 字体上传控件(按钮 + 隐藏输入一体;字体视图 / 字体库视图各放一个):
 * 校验扩展名/大小 → data URL → 查重后加入库并应用。
 * 已存在于库(同一 dataUrl)时直接应用已有条目,不重复添加;
 * 不合规/读取失败给出明确提示(不再静默)
 */
export function FontUploadControl({
  className,
  label,
  fontLibrary,
  onFontAdd,
  onFontSelect,
  onError,
}: {
  className?: string
  label: string
  fontLibrary?: FontLibraryItem[]
  onFontAdd?: (item: FontLibraryItem) => void
  onFontSelect?: (id: string | null) => void
  onError: (msg: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !onFontAdd) return
    if (!isSupportedFontFile(file.name)) {
      onError('不支持的文件格式')
      return
    }
    if (file.size > MAX_FONT_BYTES) {
      onError('文件过大(≤30MB)')
      return
    }
    const reader = new FileReader()
    reader.onerror = () => onError('读取文件失败,请重试')
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        onError('读取文件失败,请重试')
        return
      }
      const exist = fontLibrary?.find((f) => f.dataUrl === reader.result)
      if (exist) {
        onFontSelect?.(exist.id)
        return
      }
      onFontAdd({
        id: genFontId(),
        name: file.name.replace(/\.[^.]+$/, ''),
        dataUrl: reader.result,
        createdAt: Date.now(),
      })
    }
    reader.readAsDataURL(file)
  }
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={(event) => {
          event.stopPropagation()
          inputRef.current?.click()
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
        <span>{label}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2"
        hidden
        onClick={(event) => event.stopPropagation()}
        onChange={handleChange}
      />
    </>
  )
}


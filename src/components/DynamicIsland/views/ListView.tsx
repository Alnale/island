import { type RefObject } from 'react'
import type { TrackInfo } from '../../../data/islandStates'
import { formatTime } from '../../../utils/format'
import { PanelHead } from './shared'

export interface ListViewProps {
  playlist: TrackInfo[] | undefined
  playlistIndex: number | undefined
  onPlayTrack?: (index: number) => void
  onTogglePlay?: () => void
  onRemoveTrack?: (index: number) => void
  fileInputRef: RefObject<HTMLInputElement | null>
  onBack: () => void
}

/** 播放列表视图:曲目列表 + 上传音乐 */
export function ListView({
  playlist,
  playlistIndex,
  onPlayTrack,
  onTogglePlay,
  onRemoveTrack,
  fileInputRef,
  onBack,
}: ListViewProps) {
  return (
    <div className="island-panel-list">
      <PanelHead title="播放列表" count={`${playlist?.length ?? 0} 首`} />
      <ul className="island-panel-tracks">
        {(playlist ?? []).map((t, i) => (
          <li
            key={`${t.url ?? t.title}-${i}`}
            className={`island-track${i === playlistIndex ? ' active' : ''}`}
          >
            <button
              type="button"
              className="island-track-main"
              aria-label={`${i === playlistIndex ? '暂停/继续' : '播放'} ${t.title}`}
              onClick={(event) => {
                event.stopPropagation()
                // 单击当前曲目:播放/暂停切换;其他曲目:直接播放
                if (i === playlistIndex) onTogglePlay?.()
                else onPlayTrack?.(i)
              }}
            >
              <span className="island-track-index" aria-hidden="true">
                {i === playlistIndex ? '▶' : String(i + 1).padStart(2, '0')}
              </span>
              <span className="island-track-meta">
                <span className="island-track-title">{t.title}</span>
                <span className="island-track-artist">{t.artist}</span>
              </span>
              <span className="island-track-duration">
                {t.duration > 0 ? formatTime(t.duration) : ''}
              </span>
            </button>
            {t.source === 'uploaded' && onRemoveTrack && (
              <button
                type="button"
                className="island-track-remove"
                aria-label={`删除 ${t.title}`}
                title="删除"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemoveTrack(i)
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
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </li>
        ))}
        {(playlist ?? []).length === 0 && (
          <li className="island-track-empty">暂无曲目,点击下方上传音乐</li>
        )}
      </ul>
      <div className="island-panel-list-foot">
        <button
          type="button"
          className="island-ctl island-ctl--upload"
          onClick={(event) => {
            event.stopPropagation()
            fileInputRef.current?.click()
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
          <span>上传音乐</span>
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
    </div>
  )
}

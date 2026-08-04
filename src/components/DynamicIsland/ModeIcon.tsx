import type { PlaybackMode } from '../../media/playbackModes'

/**
 * 播放模式图标(顺序/单曲循环/随机):
 * 所有线条 pathLength=1 归一化,配合 CSS 的 stroke-dasharray 做
 * "旧线条擦除 → 新线条画出"的重组动画
 */
export function ModeIcon({ mode, className }: { mode: PlaybackMode; className?: string }) {
  const base = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const
  if (mode === 'repeat-one') {
    return (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" {...base}>
        <path pathLength={1} d="M17 2l4 4-4 4" />
        <path pathLength={1} d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path pathLength={1} d="M7 22l-4-4 4-4" />
        <path pathLength={1} d="M21 13v1a4 4 0 0 1-4 4H3" />
        <path pathLength={1} d="M11 10h1v4" />
      </svg>
    )
  }
  if (mode === 'shuffle') {
    return (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" {...base}>
        <polyline pathLength={1} points="16 3 21 3 21 8" />
        <line pathLength={1} x1="4" y1="20" x2="21" y2="3" />
        <polyline pathLength={1} points="21 16 21 21 16 21" />
        <line pathLength={1} x1="15" y1="15" x2="21" y2="21" />
        <line pathLength={1} x1="4" y1="4" x2="9" y2="9" />
      </svg>
    )
  }
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" {...base}>
      <polyline pathLength={1} points="17 1 21 5 17 9" />
      <path pathLength={1} d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline pathLength={1} points="7 23 3 19 7 15" />
      <path pathLength={1} d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  )
}

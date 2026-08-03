import type { ReactElement } from 'react'

export type IslandState = 'playing' | 'loading' | 'success' | 'warning' | 'error' | 'idle'

/** 歌曲信息(灵动岛 API 返回的媒体数据) */
export interface TrackInfo {
  /** 歌名 */
  title: string
  /** 歌手 */
  artist: string
  /** 总时长(秒) */
  duration: number
  /** 音频地址(组件由外部注入) */
  url?: string
  /** 曲目来源:内置 demo 曲目 / 用户上传(仅上传曲目可在播放列表删除) / 系统媒体(外部平台) */
  source?: 'builtin' | 'uploaded' | 'system'
  /** 上传曲目的 IndexedDB 存储 key(持久化,刷新后可恢复) */
  storageKey?: string
}

/**
 * 进度条形态:
 * - determinate: 确定进度,绑定 position/duration 后显示填充并支持拖动控制
 * - indeterminate: 不确定进度(扫光),如加载中
 * - none: 不需要进度条(成功/警告/错误等通知状态)
 */
export type IslandProgressMode = 'determinate' | 'indeterminate' | 'none'

export interface IslandStateConfig {
  /** 岛内右侧显示的文案 */
  text: string
  /** 状态中文名(按钮与状态栏展示) */
  label: string
  /** 状态主色(粒子效果/页面氛围色联动) */
  color: string
  /** 进度条形态:媒体状态才需要进度条,通知状态不需要 */
  progress: IslandProgressMode
  /** 左侧图标;key 变化时触发重挂载以重启动画 */
  icon: (key: string) => ReactElement
}

export const STATE_ORDER: readonly IslandState[] = [
  'playing',
  'loading',
  'success',
  'warning',
  'error',
  'idle',
]

export const ISLAND_STATES: Record<IslandState, IslandStateConfig> = {
  playing: {
    // 长文字,超出岛体宽度限制(500px),用于演示省略号截断与展开动画
    text: '正在播放: 来自远方山谷的一段悠长而温柔的纯音乐旋律,伴你入眠',
    label: '播放中',
    color: '#4ade80',
    progress: 'determinate',
    icon: (key) => (
      <svg
        key={key}
        className="island-svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    ),
  },
  loading: {
    // 省略号由组件内 .text-ellipsis 动态渲染
    text: '正在加载音频',
    label: '加载中',
    color: '#22d3ee',
    progress: 'indeterminate',
    icon: (key) => (
      <svg
        key={key}
        className="island-svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v6m0 6v6m11-7h-6m-6 0H1" />
      </svg>
    ),
  },
  success: {
    text: '音频加载成功',
    label: '成功',
    color: '#4ade80',
    progress: 'none',
    icon: (key) => (
      <svg
        key={key}
        className="island-svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <polyline points="20,6 9,17 4,12" />
      </svg>
    ),
  },
  warning: {
    text: '音频格式警告',
    label: '警告',
    color: '#f59e0b',
    progress: 'none',
    icon: (key) => (
      <svg
        key={key}
        className="island-svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
  },
  error: {
    text: '音频加载失败',
    label: '错误',
    color: '#ef4444',
    progress: 'none',
    icon: (key) => (
      <svg
        key={key}
        className="island-svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
  },
  idle: {
    text: '音频已暂停',
    label: '暂停',
    color: '#94a3b8',
    progress: 'determinate',
    icon: (key) => (
      <svg
        key={key}
        className="island-svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
      >
        {/* 暂停:两条圆角短竖条,与面板暂停键同一语言(细描边版),
           语义明确为"已暂停" */}
        <line x1="8" y1="5" x2="8" y2="19" />
        <line x1="16" y1="5" x2="16" y2="19" />
      </svg>
    ),
  },
}

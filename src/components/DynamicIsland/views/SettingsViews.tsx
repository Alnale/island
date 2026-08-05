import { useEffect, useRef, useState, type ReactNode, type WheelEvent } from 'react'
import {
  LYRIC_PROVIDERS,
  loadLyricAuto,
  loadLyricProvider,
  saveLyricAuto,
  saveLyricProvider,
  type LyricProvider,
} from '../../../media/lyricProviders'
import { useWheelSteps } from '../../../hooks/useWheelSteps'
import { BackFoot, PanelHead } from './shared'
import { WheelSwap } from './WheelSwap'

/** 帮助手册条目:简约线框图标 + 标题 + 一句话说明 */
interface HelpEntry {
  icon: ReactNode
  title: string
  desc: string
}

/** 简约线框图标统一属性(描边风格,currentColor 跟随) */
const HELP_ICON = {
  className: 'island-help-svg',
  width: 19,
  height: 19,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** 音乐模式手册(12 条:基本手势 + 面板控件 + 托盘) */
const MUSIC_HELP_ITEMS: HelpEntry[] = [
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M4 3l7 17 2.4-6.6L20 11z" />
      </svg>
    ),
    title: '悬停岛体',
    desc: '露出进度条,查看播放进度',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M12 4v10m0 0l-3.5-3.5M12 14l3.5-3.5" />
        <path d="M5 17v1a2 2 0 002 2h10a2 2 0 002-2v-1" />
      </svg>
    ),
    title: '长按岛体',
    desc: '展开控制面板',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M4 3l7 17 2.4-6.6L20 11z" />
        <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
    title: '单击岛体',
    desc: '收起面板,回到胶囊',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M5 8l4 4-4 4M12 8l4 4-4 4" />
      </svg>
    ),
    title: '双击文字',
    desc: '播放 / 暂停',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M8 3L4 7l4 4" />
        <path d="M4 7h16" />
        <path d="M16 21l4-4-4-4" />
        <path d="M20 17H4" />
      </svg>
    ),
    title: '左右滑动文字',
    desc: '上一首 / 下一首',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
        <circle cx="16" cy="8" r="2" />
        <circle cx="8" cy="16" r="2" />
      </svg>
    ),
    title: '拖动进度条',
    desc: '跳转播放位置,时间粒子反馈',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    ),
    title: '点击音乐图标',
    desc: '切换系统监听 / 本地播放器',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11v-1a4 4 0 014-4h14" />
        <path d="M7 22l-4-4 4-4" />
        <path d="M21 13v1a4 4 0 01-4 4H3" />
      </svg>
    ),
    title: '播放模式按钮',
    desc: '顺序 / 单曲循环 / 随机',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M5 9l-3 3 3 3M19 9l3 3-3 3M9 5l3-3 3 3M9 19l3 3 3-3" />
      </svg>
    ),
    title: '右键长按拖动',
    desc: '移动挂件位置',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <rect x="2" y="4" width="20" height="12" rx="2" />
        <path d="M2 16l4 4h12l4-4" />
        <path d="M10 12h4" />
      </svg>
    ),
    title: '托盘菜单',
    desc: '设置 / 置顶 / 开机自启 / 模式',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M4 6h16M4 12h16M4 18h10" />
      </svg>
    ),
    title: '歌词字幕',
    desc: '展开自动显示,当前句高亮',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5" />
        <path d="M4 20h16" />
      </svg>
    ),
    title: '上传音乐',
    desc: '空列表时直接上传本地音乐',
  },
]

/** Agent 模式手册(12 条:切换 / 对话 / 菜单 / 记忆与进化) */
const AGENT_HELP_ITEMS: HelpEntry[] = [
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" />
      </svg>
    ),
    title: '切换到 Agent',
    desc: '托盘 → 模式 → Agent 模式',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18" />
      </svg>
    ),
    title: '长按展开',
    desc: '打开对话面板',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" />
      </svg>
    ),
    title: '输入对话',
    desc: 'Enter 发送,Shift+Enter 换行',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    ),
    title: '停止生成',
    desc: '运行中按钮或 ⋯ 菜单',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <circle cx="5" cy="12" r="1.7" />
        <circle cx="12" cy="12" r="1.7" />
        <circle cx="19" cy="12" r="1.7" />
      </svg>
    ),
    title: '⋯ 菜单',
    desc: '新对话 / 历史 / 工具列表 / 收起',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <rect x="7" y="2" width="10" height="20" rx="5" />
        <path d="M12 6v4" />
      </svg>
    ),
    title: '快捷切换按钮',
    desc: '悬浮 ⋯ 左侧,滚轮切换入口',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <circle cx="12" cy="12" r="9" />
        <path d="M15 9.5a3.5 3.5 0 100 5" />
        <path d="M16 12v1.5a2.5 2.5 0 01-5 0V9" />
      </svg>
    ),
    title: '/技能 @MCP',
    desc: '手动调用技能与 MCP 工具',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M6 3h12v18l-6-4-6 4z" />
      </svg>
    ),
    title: '长期记忆',
    desc: '说「记住:…」自动沉淀',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      </svg>
    ),
    title: '自我进化',
    desc: '设置里运行记忆进化',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0z" />
        <path d="M12 18v4" />
      </svg>
    ),
    title: 'MCP 与技能',
    desc: '设置里接入服务与技能目录',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
        <path d="M11 8v6M8 11h6" />
      </svg>
    ),
    title: '界面放大',
    desc: 'Agent 设置,100%–300%',
  },
  {
    icon: (
      <svg {...HELP_ICON}>
        <path d="M19 12H5M11 18l-6-6 6-6" />
      </svg>
    ),
    title: '切回音乐',
    desc: '托盘 → 模式 → 音乐模式',
  },
]

/** 模式标签图标(左上角切换器) */
const HELP_TAB_ICONS: Record<'music' | 'agent', ReactNode> = {
  music: (
    <svg {...HELP_ICON}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ),
  agent: (
    <svg {...HELP_ICON}>
      <path d="M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" />
    </svg>
  ),
}

export interface SettingsViewProps {
  /** 宿主支持背景编辑时显示"自定义图片背景"入口 */
  onOpenBackground?: () => void
  onOpenHelp: () => void
  /** 宿主支持主题色时显示"主题色"入口 */
  onOpenTheme?: () => void
  /** 宿主支持字体时显示"字体"入口 */
  onOpenFont?: () => void
  /** 宿主支持 Agent 时显示"Agent 设置"入口 */
  onOpenAgent?: () => void
  /** 歌词 API 接入点(网易云/QQ音乐/自定义) */
  onOpenLyricApi: () => void
  /** 返回 = 收起岛体 */
  onBack: () => void
}

/** 设置视图(托盘菜单入口,岛内打开):设置类功能的总入口,
 *  自定义背景 / 帮助手册 / 主题色按宿主能力显隐 */
export function SettingsView({
  onOpenBackground,
  onOpenHelp,
  onOpenTheme,
  onOpenFont,
  onOpenAgent,
  onOpenLyricApi,
  onBack,
}: SettingsViewProps) {
  return (
    <div className="island-panel-list">
      <PanelHead title="设置" count="设置类功能" />
      <div className="island-settings-items">
        {onOpenBackground && (
          <button
            type="button"
            className="island-settings-item"
            onClick={(event) => {
              event.stopPropagation()
              onOpenBackground()
            }}
          >
            <svg
              className="island-ctl-svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <span>自定义图片背景</span>
          </button>
        )}
        <button
          type="button"
          className="island-settings-item"
          onClick={(event) => {
            event.stopPropagation()
            onOpenHelp()
          }}
        >
          <svg
            className="island-ctl-svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>帮助手册</span>
        </button>
        {onOpenTheme && (
          <button
            type="button"
            className="island-settings-item"
            onClick={(event) => {
              event.stopPropagation()
              onOpenTheme()
            }}
          >
            <svg
              className="island-ctl-svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22a10 10 0 1 1 10-10c0 1.4-.9 2.6-2.2 2.6H16a2.6 2.6 0 0 0 0 5.2H14a3.6 3.6 0 0 0-2 2.2" />
              <circle cx="7.5" cy="10.5" r="1.3" />
              <circle cx="11" cy="7" r="1.3" />
              <circle cx="15.5" cy="9" r="1.3" />
            </svg>
            <span>主题色</span>
          </button>
        )}
        {onOpenAgent && (
          <button
            type="button"
            className="island-settings-item"
            onClick={(event) => {
              event.stopPropagation()
              onOpenAgent()
            }}
          >
            <svg
              className="island-ctl-svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Agent 设置</span>
          </button>
        )}
        {onOpenFont && (
          <button
            type="button"
            className="island-settings-item"
            onClick={(event) => {
              event.stopPropagation()
              onOpenFont()
            }}
          >
            <svg
              className="island-ctl-svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 7 4 4 20 4 20 7" />
              <line x1="9" y1="20" x2="15" y2="20" />
              <line x1="12" y1="4" x2="12" y2="20" />
            </svg>
            <span>字体</span>
          </button>
        )}
        {/* 歌词 API 接入点(网易云/QQ音乐/自定义)——播放键下方提示显示厂商名 */}
        <button
          type="button"
          className="island-settings-item"
          onClick={(event) => {
            event.stopPropagation()
            onOpenLyricApi()
          }}
        >
          <svg
            className="island-ctl-svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <span>歌词 API</span>
        </button>
      </div>
      {/* 设置根菜单:返回 = 收起岛体(与三个子视图同款扁平返回键) */}
      <BackFoot onBack={onBack} />
    </div>
  )
}

export interface HelpViewProps {
  onBack: () => void
}

export interface LyricApiViewProps {
  onBack: () => void
}

/**
 * 歌词 API 接入点视图(设置视图"歌词 API"入口,设置类:只能返回键退出):
 * 预设厂家(网易云音乐 / QQ音乐)+ 自定义 URL 模板({title}/{artist} 占位)。
 * 选择后保存 localStorage(widget-lyric-provider),useLyrics 请求带 provider,
 * 桥接按厂商实现;打开歌词后播放键下方提示显示所选厂商名
 */
export function LyricApiView({ onBack }: LyricApiViewProps) {
  const [provider, setProvider] = useState<LyricProvider>(loadLyricProvider)
  // 自动切换开关(默认开启:按监听平台自动换对应厂商 API)
  const [auto, setAuto] = useState(loadLyricAuto)
  const [saved, setSaved] = useState(false)
  const savedTimerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(savedTimerRef.current), [])
  const toggleAuto = () => {
    const next = !auto
    setAuto(next)
    saveLyricAuto(next)
  }
  const selectProvider = (p: LyricProvider) => {
    // 切到预设:用预设配置;切到自定义:保留已填的 url
    setProvider(p.type === 'custom' ? { ...p, url: provider.url ?? '' } : { ...p })
    setSaved(false)
  }
  const save = () => {
    saveLyricProvider(provider)
    setSaved(true)
    window.clearTimeout(savedTimerRef.current)
    savedTimerRef.current = window.setTimeout(() => setSaved(false), 2000)
  }
  return (
    <div className="island-panel-list">
      <PanelHead title="歌词 API" count="歌词来源厂商" />
      <div className="island-lyric-api">
        <div className="island-lyric-presets">
          {LYRIC_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`island-lyric-provider${provider.id === p.id ? ' on' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                selectProvider(p)
              }}
            >
              <span className="island-lyric-provider-name">{p.name}</span>
              <span className="island-lyric-provider-desc">
                {p.type === 'custom' ? '自定义 URL 模板' : '预设歌词接口'}
              </span>
            </button>
          ))}
        </div>
        {provider.type === 'custom' ? (
          <label className="island-agent-field">
            <span>自定义 URL 模板({'{title}'} / {'{artist}'} 占位替换)</span>
            <input
              type="text"
              value={provider.url ?? ''}
              placeholder="https://example.com/lyric?title={title}&artist={artist}"
              spellCheck={false}
              onChange={(event) => setProvider((p) => ({ ...p, url: event.target.value }))}
            />
          </label>
        ) : null}
        {/* 自动切换开关:默认开启——按监听平台自动换对应厂商 API;
            关闭后一直按手动选择生效 */}
        <button
          type="button"
          role="switch"
          aria-checked={auto}
          className={`island-toggle${auto ? ' on' : ''}`}
          onClick={(event) => {
            event.stopPropagation()
            toggleAuto()
          }}
        >
          <span className="island-toggle-track" aria-hidden="true">
            <span className="island-toggle-knob" />
          </span>
          <span className="island-toggle-label">
            自动根据监听平台切换厂商{auto ? '(开)' : '(关)'}
          </span>
        </button>
        <span className="island-lyric-hint">
          开启:监听 QQ音乐/网易云/酷狗/酷我时自动用对应厂商歌词;
          关闭:一直按手动选择生效(切换即时刷新当前歌曲)
        </span>
        <div className="island-agent-form-foot">
          <button
            type="button"
            className="island-ctl island-ctl--upload"
            onClick={(event) => {
              event.stopPropagation()
              save()
            }}
          >
            <span>保存歌词 API</span>
          </button>
          <span className="island-agent-saved">{saved ? '已保存 ✓' : ''}</span>
        </div>
      </div>
      <BackFoot onBack={onBack} />
    </div>
  )
}

/**
 * 帮助手册视图(托盘菜单入口 / 初次安装自动打开,岛内显示):
 * - **大尺寸承载教学内容**(200% 缩放的大小,岛体 800×640,窗口跟随);
 * - **左上角模式标签**:点击或滚轮切换「音乐模式 / Agent 模式」两种手册
 *   (共用 useWheelSteps,逐格循环切换,每格手册内容重放淡入动画);
 * - **教学布局**:简约线框图标 + 标题 + 一句话说明,双列卡片网格。
 */
export function HelpView({ onBack }: HelpViewProps) {
  const [manual, setManual] = useState<'music' | 'agent'>('music')
  // 切换前的手册与方向(WheelSwap 旧内容滑出/新内容回弹滑入)
  const [prevManual, setPrevManual] = useState<'music' | 'agent' | null>(null)
  const [dir, setDir] = useState<1 | -1>(1)
  // 滚轮每格 +1:重挂载手册网格重放淡入动画
  const [tick, setTick] = useState(0)
  const wheelSteps = useWheelSteps()
  const switchManual = (next: 'music' | 'agent', d: 1 | -1 = 1) => {
    if (next === manual) return
    setPrevManual(manual)
    setDir(d)
    setTick((t) => t + 1)
    setManual(next)
  }
  // 滚轮切换(在整合按钮上滚动:逐格循环切换,上下滚同效)
  const handleManualWheel = (event: WheelEvent<HTMLDivElement>) => {
    const step = wheelSteps(event)
    if (!step) return
    switchManual(manual === 'music' ? 'agent' : 'music', step)
  }
  const entries = manual === 'music' ? MUSIC_HELP_ITEMS : AGENT_HELP_ITEMS
  // 模式按钮内容(图标 + 名称):WheelSwap 旧/新两层共用
  const manualNode = (m: 'music' | 'agent') => (
    <>
      <span className="island-help-mode-icon" aria-hidden="true">
        {HELP_TAB_ICONS[m]}
      </span>
      <span>{m === 'music' ? '音乐模式' : 'Agent 模式'}</span>
    </>
  )
  return (
    <div className="island-panel-list island-help-view">
      <PanelHead title="帮助手册" count={manual === 'music' ? '音乐模式' : 'Agent 模式'} />
      {/* 左上角模式切换:**整合为单个按钮**——点击切换 / 滚轮逐格循环
          切换,内容经 WheelSwap 交换动画(与快捷按钮同款) */}
      <div className="island-help-tabs" onWheel={handleManualWheel}>
        <button
          type="button"
          className="island-help-mode"
          title="点击或滚轮切换"
          onClick={(event) => {
            event.stopPropagation()
            switchManual(manual === 'music' ? 'agent' : 'music')
          }}
        >
          <WheelSwap tick={tick} dir={dir} prev={prevManual ? manualNode(prevManual) : null}>
            {manualNode(manual)}
          </WheelSwap>
        </button>
        <span className="island-help-tab-hint" aria-hidden="true">
          滚轮切换
        </span>
      </div>
      {/* 教学卡片网格:简约图标 + 标题 + 说明;每格切换重放淡入 */}
      <div key={tick} className="island-help-grid">
        {entries.map((item) => (
          <div key={item.title} className="island-help-card">
            <span className="island-help-card-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="island-help-card-meta">
              <span className="island-help-card-title">{item.title}</span>
              <span className="island-help-card-desc">{item.desc}</span>
            </span>
          </div>
        ))}
      </div>
      <BackFoot onBack={onBack} />
    </div>
  )
}

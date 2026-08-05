import { BackFoot, PanelHead } from './shared'

/** 帮助手册条目(设置视图"帮助手册"入口,岛内显示):操作姿势 + 作用 */
const HELP_ITEMS: Array<{ title: string; desc: string }> = [
  { title: '双击歌名', desc: '播放 / 暂停切换' },
  { title: '左右滑动歌名', desc: '切换上一首 / 下一首' },
  { title: '长按岛体', desc: '展开控制面板' },
  { title: '悬停岛体', desc: '显示播放进度条' },
  { title: '面板进度条', desc: '点击或拖动跳转进度' },
  { title: '面板模式按钮', desc: '顺序 / 单曲 / 随机循环' },
  { title: '点击音乐图标', desc: '切换本地播放 / 系统监听' },
  { title: '右键长按拖动', desc: '移动挂件位置' },
  { title: '托盘菜单', desc: '自定义背景 / 置顶 / 开机自启' },
]

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
      </div>
      {/* 设置根菜单:返回 = 收起岛体(与三个子视图同款扁平返回键) */}
      <BackFoot onBack={onBack} />
    </div>
  )
}

export interface HelpViewProps {
  onBack: () => void
}

/** 帮助手册视图(托盘菜单入口,岛内打开):操作引导列表,
 *  复用播放列表的容器/头部/底部样式 */
export function HelpView({ onBack }: HelpViewProps) {
  return (
    <div className="island-panel-list">
      <PanelHead title="帮助手册" count="操作引导" />
      <ul className="island-help-items">
        {HELP_ITEMS.map((item, i) => (
          <li key={item.title} className="island-help-item">
            <span className="island-help-index" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className="island-help-meta">
              <span className="island-help-title">{item.title}</span>
              <span className="island-help-desc">{item.desc}</span>
            </span>
          </li>
        ))}
      </ul>
      <BackFoot onBack={onBack} />
    </div>
  )
}

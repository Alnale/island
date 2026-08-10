import { useEffect, useRef, useState } from 'react'
import {
  LYRIC_PROVIDERS,
  loadLyricAuto,
  loadLyricProvider,
  saveLyricAuto,
  saveLyricProvider,
  type LyricProvider,
} from '../../../media/lyricProviders'
import { BackFoot, PanelHead } from './shared'



export interface SettingsViewProps {
  /** 宿主支持背景编辑时显示"自定义图片背景"入口 */
  onOpenBackground?: () => void
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
 *  自定义背景 / 主题色 / 字体按宿主能力显隐。
 *  帮助手册入口已移除(2026-08-10 用户要求);多媒体库入口已移除
 *  (2026-08-08 用户要求:独立菜单,不属设置范畴,入口在托盘菜单与
 *  Agent 对话 ⋯ 菜单) */
export function SettingsView({
  onOpenBackground,
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
          {/* 保存歌词 API(2026-08-07 用户要求:复用保存配置同款——按钮
              内联"已保存",无绿勾气泡;key 变化重挂载重放 island-ui-in
              回弹淡入,2.2s 后平滑恢复) */}
          <button
            type="button"
            className={`island-ctl island-ctl--upload island-save-btn${saved ? ' saved' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              save()
            }}
          >
            <span key={saved ? 'saved' : 'save'} className={`island-save-label${saved ? ' saved' : ''}`}>
              {saved ? '已保存' : '保存歌词 API'}
            </span>
          </button>
        </div>
      </div>
      <BackFoot onBack={onBack} />
    </div>
  )
}


/**
 * Agent 设置视图(设置视图"Agent 设置"入口,设置类视图:只能经返回键退出)
 *
 * 字段:API Key / Base URL / 模型 / 系统提示词。
 * 保存经 onSave 走主进程 settings.json(agent 段),保存后短暂显示"已保存"。
 * 配置加载是异步的(config 为 null 时表单保持占位,到达后填充)。
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentConfig } from '../../../agent/types'
import { BackFoot, PanelHead } from './shared'

export interface AgentSettingsViewProps {
  config: AgentConfig | null
  onSave: (patch: Partial<AgentConfig>) => void
  /** 界面缩放(百分比 100-300,最低 100%) */
  scale: number
  onScaleChange: (scale: number) => void
  onBack: () => void
}

export function AgentSettingsView({ config, onSave, scale, onScaleChange, onBack }: AgentSettingsViewProps) {
  const [form, setForm] = useState({
    apiKey: '',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    systemPrompt: '',
    reasoningEffort: 'high',
  })
  const [saved, setSaved] = useState(false)
  const savedTimerRef = useRef(0)
  // 自定义缩放输入草稿(失焦/回车提交,避免输入过程中被钳制打断)
  const [draftScale, setDraftScale] = useState(String(scale))
  useEffect(() => setDraftScale(String(scale)), [scale])
  const commitScale = () => {
    const v = Number(draftScale)
    const clamped = Number.isFinite(v) ? Math.min(300, Math.max(100, Math.round(v))) : scale
    setDraftScale(String(clamped))
    onScaleChange(clamped)
  }
  const handleScaleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commitScale()
  }
  // 配置到达后填充表单(config 未变时不覆盖用户正在编辑的内容)
  useEffect(() => {
    if (config) {
      setForm({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model,
        systemPrompt: config.systemPrompt,
        reasoningEffort: config.reasoningEffort || 'high',
      })
    }
  }, [config])

  const save = () => {
    onSave({ ...form })
    setSaved(true)
    window.clearTimeout(savedTimerRef.current)
    savedTimerRef.current = window.setTimeout(() => setSaved(false), 2000)
  }
  // 卸载时清理保存提示计时器
  useEffect(() => () => window.clearTimeout(savedTimerRef.current), [])

  // Provider 自动判定(与引擎 detectProvider 同规则):地址含 anthropic
  // → Anthropic Messages 协议;否则 DeepSeek Responses 协议
  const protocol = form.baseURL.toLowerCase().includes('anthropic')
    ? 'Anthropic Messages'
    : 'DeepSeek Responses'

  return (
    <div className="island-panel-list island-agent-settings">
      <PanelHead title="Agent 设置" count={protocol} />
      <div className="island-agent-protocol">
        {protocol === 'Anthropic Messages'
          ? 'Anthropic 协议:填写含 anthropic 的地址自动切换(如 https://api.deepseek.com/anthropic,模型填 deepseek-chat 等)'
          : 'Responses 协议:默认 DeepSeek 端点(模型 deepseek-v4-flash)'}
      </div>
      <div className="island-agent-form">
        <label className="island-agent-field">
          <span>API Key</span>
          <input
            type="text"
            value={form.apiKey}
            placeholder="sk-…(DeepSeek 平台创建)"
            spellCheck={false}
            onChange={(event) => setForm((f) => ({ ...f, apiKey: event.target.value }))}
          />
        </label>
        <label className="island-agent-field">
          <span>Base URL</span>
          <input
            type="text"
            value={form.baseURL}
            spellCheck={false}
            onChange={(event) => setForm((f) => ({ ...f, baseURL: event.target.value }))}
          />
        </label>
        <label className="island-agent-field">
          <span>模型</span>
          <input
            type="text"
            value={form.model}
            spellCheck={false}
            onChange={(event) => setForm((f) => ({ ...f, model: event.target.value }))}
          />
        </label>
        <label className="island-agent-field island-agent-field--grow">
          <span>系统提示词</span>
          <textarea
            value={form.systemPrompt}
            rows={3}
            onChange={(event) => setForm((f) => ({ ...f, systemPrompt: event.target.value }))}
          />
        </label>
        <div className="island-agent-field">
          <span>思考强度(深度思考 vs 速度)</span>
          <div className="island-agent-scale-row">
            {(
              [
                ['low', '低(快)'],
                ['medium', '中'],
                ['high', '高(深)'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={`island-agent-scale-btn${form.reasoningEffort === v ? ' on' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  setForm((f) => ({ ...f, reasoningEffort: v }))
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="island-agent-field">
          <span>界面放大(仅面板尺寸,文字按钮不变)</span>
          <div className="island-agent-scale-row">
            {[100, 150, 200].map((v) => (
              <button
                key={v}
                type="button"
                className={`island-agent-scale-btn${scale === v ? ' on' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onScaleChange(v)
                }}
              >
                {v}%
              </button>
            ))}
            <input
              type="number"
              min={100}
              max={300}
              value={draftScale}
              spellCheck={false}
              onChange={(event) => setDraftScale(event.target.value)}
              onBlur={commitScale}
              onKeyDown={handleScaleKeyDown}
            />
            <span className="island-agent-scale-hint">%</span>
          </div>
        </div>
      </div>
      <div className="island-agent-form-foot">
        <button
          type="button"
          className="island-ctl island-ctl--upload"
          onClick={(event) => {
            event.stopPropagation()
            save()
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
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          <span>保存配置</span>
        </button>
        <span className="island-agent-saved">{saved ? '已保存 ✓' : ''}</span>
      </div>
      <BackFoot onBack={onBack} />
    </div>
  )
}

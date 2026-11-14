export interface DataManagementSettingsProps {
  confirming: 'app' | 'tools' | null
  message: string
  onRequestClear: (scope: 'app' | 'tools') => void
  sessionLog?: { enabled: boolean; bytes: number; files: string[] }
  onToggleSessionLog?: (enabled: boolean) => void
  onClearSessionLog?: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 危险数据操作独立呈现，确认和 IPC 副作用仍由设置容器集中管理。 */
export function DataManagementSettings({
  confirming,
  message,
  onRequestClear,
  sessionLog,
  onToggleSessionLog,
  onClearSessionLog,
}: DataManagementSettingsProps) {
  const failed = message.startsWith('清除失败')
  return (
    <>
      <div className="island-agent-section">
        <span className="island-agent-section-title">恢复出厂设置</span>
        <span className="island-agent-section-hint">
          将删除全部配置、API Key、主人身份、对话、记忆、媒体库和本地审计日志。应用将自动重启，此操作不可恢复。
        </span>
        <div className="island-agent-scale-row">
          <button
            type="button"
            className={`island-agent-scale-btn island-data-clear${confirming === 'app' ? ' confirming' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              onRequestClear('app')
            }}
          >
            {confirming === 'app' ? '再次点击确认恢复出厂设置' : '恢复出厂设置'}
          </button>
        </div>
      </div>
      <div className="island-agent-section">
        <span className="island-agent-section-title">清除工具数据</span>
        <span className="island-agent-section-hint">
          仅清理下载、登录态、截图和工具临时文件，不会删除工具程序本体，也不影响灵动岛配置与对话。
        </span>
        <div className="island-agent-scale-row">
          <button
            type="button"
            className={`island-agent-scale-btn island-data-clear${confirming === 'tools' ? ' confirming' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              onRequestClear('tools')
            }}
          >
            {confirming === 'tools' ? '再次点击确认清除' : '清除工具数据'}
          </button>
        </div>
      </div>
      <div className="island-agent-section">
        <span className="island-agent-section-title">本地审计日志</span>
        <span className="island-agent-section-hint">
          日志可能包含对话和模型可见上下文，仅保存在本机。关闭后改走有界内存，退出即丢弃。
        </span>
        <span className="island-agent-section-hint">
          当前占用 {formatBytes(sessionLog?.bytes ?? 0)}
          {sessionLog?.files?.length ? `（${sessionLog.files.length} 个文件）` : ''}
        </span>
        <div className="island-agent-scale-row">
          <button
            type="button"
            className="island-agent-scale-btn"
            onClick={(event) => {
              event.stopPropagation()
              onToggleSessionLog?.(!(sessionLog?.enabled !== false))
            }}
          >
            {sessionLog?.enabled === false ? '已关闭本地审计' : '本地审计日志：开'}
          </button>
          <button
            type="button"
            className="island-agent-scale-btn"
            onClick={(event) => {
              event.stopPropagation()
              onClearSessionLog?.()
            }}
          >
            清除审计日志
          </button>
        </div>
      </div>
      {message ? (
        <span className={`island-mcp-test-result ${failed ? 'fail' : 'ok'} island-ui-enter`}>
          {message}
        </span>
      ) : null}
    </>
  )
}

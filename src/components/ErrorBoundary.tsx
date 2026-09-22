import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  title?: string
  /** 局部边界可提供不离开当前应用的恢复界面。 */
  fallback?: (actions: { retry: () => void }) => ReactNode
}

interface ErrorBoundaryState {
  failed: boolean
}

/** 渲染异常隔离：不记录消息内容或凭据，只提供本地恢复入口。 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const code = error.name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'RenderError'
    console.error('[ui-boundary]', {
      code,
      componentStack: String(info.componentStack ?? '').slice(0, 1000),
      version: import.meta.env.VITE_APP_VERSION ?? 'development',
    })
  }

  private retry = () => this.setState({ failed: false })

  render() {
    if (!this.state.failed) return this.props.children
    if (this.props.fallback) return this.props.fallback({ retry: this.retry })
    return (
      <main role="alert" style={{ padding: 20, color: '#fff', fontFamily: 'system-ui, sans-serif' }}>
        <p>{this.props.title ?? '界面发生异常'}</p>
        <button type="button" onClick={() => window.location.reload()}>重新加载界面</button>
      </main>
    )
  }
}

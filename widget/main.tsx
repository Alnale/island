import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './widget.css'
import WidgetApp from './WidgetApp'
import { ErrorBoundary } from '../src/components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary title="灵动岛界面发生异常">
      <WidgetApp />
    </ErrorBoundary>
  </StrictMode>,
)

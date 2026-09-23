import React from 'react'
import { t } from '../utils/i18n'

interface State { error: Error | null }

/// The last thing between a render error and a blank white page.
///
/// A component that throws unmounts the whole tree in React 18, and what a
/// person sees is nothing: no message, no button, and no way to know whether
/// the app is broken or still loading. This catches it, says so in their
/// language, and offers the one recovery that always works.
export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Uncaught render error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="screen crashed" role="alert">
        <div className="screen-body welcome-body">
          <h1 className="display" style={{ fontSize: 28 }}>{t('Something went wrong.')}</h1>
          <p className="lede">{t('crash.body')}</p>
          <details className="crash-detail">
            <summary>{t('Details')}</summary>
            <pre>{String(this.state.error?.stack || this.state.error)}</pre>
          </details>
        </div>
        <div className="screen-foot bare">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>{t('Reload')}</button>
        </div>
      </div>
    )
  }
}

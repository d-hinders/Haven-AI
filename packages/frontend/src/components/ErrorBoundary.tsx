'use client'

import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Haven] Uncaught render error:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center">
            {/* Alert icon */}
            <div className="w-12 h-12 rounded-xl bg-[var(--v2-danger-soft)] border border-[var(--v2-danger)]/20 flex items-center justify-center mx-auto mb-5">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--v2-danger)]">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008v.008H12v-.008zM21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" />
              </svg>
            </div>

            <h1 className="text-base font-semibold text-[var(--v2-ink)] mb-2">
              Something went wrong
            </h1>
            <p className="text-sm text-[var(--v2-ink-2)] leading-relaxed mb-5">
              An unexpected error occurred. Refreshing the page usually resolves it.
            </p>

            {this.state.error && (
              <details className="text-left mb-5 group">
                <summary className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] cursor-pointer select-none inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 rounded">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transition-transform group-open:rotate-90">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                  Show technical details
                </summary>
                <pre className="mt-2 text-xs text-[var(--v2-danger)] bg-[var(--v2-danger-soft)] border border-[var(--v2-danger)]/20 rounded-lg p-3 overflow-auto max-h-32 font-mono">
                  {this.state.error.message}
                </pre>
              </details>
            )}

            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-md bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-colors shadow-[var(--v2-shadow-button)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
            >
              Refresh page
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

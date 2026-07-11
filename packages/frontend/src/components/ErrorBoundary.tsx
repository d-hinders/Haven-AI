'use client'

import { ChevronRight, CircleAlert } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
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
              <Icon icon={CircleAlert} className="h-[22px] w-[22px] text-[var(--v2-danger)]" />
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
                  <Icon icon={ChevronRight} className="h-2.5 w-2.5 transition-transform group-open:rotate-90" />
                  Show technical details
                </summary>
                <pre className="mt-2 text-xs text-[var(--v2-danger)] bg-[var(--v2-danger-soft)] border border-[var(--v2-danger)]/20 rounded-lg p-3 overflow-auto max-h-32 font-mono">
                  {this.state.error.message}
                </pre>
              </details>
            )}

            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-md bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-colors shadow-[var(--v2-shadow-button)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
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

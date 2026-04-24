'use client'

import { useState, useEffect, useCallback } from 'react'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'

// ── Shared visual components ──────────────────────────────────────

export function DiagramBox({
  label,
  sub,
  accent = false,
  className = '',
}: {
  label: string
  sub?: string
  accent?: boolean
  className?: string
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-center ${
        accent
          ? 'border-indigo-500/30 bg-indigo-500/[0.06]'
          : 'border-white/[0.08] bg-white/[0.03]'
      } ${className}`}
    >
      <p className={`text-xs font-medium ${accent ? 'text-indigo-300' : 'text-zinc-300'}`}>
        {label}
      </p>
      {sub && <p className="text-[10px] text-zinc-600 mt-0.5">{sub}</p>}
    </div>
  )
}

export function Arrow({ direction = 'down' }: { direction?: 'down' | 'right' }) {
  if (direction === 'right') {
    return (
      <div className="flex items-center justify-center px-1">
        <svg width="20" height="12" viewBox="0 0 20 12" fill="none" className="text-zinc-700">
          <path d="M0 6h16M12 1l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-center py-1">
      <svg width="12" height="20" viewBox="0 0 12 20" fill="none" className="text-zinc-700">
        <path d="M6 0v16M1 12l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block text-[10px] font-medium uppercase tracking-wider text-indigo-400 bg-indigo-500/10 rounded px-1.5 py-0.5">
      {children}
    </span>
  )
}

// ── Page type ─────────────────────────────────────────────────────

export interface InfoPage {
  title: string
  subtitle: string
  content: React.ReactNode
}

// ── Modal component ───────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  pages: InfoPage[]
}

export default function InfoModal({ open, onClose, pages }: Props) {
  const [page, setPage] = useState(0)

  const handleClose = useCallback(() => {
    setPage(0)
    onClose()
  }, [onClose])

  // Reset page when opening
  useEffect(() => {
    if (open) setPage(0)
  }, [open])

  useEscapeToClose(open, handleClose)

  if (!open || pages.length === 0) return null

  const current = pages[page]
  const isFirst = page === 0
  const isLast = page === pages.length - 1

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0e0e0e] border border-white/[0.08] rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/[0.06] flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-zinc-200">{current.title}</h2>
            <p className="text-xs text-zinc-600 mt-0.5">{current.subtitle}</p>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="p-1 -mr-1 rounded-md text-zinc-700 hover:text-zinc-400 hover:bg-white/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Page dots */}
        {pages.length > 1 && (
          <div className="flex items-center justify-center gap-1.5 px-6 py-3 border-b border-white/[0.04] flex-shrink-0">
            {pages.map((_, i) => (
              <button
                key={i}
                onClick={() => setPage(i)}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  i === page
                    ? 'w-6 bg-indigo-500'
                    : 'w-1.5 bg-white/[0.1] hover:bg-white/[0.2]'
                }`}
              />
            ))}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {current.content}
        </div>

        {/* Navigation */}
        {pages.length > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-white/[0.06] flex-shrink-0">
            <button
              onClick={() => setPage((p) => p - 1)}
              disabled={isFirst}
              className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-0 disabled:cursor-default transition-colors flex items-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Previous
            </button>

            <span className="text-[10px] text-zinc-700">
              {page + 1} / {pages.length}
            </span>

            {isLast ? (
              <button
                onClick={handleClose}
                className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                Done
              </button>
            ) : (
              <button
                onClick={() => setPage((p) => p + 1)}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
              >
                Next
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

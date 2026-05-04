'use client'

import { useEffect, useRef } from 'react'

export interface ConfirmDialogProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void | Promise<void>
  title: string
  /** Body copy. String is rendered as a paragraph; pass JSX for richer content. */
  body: React.ReactNode
  /** Primary button label. Use the action verb, e.g. "Revoke agent". */
  confirmLabel: string
  cancelLabel?: string
  /** Visual emphasis for the primary button. Defaults to "danger". */
  tone?: 'danger' | 'primary'
  /** Disable the confirm button (e.g. while the confirm action is running). */
  loading?: boolean
}

/**
 * Styled confirmation dialog. Replaces browser-native `window.confirm`
 * for any destructive action (revoke, remove, delete, reject).
 *
 * Rules:
 *  • Title states the action as a question: "Revoke this agent?"
 *  • Body states the consequence in plain language + whether it is reversible.
 *  • Primary button is red for danger, labels the action verb (not "Confirm").
 *  • Escape = cancel. Backdrop click = cancel.
 */
export default function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  loading = false,
}: ConfirmDialogProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  // Escape-to-cancel + focus the confirm button on open.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel()
    }
    document.addEventListener('keydown', handler)
    // Focus the confirm button so Enter submits.
    confirmBtnRef.current?.focus()
    return () => document.removeEventListener('keydown', handler)
  }, [open, loading, onCancel])

  if (!open) return null

  const primaryClasses =
    tone === 'danger'
      ? 'bg-red-500 hover:bg-red-400 text-white shadow-lg shadow-red-500/20'
      : 'bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500 text-white shadow-lg shadow-indigo-500/20'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={loading ? undefined : onCancel}
      />

      {/* Dialog */}
      <div className="relative w-full max-w-sm bg-[#111113] border border-white/[0.08] rounded-xl shadow-2xl shadow-black/40 overflow-hidden">
        <div className="p-6">
          <h2 id="confirm-title" className="text-base font-semibold text-zinc-100 mb-2">
            {title}
          </h2>
          {typeof body === 'string' ? (
            <p className="text-sm text-zinc-400 leading-relaxed">{body}</p>
          ) : (
            <div className="text-sm text-zinc-400 leading-relaxed">{body}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 bg-white/[0.02] border-t border-white/[0.04]">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 rounded-md text-sm text-zinc-300 hover:bg-white/[0.04] disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={() => void onConfirm()}
            disabled={loading}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 ${primaryClasses}`}
          >
            {loading ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

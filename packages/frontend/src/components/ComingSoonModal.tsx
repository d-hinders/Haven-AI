'use client'

import { useEscapeToClose } from '@/hooks/useEscapeToClose'

interface Props {
  open: boolean
  onClose: () => void
}

export default function ComingSoonModal({ open, onClose }: Props) {
  useEscapeToClose(open, onClose)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-[var(--v2-ink)]/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 rounded-xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)] overflow-hidden">
        <div className="px-6 py-6">
          <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-[var(--v2-brand)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-[var(--v2-ink)]">Add funds is coming soon</h2>
          <p className="text-sm text-[var(--v2-ink-3)] mt-2 leading-relaxed">
            Fiat on-ramp support will let you fund Haven directly. For now, use Receive to copy an account address and send supported tokens on-chain.
          </p>
          <button
            onClick={onClose}
            className="mt-6 w-full rounded-lg bg-[var(--v2-brand)] px-4 py-3 text-sm font-medium text-white hover:bg-[var(--v2-brand-strong)] transition-colors shadow-[var(--v2-shadow-button)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

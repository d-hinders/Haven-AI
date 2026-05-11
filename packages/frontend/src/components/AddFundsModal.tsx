'use client'

import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { Button } from '@/components/ui/Button'

interface Props {
  open: boolean
  onClose: () => void
}

export default function AddFundsModal({ open, onClose }: Props) {
  useEscapeToClose(open, onClose)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div
        className="absolute inset-0 v2-modal-backdrop"
        onClick={onClose}
      />

      <div className="relative mx-4 w-full max-w-md overflow-hidden rounded-xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--v2-border)] px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--v2-ink)]">Add funds</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Fiat on-ramp support is planned after the POC.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded-md p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[10px] border border-[var(--v2-brand)]/20 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v18" />
              <path d="M17 8H9.5a2.5 2.5 0 0 0 0 5H14.5a2.5 2.5 0 0 1 0 5H7" />
            </svg>
          </div>
          <p className="mb-2 text-base font-semibold text-[var(--v2-ink)]">
            Guided funding is coming soon
          </p>
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-[var(--v2-ink-3)]">
            For now, use Receive to copy a Haven wallet address and send supported tokens on-chain.
          </p>
          <Button
            type="button"
            onClick={onClose}
            className="mt-6"
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}

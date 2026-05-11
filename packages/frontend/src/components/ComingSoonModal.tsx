'use client'

import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { Button } from '@/components/ui/Button'

interface Props {
  open: boolean
  onClose: () => void
  onReceive?: () => void
}

export default function ComingSoonModal({ open, onClose, onReceive }: Props) {
  useEscapeToClose(open, onClose)

  if (!open) return null

  function handleReceiveInstead() {
    onClose()
    onReceive?.()
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} />
      <div className="relative mx-4 w-full max-w-md overflow-hidden rounded-xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]">
        <div className="border-b border-[var(--v2-border)] px-6 py-4">
          <h2 className="text-base font-semibold text-[var(--v2-ink)]">Add funds is coming soon</h2>
          <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
            A guided fiat on-ramp is planned after the POC.
          </p>
        </div>

        <div className="px-6 py-6">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[10px] border border-[var(--v2-brand)]/20 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
            </svg>
          </div>
          <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
            For now, use Receive to copy the correct Haven wallet address and send supported tokens on-chain.
          </p>
          <div className="mt-6 flex gap-3">
            {onReceive && (
              <Button variant="ghost" onClick={handleReceiveInstead} className="flex-1">
                Receive instead
              </Button>
            )}
            <Button onClick={onClose} className="flex-1">
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

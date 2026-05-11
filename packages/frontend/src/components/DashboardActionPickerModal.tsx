'use client'

import { getChainConfig } from '@/lib/chains'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import type { UserSafe } from '@/context/AuthContext'

interface Props {
  open: boolean
  action: 'send' | 'receive'
  safes: UserSafe[]
  onClose: () => void
  onSelect: (safeId: string) => void
}

export default function DashboardActionPickerModal({
  open,
  action,
  safes,
  onClose,
  onSelect,
}: Props) {
  useEscapeToClose(open, onClose)

  if (!open) return null

  const title = action === 'send' ? 'Choose account to send from' : 'Choose account to receive into'

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 rounded-xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--v2-border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--v2-ink)]">{title}</h2>
            <p className="text-xs text-[var(--v2-ink-3)] mt-1">Money actions stay explicit when you have multiple accounts.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-2">
          {safes.map((safe) => (
            <button
              key={safe.id}
              onClick={() => onSelect(safe.id)}
              className="w-full rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 text-left transition-colors hover:border-[var(--v2-brand)]/30 hover:bg-[var(--v2-brand-soft)]"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--v2-ink)] truncate">{safe.name}</span>
                    {safe.is_default && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]">
                        Default
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--v2-ink-3)] mt-1">
                    {getChainConfig(safe.chain_id).name}
                  </p>
                </div>
                <svg className="w-4 h-4 text-[var(--v2-ink-3)] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

'use client'

import { useEscapeToClose } from '@/hooks/useEscapeToClose'

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
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-md mx-4 bg-[#111113] border border-white/[0.08] rounded-2xl shadow-2xl shadow-black/40 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <h2 className="text-base font-semibold text-[#ededed]">Add funds</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 -mr-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/12 border border-indigo-500/20 flex items-center justify-center mx-auto mb-4 text-indigo-300">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v18" />
              <path d="M17 8H9.5a2.5 2.5 0 0 0 0 5H14.5a2.5 2.5 0 0 1 0 5H7" />
            </svg>
          </div>
          <p className="text-base font-semibold text-zinc-100 mb-2">
            Fiat on-ramping is coming soon
          </p>
          <p className="text-sm text-zinc-500 leading-relaxed max-w-sm mx-auto">
            Soon you&apos;ll be able to add funds to Haven directly from fiat. For now, use Receive to copy one of your Safe addresses and fund it on-chain.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-6 inline-flex items-center justify-center px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

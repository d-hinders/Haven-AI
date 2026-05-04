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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 rounded-xl border border-white/[0.08] bg-[#111113] shadow-2xl shadow-black/40 overflow-hidden">
        <div className="px-6 py-6">
          <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-indigo-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-zinc-100">Add funds is coming soon</h2>
          <p className="text-sm text-zinc-500 mt-2 leading-relaxed">
            Fiat on-ramp support will let you fund Haven directly. For now, use Receive to copy a deposit address and send supported tokens on-chain.
          </p>
          <button
            onClick={onClose}
            className="mt-6 w-full rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-4 py-3 text-sm font-medium text-white hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

'use client'

import { useState } from 'react'
import SendModal from './SendModal'
import type { BalanceItem, SafeDetails } from '@/types/transactions'
import type { Contact } from '@/hooks/useContacts'

interface SendButtonProps {
  safeAddress: string
  safeDetails: SafeDetails | null
  balances: BalanceItem[]
  onSuccess?: () => void
  /** Visual variant */
  variant?: 'primary' | 'compact'
  contacts?: Contact[]
  resolveAddress?: (address: string) => string | null
}

export default function SendButton({
  safeAddress,
  safeDetails,
  balances,
  onSuccess,
  variant = 'primary',
  contacts,
  resolveAddress,
}: SendButtonProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {variant === 'primary' ? (
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
          </svg>
          Send
        </button>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-medium hover:bg-indigo-500/20 hover:border-indigo-500/50 transition-all duration-200"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
          </svg>
          Send
        </button>
      )}

      <SendModal
        open={open}
        onClose={() => setOpen(false)}
        safeAddress={safeAddress}
        safeDetails={safeDetails}
        balances={balances}
        onSuccess={onSuccess}
        contacts={contacts}
        resolveAddress={resolveAddress}
      />
    </>
  )
}

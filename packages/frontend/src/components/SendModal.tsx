'use client'

import { useState, useEffect, useCallback } from 'react'
import { type Address } from 'viem'
import { useAccount } from 'wagmi'
import { useSendTransaction, type SendStatus } from '@/hooks/useSendTransaction'
import { TOKENS, type SendParams } from '@/lib/safe-tx'
import type { BalanceItem, SafeDetails } from '@/types/transactions'

// ── Helpers ──────────────────────────────────────────────────────────
function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

const TOKEN_LIST = [
  { symbol: 'xDAI', label: 'xDAI', sub: 'Native' },
  { symbol: 'EURe', label: 'EURe', sub: 'Monerium' },
  { symbol: 'USDC.e', label: 'USDC.e', sub: 'Bridged USDC' },
] as const

// ── Props ────────────────────────────────────────────────────────────
interface SendModalProps {
  open: boolean
  onClose: () => void
  safeAddress: string
  safeDetails: SafeDetails | null
  balances: BalanceItem[]
  onSuccess?: () => void
}

// ── Component ────────────────────────────────────────────────────────
export default function SendModal({
  open,
  onClose,
  safeAddress,
  safeDetails,
  balances,
  onSuccess,
}: SendModalProps) {
  const { address: connectedAddress } = useAccount()
  const { status, txHash, error, send, reset } = useSendTransaction()

  // Form state
  const [selectedToken, setSelectedToken] = useState<string>('xDAI')
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [formError, setFormError] = useState('')
  const [step, setStep] = useState<'form' | 'review' | 'executing' | 'result'>('form')

  // Get balance for selected token
  const tokenBalance = balances.find(
    (b) => b.symbol.toLowerCase() === selectedToken.toLowerCase(),
  )
  const tokenConfig = TOKENS[selectedToken]
  const threshold = safeDetails?.threshold ?? 1
  const isMultiSig = threshold > 1

  // Reset everything when modal opens/closes
  useEffect(() => {
    if (open) {
      setSelectedToken('xDAI')
      setAmount('')
      setRecipient('')
      setFormError('')
      setStep('form')
      reset()
    }
  }, [open, reset])

  // Track send status to update step
  useEffect(() => {
    if (status === 'confirmed' || status === 'proposed') {
      setStep('result')
    }
    if (status === 'error') {
      // Stay on executing step to show error with retry
      setStep('result')
    }
  }, [status])

  // ── Validation ───────────────────────────────────────────────────
  const validate = useCallback((): boolean => {
    if (!amount || parseFloat(amount) <= 0) {
      setFormError('Enter an amount greater than 0')
      return false
    }

    if (tokenBalance) {
      const bal = parseFloat(tokenBalance.formatted)
      const amt = parseFloat(amount)
      if (amt > bal) {
        setFormError(`Insufficient balance. You have ${tokenBalance.formatted} ${selectedToken}`)
        return false
      }
    }

    if (!recipient) {
      setFormError('Enter a recipient address')
      return false
    }

    if (!isValidAddress(recipient)) {
      setFormError('Invalid Ethereum address')
      return false
    }

    if (recipient.toLowerCase() === safeAddress.toLowerCase()) {
      setFormError('Cannot send to the same Safe address')
      return false
    }

    setFormError('')
    return true
  }, [amount, recipient, safeAddress, selectedToken, tokenBalance])

  // ── Actions ──────────────────────────────────────────────────────
  const handleReview = () => {
    if (validate()) setStep('review')
  }

  const handleConfirm = async () => {
    if (!connectedAddress || !tokenConfig) return

    setStep('executing')

    const params: SendParams = {
      token: selectedToken as SendParams['token'],
      tokenAddress: tokenConfig.address as Address | null,
      decimals: tokenConfig.decimals,
      amount,
      recipient: recipient as Address,
    }

    await send(params, safeAddress as Address, threshold, connectedAddress)
  }

  const handleDone = () => {
    onSuccess?.()
    onClose()
  }

  // ── Don't render if closed ───────────────────────────────────────
  if (!open) return null

  // ── Status labels ────────────────────────────────────────────────
  const statusLabel: Record<SendStatus, string> = {
    idle: '',
    building: 'Preparing transaction...',
    signing: 'Waiting for wallet signature...',
    executing: isMultiSig ? 'Submitting proposal...' : 'Confirming on Gnosis Chain...',
    confirmed: 'Transaction confirmed!',
    proposed: 'Transaction proposed!',
    error: 'Transaction failed',
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={step === 'executing' ? undefined : onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 bg-[#111113] border border-white/[0.08] rounded-xl shadow-2xl shadow-black/40 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <h2 className="text-base font-semibold text-[#ededed]">
            {step === 'form' && 'Send tokens'}
            {step === 'review' && 'Review transaction'}
            {step === 'executing' && 'Processing'}
            {step === 'result' && (status === 'error' ? 'Failed' : 'Complete')}
          </h2>
          {step !== 'executing' && (
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* ── STEP 1: Form ────────────────────────────────────────── */}
        {step === 'form' && (
          <div className="p-6 space-y-5">
            {/* Token selector */}
            <div>
              <label className="block text-xs text-zinc-400 mb-2">Token</label>
              <div className="grid grid-cols-3 gap-2">
                {TOKEN_LIST.map((t) => {
                  const bal = balances.find(
                    (b) => b.symbol.toLowerCase() === t.symbol.toLowerCase(),
                  )
                  const isActive = selectedToken === t.symbol
                  return (
                    <button
                      key={t.symbol}
                      onClick={() => { setSelectedToken(t.symbol); setFormError('') }}
                      className={`p-3 rounded-lg border text-left transition-all duration-150 ${
                        isActive
                          ? 'border-indigo-500/50 bg-indigo-500/10'
                          : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12]'
                      }`}
                    >
                      <span className={`block text-sm font-medium ${isActive ? 'text-indigo-300' : 'text-zinc-300'}`}>
                        {t.label}
                      </span>
                      <span className="block text-[11px] text-zinc-500 mt-0.5">
                        {bal ? bal.formatted : '0.00'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Amount */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-zinc-400">Amount</label>
                {tokenBalance && (
                  <button
                    onClick={() => setAmount(tokenBalance.formatted)}
                    className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    Max: {tokenBalance.formatted}
                  </button>
                )}
              </div>
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    const v = e.target.value
                    // Allow numbers and one decimal point
                    if (/^\d*\.?\d*$/.test(v)) {
                      setAmount(v)
                      setFormError('')
                    }
                  }}
                  placeholder="0.00"
                  className="w-full px-4 py-3 pr-16 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-[#ededed] placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors font-mono"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-zinc-500">
                  {selectedToken}
                </span>
              </div>
            </div>

            {/* Recipient */}
            <div>
              <label className="block text-xs text-zinc-400 mb-2">Recipient</label>
              <input
                type="text"
                value={recipient}
                onChange={(e) => { setRecipient(e.target.value); setFormError('') }}
                placeholder="0x..."
                className="w-full px-4 py-3 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-[#ededed] placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors font-mono"
              />
            </div>

            {/* Error */}
            {formError && (
              <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">
                {formError}
              </div>
            )}

            {/* Multi-sig notice */}
            {isMultiSig && (
              <div className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/20 rounded-lg px-4 py-3">
                This Safe requires {threshold} of {safeDetails?.owners.length ?? '?'} signatures.
                Your signature will be submitted as a proposal.
              </div>
            )}

            {/* Continue button */}
            <button
              onClick={handleReview}
              disabled={!amount || !recipient}
              className="w-full py-3 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          </div>
        )}

        {/* ── STEP 2: Review ──────────────────────────────────────── */}
        {step === 'review' && (
          <div className="p-6 space-y-5">
            <div className="space-y-4 bg-white/[0.02] rounded-lg p-4 border border-white/[0.06]">
              <div className="flex justify-between items-center">
                <span className="text-xs text-zinc-500">Sending</span>
                <span className="text-sm font-medium text-zinc-200 font-mono">
                  {amount} {selectedToken}
                </span>
              </div>
              <div className="h-px bg-white/[0.06]" />
              <div className="flex justify-between items-start">
                <span className="text-xs text-zinc-500">To</span>
                <span className="text-sm text-zinc-300 font-mono text-right">
                  {truncate(recipient)}
                  <button
                    onClick={() => navigator.clipboard.writeText(recipient)}
                    className="ml-2 text-zinc-600 hover:text-zinc-400 transition-colors inline"
                  >
                    <svg className="w-3 h-3 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                    </svg>
                  </button>
                </span>
              </div>
              <div className="h-px bg-white/[0.06]" />
              <div className="flex justify-between items-center">
                <span className="text-xs text-zinc-500">From Safe</span>
                <span className="text-sm text-zinc-400 font-mono">
                  {truncate(safeAddress)}
                </span>
              </div>
              <div className="h-px bg-white/[0.06]" />
              <div className="flex justify-between items-center">
                <span className="text-xs text-zinc-500">Network</span>
                <span className="text-sm text-zinc-400">Gnosis Chain</span>
              </div>
              <div className="h-px bg-white/[0.06]" />
              <div className="flex justify-between items-center">
                <span className="text-xs text-zinc-500">Gas paid by</span>
                <span className="text-sm text-zinc-400">Your wallet (xDAI)</span>
              </div>
            </div>

            {isMultiSig && (
              <div className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/20 rounded-lg px-4 py-3">
                This will propose the transaction. It needs {threshold} of {safeDetails?.owners.length ?? '?'} owner approvals before execution.
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setStep('form')}
                className="flex-1 py-3 rounded-lg border border-white/[0.08] text-sm text-zinc-300 hover:bg-white/[0.04] transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleConfirm}
                className="flex-1 py-3 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
              >
                {isMultiSig ? 'Sign & Propose' : 'Sign & Execute'}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3: Executing ───────────────────────────────────── */}
        {step === 'executing' && (
          <div className="p-6 flex flex-col items-center justify-center py-12">
            {/* Spinner */}
            <div className="relative mb-6">
              <div className="w-14 h-14 rounded-full border-2 border-white/[0.06]" />
              <div className="absolute inset-0 w-14 h-14 rounded-full border-2 border-transparent border-t-indigo-500 animate-spin" />
            </div>
            <p className="text-sm text-zinc-300 mb-1">{statusLabel[status]}</p>
            <p className="text-xs text-zinc-600">
              {status === 'signing' && 'Check your wallet for a signature request'}
              {status === 'executing' && 'This may take a few seconds'}
              {status === 'building' && 'Reading Safe nonce...'}
            </p>
          </div>
        )}

        {/* ── STEP 4: Result ──────────────────────────────────────── */}
        {step === 'result' && (
          <div className="p-6 flex flex-col items-center py-10">
            {status === 'confirmed' && (
              <>
                <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-5">
                  <svg className="w-7 h-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <p className="text-base font-semibold text-zinc-200 mb-1">Transaction confirmed</p>
                <p className="text-xs text-zinc-500 mb-5">
                  {amount} {selectedToken} sent to {truncate(recipient)}
                </p>
                {txHash && (
                  <a
                    href={`https://gnosisscan.io/tx/${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors mb-6 flex items-center gap-1"
                  >
                    View on Gnosisscan
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                    </svg>
                  </a>
                )}
                <button
                  onClick={handleDone}
                  className="w-full py-3 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200"
                >
                  Done
                </button>
              </>
            )}

            {status === 'proposed' && (
              <>
                <div className="w-14 h-14 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-5">
                  <svg className="w-7 h-7 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-base font-semibold text-zinc-200 mb-1">Transaction proposed</p>
                <p className="text-xs text-zinc-500 mb-2 text-center">
                  {amount} {selectedToken} to {truncate(recipient)}
                </p>
                <p className="text-xs text-zinc-500 mb-5 text-center">
                  Waiting for {threshold - 1} more signature{threshold - 1 !== 1 ? 's' : ''} to execute.
                </p>
                <a
                  href={`https://app.safe.global/transactions/queue?safe=gno:${safeAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors mb-6 flex items-center gap-1"
                >
                  View in Safe{'{Wallet}'}
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                  </svg>
                </a>
                <button
                  onClick={handleDone}
                  className="w-full py-3 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200"
                >
                  Done
                </button>
              </>
            )}

            {status === 'error' && (
              <>
                <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-5">
                  <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <p className="text-base font-semibold text-zinc-200 mb-1">Transaction failed</p>
                <p className="text-xs text-zinc-500 mb-6 text-center max-w-xs">
                  {error ?? 'An unexpected error occurred'}
                </p>
                <div className="flex gap-3 w-full">
                  <button
                    onClick={onClose}
                    className="flex-1 py-3 rounded-lg border border-white/[0.08] text-sm text-zinc-300 hover:bg-white/[0.04] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { reset(); setStep('form') }}
                    className="flex-1 py-3 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200"
                  >
                    Try again
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

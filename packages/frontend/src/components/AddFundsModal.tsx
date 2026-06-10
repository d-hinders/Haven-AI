'use client'

import { useRef, useState, useCallback } from 'react'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { Button } from '@/components/ui/Button'
import { getChainConfig } from '@/lib/chains'

interface Props {
  open: boolean
  onClose: () => void
  onReceive?: () => void
  safeAddress?: string
  chainId?: number
}

const ONRAMP_APP_ID = process.env.NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID

function buildOnrampUrl(safeAddress: string, chainShortName: string): string {
  const addresses = JSON.stringify({ [safeAddress]: [chainShortName] })
  const params = new URLSearchParams({
    appId: ONRAMP_APP_ID ?? '',
    addresses,
    assets: JSON.stringify(['USDC']),
    defaultNetwork: chainShortName,
  })
  return `https://pay.coinbase.com/buy/select-asset?${params.toString()}`
}

export default function AddFundsModal({ open, onClose, onReceive, safeAddress, chainId }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  useEscapeToClose(open, onClose)
  useFocusTrap(panelRef, open)

  const chainConfig = chainId != null ? getChainConfig(chainId) : null
  const shortName = chainConfig?.shortName ?? 'base'
  const chainName = chainConfig?.name ?? 'Base'
  const onrampAvailable = Boolean(ONRAMP_APP_ID && safeAddress)

  const handleCopy = useCallback(async () => {
    if (!safeAddress) return
    try {
      await navigator.clipboard.writeText(safeAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable — no-op
    }
  }, [safeAddress])

  function handleBuyWithCard() {
    if (!safeAddress) return
    const url = buildOnrampUrl(safeAddress, shortName)
    window.open(url, '_blank', 'noopener,noreferrer,width=480,height=720')
  }

  function handleReceiveInstead() {
    onClose()
    onReceive?.()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-funds-title"
        className="relative mx-4 w-full max-w-md overflow-hidden rounded-xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-6 py-4">
          <div>
            <h2 id="add-funds-title" className="text-base font-semibold text-[var(--v2-ink)]">Add funds</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
              Fund your Safe with USDC to enable agent payments.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4 px-6 py-6">
          {/* Buy with card — only shown when Coinbase Onramp is configured */}
          {onrampAvailable && (
            <div className="rounded-lg border border-[var(--v2-border)] p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                  <svg className="h-4 w-4 text-[var(--v2-ink-2)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[var(--v2-ink)]">Buy with card</p>
                  <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
                    Purchase USDC directly to your Safe via Coinbase. KYC handled by Coinbase — Haven never holds your funds.
                  </p>
                </div>
              </div>
              <Button className="mt-3 w-full" onClick={handleBuyWithCard}>
                Buy with card →
              </Button>
            </div>
          )}

          {/* Manual transfer — always shown */}
          <div className="rounded-lg border border-[var(--v2-border)] p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                <svg className="h-4 w-4 text-[var(--v2-ink-2)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--v2-ink)]">Transfer from another wallet</p>
                <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
                  Send USDC to your Safe address on {chainName}.
                </p>
              </div>
            </div>

            {safeAddress ? (
              <div className="mt-3">
                <p className="mb-1.5 text-xs font-medium text-[var(--v2-ink-3)]">Safe address ({chainName})</p>
                <div className="flex items-center gap-2 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-2">
                  <code className="min-w-0 flex-1 truncate text-xs text-[var(--v2-ink)]">
                    {safeAddress}
                  </code>
                  <button
                    onClick={handleCopy}
                    aria-label="Copy Safe address"
                    className="flex-shrink-0 rounded p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)]"
                  >
                    {copied ? (
                      <svg className="h-4 w-4 text-[var(--v2-brand)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <Button variant="ghost" className="mt-3 w-full" onClick={handleReceiveInstead}>
                Show receive address →
              </Button>
            )}
          </div>

          {/* Fallback when provider unavailable and no safe */}
          {!onrampAvailable && !safeAddress && onReceive && (
            <Button onClick={handleReceiveInstead} className="w-full">
              Receive instead
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

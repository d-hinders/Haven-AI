'use client'

import { ArrowLeftRight, Check, Clipboard, CreditCard, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
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
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center">
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
              Fund your account with USDC to enable agent payments.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
          >
            <Icon icon={X} className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-6">
          {/* Buy with card — only shown when Coinbase Onramp is configured */}
          {onrampAvailable && (
            <div className="rounded-lg border border-[var(--v2-border)] p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                  <Icon icon={CreditCard} className="h-4 w-4 text-[var(--v2-ink-2)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[var(--v2-ink)]">Buy with card</p>
                  <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
                    Purchase USDC directly to your account via Coinbase. KYC handled by Coinbase — Haven never holds your funds.
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
                <Icon icon={ArrowLeftRight} className="h-4 w-4 text-[var(--v2-ink-2)]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--v2-ink)]">Transfer from another wallet</p>
                <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
                  Send USDC to your account address on {chainName}.
                </p>
              </div>
            </div>

            {safeAddress ? (
              <div className="mt-3">
                <p className="mb-1.5 text-xs font-medium text-[var(--v2-ink-3)]">Account address ({chainName})</p>
                <div className="flex items-center gap-2 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-2">
                  <code className="min-w-0 flex-1 truncate text-xs text-[var(--v2-ink)]">
                    {safeAddress}
                  </code>
                  <button
                    onClick={handleCopy}
                    aria-label="Copy account address"
                    className="flex-shrink-0 rounded p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)]"
                  >
                    {copied ? (
                      <Icon icon={Check} className="h-4 w-4 text-[var(--v2-brand)]" />
                    ) : (
                      <Icon icon={Clipboard} className="h-4 w-4" />
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

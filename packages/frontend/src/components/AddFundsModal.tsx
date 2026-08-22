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

/**
 * The chain, or null — never a guess, and never a thrown render.
 *
 * `getChainConfig` THROWS for any id outside the registry, so a bare
 * `chainId != null` test covers only one of the two ways a chain can fail to
 * resolve. The other — a `chain_id` that is present but unregistered, e.g. a
 * chain the API serves before the frontend registry catches up — would take the
 * whole modal down through the error boundary instead of reaching the refusal
 * below. Both shapes are "we do not know this account's network", and a funding
 * surface should answer them the same way. Deliberately local rather than a
 * change to `getChainConfig`: seventeen other call sites rely on it throwing,
 * and quietly making it total is a different decision than this issue's.
 */
function resolveChainOrNull(chainId?: number) {
  if (chainId == null) return null
  try {
    return getChainConfig(chainId)
  } catch {
    return null
  }
}

export default function AddFundsModal({ open, onClose, onReceive, safeAddress, chainId }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  useEscapeToClose(open, onClose)
  useFocusTrap(panelRef, open)

  // #1844: an unresolved chain gets NO default. Both values below are
  // money-facing — the manual-transfer copy tells a human which network to send
  // real USDC on, and `shortName` becomes Coinbase Onramp's `defaultNetwork`,
  // i.e. the delivery network of a preconfigured fiat purchase. The previous
  // `?? 'base'` / `?? 'Base'` resolved a missing value to MAINNET, silently and
  // indistinguishably from a fact. A funds surface with no chain refuses to
  // instruct rather than guessing; `DEFAULT_CHAIN_ID` would be
  // environment-correct but still unreadable as a guess from the screen.
  const chainConfig = resolveChainOrNull(chainId)
  const chainName = chainConfig?.name ?? null
  const onrampAvailable = Boolean(ONRAMP_APP_ID && safeAddress && chainConfig)
  const depositInstructionsAvailable = Boolean(safeAddress && chainConfig)

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
    if (!safeAddress || !chainConfig) return
    const url = buildOnrampUrl(safeAddress, chainConfig.shortName)
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
                  {chainName
                    ? `Send USDC to your account address on ${chainName}.`
                    : "We can't confirm which network this account uses, so we can't tell you where to send USDC."}
                </p>
              </div>
            </div>

            {depositInstructionsAvailable && safeAddress ? (
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
            ) : !safeAddress ? (
              <Button variant="ghost" className="mt-3 w-full" onClick={handleReceiveInstead}>
                Show receive address →
              </Button>
            ) : null}
            {/*
              The receive handoff is offered ONLY when there is no address at
              all — its original condition, restored after the rendered review
              caught the regression. Offering it when an address exists but the
              chain does not sends the user to `ReceiveFundsModal`, which calls
              `getChainConfig(safe.chain_id)` unconditionally and THROWS on a
              missing chain: the refusal screen's own way out would be a crash.
              Nor is it a real out — that modal names the network with full
              confidence in four places, so a crash-safe version would just
              reintroduce the unconfirmed-network claim one click away
              (#1852 covers making the receive surface unresolved-aware). With
              no chain we have nothing honest to offer beyond saying so, and
              a dead end the user can read beats a dead end that throws.
            */}
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

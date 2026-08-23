'use client'

import { ArrowLeftRight, Check, Clipboard, CreditCard, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useRef, useState, useCallback } from 'react'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { Button } from '@/components/ui/Button'
import { resolveChainOrNull } from '@/lib/chains'

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

// `resolveChainOrNull` was introduced here by #1844 and lifted into
// `lib/chains.ts` by #1852, when `ReceiveFundsModal` needed the same answer to
// the same question. A second local copy would have drifted; what stays
// deliberately unchanged is `getChainConfig`'s throwing contract, which ~20
// other call sites depend on. See the doc comment on the lifted function.

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
              <Button className="mt-3 w-full" onClick={handleBuyWithCard} trailingIcon>
                Buy with card
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
              <Button variant="ghost" className="mt-3 w-full" onClick={handleReceiveInstead} trailingIcon>
                Show receive address
              </Button>
            ) : (
              /*
                A refusal still owes the user a next action — `design-review.md`
                ("Error copy explains the next useful action") does not exempt
                the states where we are the ones who cannot proceed. Retrying is
                the honest one, and the only one: the unresolved chain reaches
                this component as a safe that arrived without `chain_id`, which
                is a load-shaped condition, so re-fetching is a real step rather
                than a gesture.

                The label is `ErrorBoundary`'s, deliberately reused rather than
                reinvented (`ErrorBoundary.tsx:64`) — "Refresh page" promises
                only a retry. It must NOT grow a sentence like "refreshing
                usually resolves it": that would re-promise the network the copy
                above just refused, which is the exact shape of the earlier
                finding on this PR. `ui/Button` rather than ErrorBoundary's raw
                element, because that one is styled for a page outside the app
                shell; inside a modal the primitive is the design-system answer.
              */
              <Button
                variant="ghost"
                className="mt-3 w-full"
                onClick={() => window.location.reload()}
              >
                Refresh page
              </Button>
            )}
            {/*
              The receive handoff is offered ONLY when there is no address at
              all — its original condition, restored after the rendered review
              It stays removed after #1852, but for a DIFFERENT reason than the
              one written here first — recorded rather than quietly rewritten,
              because the change of reason is the interesting part. Originally:
              `ReceiveFundsModal` called `getChainConfig(safe.chain_id)` on an
              unconditional path and THREW on a missing chain, so the refusal
              screen's own way out was a crash, and it named the network with
              full confidence in four places besides. #1852 fixed both. The
              handoff would therefore no longer be dangerous — it would merely
              be pointless: it sends a user from one refusal to an identical
              refusal, which reads as the product forgetting what it just told
              them. With no chain there is still nothing honest to offer beyond
              saying so.
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

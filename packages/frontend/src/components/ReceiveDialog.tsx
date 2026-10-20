'use client'

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Clipboard, CreditCard, Droplet, X } from 'lucide-react'
import { getExplorerUrl, resolveChainOrNull } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import type { SmartAccount } from '@/context/AuthContext'
import { getFaucetUrl } from '@haven_ai/core'
import { isTestnetChain } from '@/lib/marketplace'
import { Button } from '@/components/ui/Button'
import { Address, ApprovalRequiredBanner } from '@/components/haven'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { Icon } from '@/components/ui/Icon'

interface Props {
  open: boolean
  account: SmartAccount | null
  onClose: () => void
}

const ONRAMP_APP_ID = process.env.NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID

function buildOnrampUrl(accountAddress: string, chainShortName: string): string {
  const addresses = JSON.stringify({ [accountAddress]: [chainShortName] })
  const params = new URLSearchParams({
    appId: ONRAMP_APP_ID ?? '',
    addresses,
    assets: JSON.stringify(['USDC']),
    defaultNetwork: chainShortName,
  })
  return `https://pay.coinbase.com/buy/select-asset?${params.toString()}`
}

/**
 * The ONE receive dialog (#4094): `ReceiveFundsModal` ("Deposit address") and
 * `AddFundsModal` ("Add funds") asked for the same thing two ways and then
 * disagreed on tokens — the former listed every registry token for the chain
 * (ETH and USDC), the latter said USDC. This replaces both: the account is
 * chosen by the caller (the dashboard's picker when there is more than one
 * account, the page's own account elsewhere), and the dialog shows the
 * address with QR and Copy, ONE network rule naming one token ("Send USDC on
 * <network> only"), and the other ways to add money — "Get test USDC" on a
 * test network, "Buy with card" on Base when the Coinbase Onramp app id is
 * configured.
 *
 * `resolveChainOrNull` answers #1844's question, introduced by #1844 and
 * lifted into `lib/chains.ts` by #1852 when both funding dialogs needed the
 * same answer. An unresolved chain — `chain_id` absent OR present but
 * unregistered — gets NO default and no network instruction: the refusal
 * below renders instead, and neither "other ways" card appears, because a
 * faucet link and an onramp purchase are both network-addressed things to
 * offer a person we cannot name a network for.
 *
 * #3478: the faucet and the onramp are gated on the SELECTED ACCOUNT's chain
 * (`account.chain_id`), never on the deployment's `NEXT_PUBLIC_HAVEN_CHAIN_ID`
 * default — both Base and Base Sepolia are offered as an account chain in
 * every environment, so a deployment-level gate would show a faucet for a
 * Base-mainnet account on dev, or hide it for a Base Sepolia account on
 * production. Gated on `chainConfig` (not the bare id) so `isTestnetChain`
 * only ever runs on an already-resolved chain — `isTestnetChain` still fails
 * closed on an unregistered id (it checks `isRegisteredChain` before it ever
 * calls `getFaucetUrl`, which itself throws on one), so this never needs a
 * try/catch to stay safe.
 */
export default function ReceiveDialog({ open, account, onClose }: Props) {
  const { toast } = useToast()
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)
  const [copied, setCopied] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  useEscapeToClose(open, onClose)

  useEffect(() => {
    if (!open) {
      setShowQr(false)
      setQrDataUrl(null)
      setCopied(false)
    }
  }, [open])

  // #1852 note, carried over: no chain guard here, deliberately. The QR is
  // suppressed in the unresolved state by its toggle not being rendered at
  // all (asserted), and a second guard on the generator would be unreachable
  // from the UI and so unprovable by mutation.
  useEffect(() => {
    if (!open || !showQr || !account?.account_address) return

    let cancelled = false
    QRCode.toDataURL(account.account_address, {
      margin: 1,
      width: 220,
      color: { dark: '#1A2140', light: '#FFFFFF' }, // QR encoder needs literal hex for module colours — design-lint-disable-line
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url)
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null)
      })

    return () => {
      cancelled = true
    }
  }, [open, showQr, account?.account_address])

  if (!open || !account) return null

  const accountAddress = account.account_address
  const chainConfig = resolveChainOrNull(account.chain_id)
  // The one network rule (#4094): a single token, a single network. ETH is
  // not listed — agents spend USDC, and a receive screen that lists tokens
  // the product never spends invites the wrong deposit.
  const networkRule = chainConfig ? `Send USDC on ${chainConfig.name} only.` : null

  const depositInstructionsAvailable = Boolean(accountAddress && chainConfig)

  // #3478: both "other ways" cards are gated on the account's OWN chain and
  // on an address actually being shown above — the faucet copy says "from
  // above", and the onramp needs a delivery address.
  const isTestnet = chainConfig != null && isTestnetChain(chainConfig.chainId)
  const faucetUrl = isTestnet ? getFaucetUrl(chainConfig.chainId) : undefined
  const onrampAvailable =
    Boolean(ONRAMP_APP_ID && accountAddress && chainConfig) && !isTestnet

  function copyAddress() {
    if (!accountAddress) return
    void navigator.clipboard.writeText(accountAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
    toast.success('Address copied')
  }

  function handleBuyWithCard() {
    if (!accountAddress || !chainConfig) return
    const url = buildOnrampUrl(accountAddress, chainConfig.shortName)
    window.open(url, '_blank', 'noopener,noreferrer,width=480,height=720')
  }

  return (
    // `v2-safe-overlay` with no gutter of its own (#2730): this overlay has
    // never had one, so every side is exactly its safe-area inset — 0 in any
    // browser without a notch, and the clearance the home indicator needs in
    // the installed shell.
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center v2-safe-overlay">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="receive-dialog-title"
        className="relative mx-4 max-h-[calc(100vh-2rem-var(--v2-safe-top)-var(--v2-safe-bottom))] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--v2-border)] px-6 py-4">
          <div>
            <h2 id="receive-dialog-title" className="text-base font-semibold text-[var(--v2-ink)]">Receive</h2>
            {/*
              No network subtitle here, deliberately: the ONE network rule
              renders once, on the address card below (the one sentence a
              person must read before they act on it, #4094's mockup order).
              A header subtitle would state it a second time — and a hedged
              version of it, for a chain that did not resolve, would only
              duplicate the refusal in the body: two statements of the same
              uncertainty read as noise rather than as care.
            */}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded-md p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
          >
            <Icon icon={X} className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-6">
          <Card hover={false} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-semibold text-[var(--v2-ink)]">{account.name}</p>
                  {account.is_default && (
                    <span className="rounded-full bg-[var(--v2-brand-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--v2-brand)]">
                      Default
                    </span>
                  )}
                </div>
                {chainConfig && (
                  <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{chainConfig.name}</p>
                )}
              </div>
              <span className="rounded-full bg-[var(--v2-surface-2)] px-2 py-1 text-xs font-medium text-[var(--v2-ink-2)]">
                On-chain receive
              </span>
            </div>
          </Card>

          {/*
            #1852 (carried over): everything below the account card is
            network-specific, so none of it renders without a resolved chain.

            The address alone is chain-agnostic — the same 20 bytes on every
            EVM network — and the argument for still showing it is real. It
            loses on what this screen is FOR. A receive screen is not an
            identity readout; it is an instruction to send, and the QR beside
            the address is that instruction in its most one-click form. A user
            who scans it sends on whatever network their wallet is on, and we
            would have named none. On a funding surface the cost of the two
            errors is not symmetric: withholding an address costs a refresh,
            and a transfer to the right address on the wrong network is often
            unrecoverable. So the address, the copy button, the QR toggle and
            the explorer link all go.
          */}
          {chainConfig && accountAddress ? (
            <>
              <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                <p className="text-xs font-medium text-[var(--v2-ink-3)]">Haven wallet address</p>
                <p className="mt-2 break-all text-sm text-[var(--v2-ink)]">
                  <Address value={accountAddress} truncate={false} />
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button onClick={copyAddress} size="sm">
                    {copied ? 'Address copied' : 'Copy address'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setShowQr((value) => !value)}>
                    {showQr ? 'Hide QR code' : 'Show QR code'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    href={getExplorerUrl(account.chain_id, 'address', accountAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on explorer
                  </Button>
                </div>
              </div>

              {showQr && (
                // Never-invert container (#2929): the QR is authored against
                // white and a scanner reads its module contrast — the box stays
                // fixed-white in both themes via `.v2-light-surface`
                // (globals.css), which also opts native fallback paints inside
                // out of the dark scheme.
                <div className="v2-light-surface rounded-[10px] border p-4">
                  <div role="status" aria-busy={!qrDataUrl} aria-live="polite" className="flex flex-col items-center">
                    {qrDataUrl ? (
                      <img
                        src={qrDataUrl}
                        alt={`QR code for ${account.name} on ${chainConfig.name}`}
                        className="h-[220px] w-[220px] rounded-lg border border-[var(--v2-border)]"
                      />
                    ) : (
                      <Skeleton className="h-[220px] w-[220px] rounded-lg" />
                    )}
                    <p className="mt-3 text-center text-xs text-[var(--v2-ink-3)]">
                      QR code for {truncate(accountAddress)}
                    </p>
                  </div>
                </div>
              )}

              {/*
                #4094: the ONE network rule, stated ONCE. It sits directly
                under the address card — the one sentence a person must read
                before they act on it — as the first item of the "Before you
                send" card, not in a second place elsewhere in the dialog.
              */}
              <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                <p className="text-xs font-medium text-[var(--v2-ink-3)]">
                  Before you send
                </p>
                <ul className="mt-3 space-y-2 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                  <li>{networkRule}</li>
                  <li>Funds arrive after the on-chain transfer is confirmed.</li>
                </ul>
              </div>

              {(isTestnet || onrampAvailable) && (
                <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-4">
                  <p className="text-sm font-semibold text-[var(--v2-ink)]">Other ways to add money</p>

                  {isTestnet && faucetUrl && (
                    <div className="mt-3">
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                          <Icon icon={Droplet} className="h-4 w-4 text-[var(--v2-ink-2)]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[var(--v2-ink)]">Get test USDC</p>
                          <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
                            Get free {chainConfig.name} USDC from Circle&apos;s faucet. It&apos;s test money
                            with no value, and it comes from Circle, not Haven. Pick USDC and{' '}
                            {chainConfig.name} there, then paste your account address from above.
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        className="mt-3 w-full"
                        href={faucetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        trailingIcon
                      >
                        Open Circle&apos;s faucet
                      </Button>
                    </div>
                  )}

                  {onrampAvailable && (
                    <div className={isTestnet ? 'mt-4' : undefined}>
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                          <Icon icon={CreditCard} className="h-4 w-4 text-[var(--v2-ink-2)]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[var(--v2-ink)]">Buy with card</p>
                          <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
                            Purchase USDC directly to your account via Coinbase. KYC is handled by
                            Coinbase; Haven never holds your funds.
                          </p>
                        </div>
                      </div>
                      <Button className="mt-3 w-full" onClick={handleBuyWithCard} trailingIcon>
                        Buy with card
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : !accountAddress ? (
            /*
              A resolved chain with NO address is its own state: the network
              is known, but there is nothing to copy, scan or fund yet. The
              account arrived without `account_address`, which is the
              same load-shaped condition the network refusal covers — so the
              next action is the same honest retry, without a banner that
              would claim the network is unconfirmed when it is known, and
              without the network rule: it instructs about an address that
              is not on screen.
            */
            <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
              <p className="text-sm text-[var(--v2-ink-2)]">
                We can&apos;t show this account&apos;s address right now.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-4 w-full"
                onClick={() => window.location.reload()}
              >
                Refresh page
              </Button>
            </div>
          ) : (
            /*
              The warning is a Haven-domain RISK explanation, so it uses the
              domain primitive rather than a bespoke card — `design-review.md`'s
              Visual System checklist names those components as the reuse target
              for exactly this. The bespoke version the old receive screen
              dressed "funds sent on the wrong network are usually unrecoverable"
              in the same neutral card as the routine "Before you send"
              checklist, giving a loss-of-funds warning the visual weight of a
              reminder.

              A refusal still owes a next action — `design-review.md` requires
              error copy to explain one, and "we won't help you" is not an
              exemption. `Refresh page` is the honest one and the only one: the
              state arrives as an account without a usable `chain_id` at the
              `/auth/me` boundary, which is load-shaped, so re-fetching is a
              real step. The label is `ErrorBoundary`'s
              (`ErrorBoundary.tsx:64`), reused rather than reinvented, and it
              carries NO accompanying sentence: "refreshing usually resolves
              it" would re-promise the network the line above just refused
              (#1844's finding).

              The same refusal covers a resolved chain with NO address: the
              two "other ways" cards and the QR all need the address, and
              there is no honest instruction to give without it. Refresh is
              still the next action — the account arriving without
              `account_address` is the same load-shaped condition.
            */
            <ApprovalRequiredBanner title="Network not confirmed" tone="warning">
              <p>
                We can&apos;t confirm which network this account uses, so we can&apos;t show you its
                address or QR code. Funds sent on the wrong network are usually unrecoverable.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-4 w-full"
                onClick={() => window.location.reload()}
              >
                Refresh page
              </Button>
            </ApprovalRequiredBanner>
          )}
        </div>
      </div>
    </div>
  )
}

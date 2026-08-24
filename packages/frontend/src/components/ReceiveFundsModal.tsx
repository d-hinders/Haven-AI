'use client'

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { getExplorerUrl, resolveChainOrNull } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import type { UserSafe } from '@/context/AuthContext'
import { Button } from '@/components/ui/Button'
import { Address, ApprovalRequiredBanner } from '@/components/haven'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

interface Props {
  open: boolean
  safe: UserSafe | null
  onClose: () => void
}

export default function ReceiveFundsModal({ open, safe, onClose }: Props) {
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

  // #1852 note: no chain guard here, deliberately. The QR is suppressed in the
  // unresolved state by its toggle not being rendered at all (asserted), and a
  // second guard on the generator would be unreachable from the UI and so
  // unprovable by mutation — a guard no test can turn red is worse than none,
  // because it reads as protection while protecting nothing.
  useEffect(() => {
    if (!open || !showQr || !safe?.safe_address) return

    let cancelled = false
    QRCode.toDataURL(safe.safe_address, {
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
  }, [open, showQr, safe?.safe_address])

  if (!open || !safe) return null

  const safeAddress = safe.safe_address
  // #1852: was `getChainConfig(safe.chain_id)`, which THROWS for any id outside
  // the registry — including `undefined` — taking the whole screen down through
  // the error boundary. Both shapes of unresolved (absent id, present-but-
  // unregistered id) now resolve to null and reach the refusal below.
  const chainConfig = resolveChainOrNull(safe.chain_id)
  const supportedTokens = chainConfig ? Object.values(chainConfig.tokens) : []

  function copyAddress() {
    void navigator.clipboard.writeText(safeAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
    toast.success('Address copied')
  }

  return (
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="receive-funds-title"
        className="relative mx-4 max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--v2-border)] bg-white shadow-modal"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--v2-border)] px-6 py-4">
          <div>
            <h2 id="receive-funds-title" className="text-base font-semibold text-[var(--v2-ink)]">Receive funds</h2>
            {/*
              With no chain resolved this subtitle renders nothing rather than a
              hedged version of itself. The sentence's entire job is to name the
              network; a hedged rewrite here would only duplicate the refusal in
              the body, and two statements of the same uncertainty read as noise
              rather than as care.
            */}
            {chainConfig && (
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                Send supported tokens to this Haven wallet on {chainConfig.name}.
              </p>
            )}
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
                  <p className="truncate text-sm font-semibold text-[var(--v2-ink)]">{safe.name}</p>
                  {safe.is_default && (
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
            #1852: everything below the account card is network-specific, so
            none of it renders without a resolved chain.

            The address alone is chain-agnostic — the same 20 bytes on every
            EVM network — and the argument for still showing it is real. It
            loses on what this screen is FOR. A receive screen is not an
            identity readout; it is an instruction to send, and the QR beside
            the address is that instruction in its most one-click form. A user
            who scans it sends on whatever network their wallet is on, and we
            would have named none. On a funding surface the cost of the two
            errors is not symmetric: withholding an address costs a refresh,
            and a transfer to the right address on the wrong network is often
            unrecoverable. So the address, the copy button, the QR toggle, the
            explorer link (which reads the chain and would throw anyway), the
            supported-token list and the 'Before you send' rules all go.

            What stays is the account card above: the name and Default badge
            are true regardless of chain, and they tell the user WHICH account
            the refusal is about — which is exactly the thing a person needs
            to know before they can act on it. It names no network and offers
            no way to send anything.
          */}
          {chainConfig ? (
            <>
              <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                <p className="text-xs font-medium text-[var(--v2-ink-3)]">Haven wallet address</p>
                <p className="mt-2 break-all text-sm text-[var(--v2-ink)]">
                  <Address value={safeAddress} truncate={false} />
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
                    href={getExplorerUrl(safe.chain_id, 'address', safeAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on explorer
                  </Button>
                </div>
              </div>

              {showQr && (
                <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-4">
                  <div role="status" aria-busy={!qrDataUrl} aria-live="polite" className="flex flex-col items-center">
                    {qrDataUrl ? (
                      <img
                        src={qrDataUrl}
                        alt={`QR code for ${safe.name} on ${chainConfig.name}`}
                        className="h-[220px] w-[220px] rounded-lg border border-[var(--v2-border)]"
                      />
                    ) : (
                      <Skeleton className="h-[220px] w-[220px] rounded-lg" />
                    )}
                    <p className="mt-3 text-center text-xs text-[var(--v2-ink-3)]">
                      QR code for {truncate(safeAddress)}
                    </p>
                  </div>
                </div>
              )}

              <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-4">
                <p className="text-xs font-medium text-[var(--v2-ink-3)]">
                  Supported on {chainConfig.name}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {supportedTokens.map((token) => (
                    <span
                      key={token.symbol}
                      className="rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface)] px-2.5 py-1 text-xs font-medium text-[var(--v2-ink-2)]"
                    >
                      {token.symbol}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                <p className="text-sm font-semibold text-[var(--v2-ink)]">Before you send</p>
                <ul className="mt-3 space-y-2 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                  <li>Use the {chainConfig.name} network.</li>
                  <li>Send only the supported tokens listed above.</li>
                  <li>Funds arrive after the on-chain transfer is confirmed.</li>
                </ul>
              </div>
            </>
          ) : (
            /*
              The warning is a Haven-domain RISK explanation, so it uses the
              domain primitive rather than a bespoke card — `design-review.md`'s
              Visual System checklist names those components as the reuse target
              for exactly this. The bespoke version it replaces dressed "funds
              sent on the wrong network are usually unrecoverable" in the same
              neutral card as the routine "Before you send" checklist, giving a
              loss-of-funds warning the visual weight of a reminder.

              On the primitive's NAME, which is a fair objection: a chain that
              will not resolve is not an approval. `ApprovalRequiredBanner` is
              approval-named for historical reasons but is already the repo's
              generic titled notice — it carries an overridable `title` and a
              `tone`, and ships today as "Paused in Haven", "Recoverable funds
              in agent wallet" and "You stay in control". Reusing it is therefore
              consistent with existing practice rather than a stretch, and
              renaming it is a repo-wide change this issue should not make.
            */
            <ApprovalRequiredBanner title="Network not confirmed" tone="warning">
              <p>
                We can&apos;t confirm which network this account uses, so we can&apos;t show you its
                address or QR code. Funds sent on the wrong network are usually unrecoverable.
              </p>
              {/*
                A refusal still owes a next action — `design-review.md` requires
                error copy to explain one, and "we won't help you" is not an
                exemption. `Refresh page` is the honest one and the only one:
                the state arrives as a safe without a usable `chain_id` at the
                `/auth/me` boundary, which is load-shaped, so re-fetching is a
                real step. The label is `ErrorBoundary`'s (`ErrorBoundary.tsx:64`),
                reused rather than reinvented, and it carries NO accompanying
                sentence: "refreshing usually resolves it" would re-promise the
                network the line above just refused (#1844's finding, same shape).
                Deliberately NOT offered: any route to Add funds, which refuses
                the same way and would only bounce the user between two dead ends.

                `w-full` matches the twin refusal in `AddFundsModal` (#1853,
                already merged). Same label, same variant, same condition, same
                PR family — two sibling refusals should not differ by accident.
              */}
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

'use client'

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import type { UserSafe } from '@/context/AuthContext'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { useFocusTrap } from '@/hooks/useFocusTrap'

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

  useEffect(() => {
    if (!open || !showQr || !safe?.safe_address) return

    let cancelled = false
    QRCode.toDataURL(safe.safe_address, {
      margin: 1,
      width: 220,
      color: { dark: '#1A2140', light: '#FFFFFF' },
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
  const chainConfig = getChainConfig(safe.chain_id)
  const supportedTokens = Object.values(chainConfig.tokens)

  function copyAddress() {
    void navigator.clipboard.writeText(safeAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
    toast.success('Address copied')
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="receive-funds-title"
        className="relative mx-4 max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--v2-border)] px-6 py-4">
          <div>
            <h2 id="receive-funds-title" className="text-base font-semibold text-[var(--v2-ink)]">Receive funds</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
              Send supported tokens to this Haven wallet on {chainConfig.name}.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded-md p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-5 p-6">
          <Card hover={false} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-semibold text-[var(--v2-ink)]">{safe.name}</p>
                  {safe.is_default && (
                    <span className="rounded-full bg-[var(--v2-brand-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--v2-brand)]">
                      Default
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{chainConfig.name}</p>
              </div>
              <span className="rounded-full bg-[var(--v2-surface-2)] px-2 py-1 text-[11px] font-medium text-[var(--v2-ink-2)]">
                On-chain receive
              </span>
            </div>
          </Card>

          <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">Haven wallet address</p>
            <code className="mt-2 block break-all font-mono text-sm text-[var(--v2-ink)]">
              {safeAddress}
            </code>
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
        </div>
      </div>
    </div>
  )
}

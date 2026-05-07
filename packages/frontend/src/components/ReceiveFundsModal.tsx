'use client'

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import type { UserSafe } from '@/context/AuthContext'

interface Props {
  open: boolean
  safe: UserSafe | null
  onClose: () => void
}

export default function ReceiveFundsModal({ open, safe, onClose }: Props) {
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
    navigator.clipboard.writeText(safeAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-[var(--v2-ink)]/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg mx-4 rounded-xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--v2-border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--v2-ink)]">Receive funds</h2>
            <p className="text-xs text-[var(--v2-ink-3)] mt-1">
              Share this account&apos;s deposit address on {chainConfig.name}.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-medium text-[var(--v2-ink)]">{safe.name}</p>
              {safe.is_default && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]">
                  default
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--v2-ink-3)]">{chainConfig.name}</p>
          </div>

          <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-2">Account address</p>
            <code className="block text-sm text-[var(--v2-ink)] break-all">{safeAddress}</code>
            <div className="flex flex-wrap gap-2 mt-4">
              <button
                onClick={copyAddress}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--v2-border-strong)] bg-white px-3 py-2 text-xs font-medium text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
              >
                {copied ? 'Copied' : 'Copy address'}
              </button>
              <a
                href={getExplorerUrl(safe.chain_id, 'address', safeAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--v2-border-strong)] bg-white px-3 py-2 text-xs font-medium text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
              >
                View on explorer
              </a>
              <button
                onClick={() => setShowQr((value) => !value)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--v2-brand)]/20 bg-[var(--v2-brand-soft)] px-3 py-2 text-xs font-medium text-[var(--v2-brand)] hover:bg-[var(--v2-brand-soft)] transition-colors"
              >
                {showQr ? 'Hide QR code' : 'Show QR code'}
              </button>
            </div>
          </div>

          {showQr && (
            <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4 flex flex-col items-center">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Deposit address QR code"
                  className="w-[220px] h-[220px] rounded-lg border border-[var(--v2-border)]"
                />
              ) : (
                <div className="w-[220px] h-[220px] rounded-lg bg-[var(--v2-surface-2)] animate-pulse" />
              )}
            </div>
          )}

          <div>
            <p className="text-[10px] text-[var(--v2-ink-3)] uppercase tracking-wide mb-2">
              Supported tokens on {chainConfig.name}
            </p>
            <div className="flex flex-wrap gap-2">
              {supportedTokens.map((token) => (
                <span
                  key={token.symbol}
                  className="rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] px-2 py-1 text-[11px] text-[var(--v2-ink-2)]"
                >
                  {token.symbol}
                </span>
              ))}
            </div>
          </div>

          <p className="text-xs text-[var(--v2-ink-3)]">
            Deposits arrive directly on-chain. Fiat on-ramp and guided funding will live under Add funds soon.
          </p>
        </div>
      </div>
    </div>
  )
}

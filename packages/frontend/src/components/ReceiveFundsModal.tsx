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
      color: { dark: '#ededed', light: '#0f0f12' },
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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg mx-4 rounded-xl border border-white/[0.08] bg-[#111113] shadow-2xl shadow-black/40 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Receive funds</h2>
            <p className="text-xs text-zinc-500 mt-1">
              Share this account&apos;s deposit address on {chainConfig.name}.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-medium text-zinc-100">{safe.name}</p>
              {safe.is_default && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-300">
                  default
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-500">{chainConfig.name}</p>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
            <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-2">Safe address</p>
            <code className="block text-sm text-zinc-200 break-all">{safeAddress}</code>
            <div className="flex flex-wrap gap-2 mt-4">
              <button
                onClick={copyAddress}
                className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-zinc-200 hover:bg-white/[0.06] transition-colors"
              >
                {copied ? 'Copied' : 'Copy address'}
              </button>
              <a
                href={getExplorerUrl(safe.chain_id, 'address', safeAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.06] transition-colors"
              >
                View on explorer
              </a>
              <button
                onClick={() => setShowQr((value) => !value)}
                className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500/25 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-300 hover:bg-indigo-500/15 transition-colors"
              >
                {showQr ? 'Hide QR code' : 'Show QR code'}
              </button>
            </div>
          </div>

          {showQr && (
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 flex flex-col items-center">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Deposit address QR code"
                  className="w-[220px] h-[220px] rounded-lg"
                />
              ) : (
                <div className="w-[220px] h-[220px] rounded-lg bg-white/[0.04] animate-pulse" />
              )}
            </div>
          )}

          <div>
            <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-2">
              Supported tokens on {chainConfig.name}
            </p>
            <div className="flex flex-wrap gap-2">
              {supportedTokens.map((token) => (
                <span
                  key={token.symbol}
                  className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-300"
                >
                  {token.symbol}
                </span>
              ))}
            </div>
          </div>

          <p className="text-xs text-zinc-500">
            Deposits arrive directly on-chain. Fiat on-ramp and guided funding will live under Add funds soon.
          </p>
        </div>
      </div>
    </div>
  )
}

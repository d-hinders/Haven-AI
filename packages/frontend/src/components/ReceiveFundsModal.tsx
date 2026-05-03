'use client'

import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import type { UserSafe } from '@/context/AuthContext'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'

interface Props {
  open: boolean
  onClose: () => void
  safes: UserSafe[]
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy address"
      className="inline-flex items-center justify-center p-2 rounded-lg border border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

export default function ReceiveFundsModal({ open, onClose, safes }: Props) {
  const defaultSafeId =
    safes.find((safe) => safe.is_default)?.id ??
    safes[0]?.id ??
    null

  const [qrSafeId, setQrSafeId] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  useEscapeToClose(open, onClose)

  useEffect(() => {
    if (!open) return
    setQrSafeId(null)
  }, [open, defaultSafeId])

  const qrSafe = useMemo(
    () => safes.find((safe) => safe.id === (qrSafeId ?? defaultSafeId)) ?? null,
    [defaultSafeId, qrSafeId, safes],
  )

  useEffect(() => {
    if (!open || !qrSafe?.safe_address || !qrSafeId) {
      setQrDataUrl(null)
      return
    }

    let cancelled = false
    QRCode.toDataURL(qrSafe.safe_address, {
      margin: 1,
      width: 240,
      color: { dark: '#ededed', light: '#121216' },
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
  }, [open, qrSafe?.safe_address, qrSafeId])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-2xl mx-4 bg-[#111113] border border-white/[0.08] rounded-2xl shadow-2xl shadow-black/40 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-base font-semibold text-[#ededed]">
              {qrSafeId ? 'Receive into this account' : 'Receive funds'}
            </h2>
            <p className="text-xs text-zinc-500 mt-1">
              {qrSafeId
                ? 'Share this Safe address or let someone scan the QR code.'
                : 'Choose which linked Safe account you want to receive into.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 -mr-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {safes.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <div className="w-12 h-12 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mx-auto mb-4 text-zinc-500">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15A2.25 2.25 0 0 0 2.25 6.75v10.5A2.25 2.25 0 0 0 4.5 19.5Z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-zinc-200">No linked accounts yet</p>
            <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto">
              Add a Safe account to Haven first, then you&apos;ll be able to copy its address or show a QR code here.
            </p>
          </div>
        ) : qrSafeId && qrSafe ? (
          <div className="px-6 py-6">
            <button
              type="button"
              onClick={() => setQrSafeId(null)}
              className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-5"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
              Back to accounts
            </button>

            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <p className="text-sm font-semibold text-zinc-100">{qrSafe.name}</p>
                {qrSafe.is_default && (
                  <span className="text-[10px] px-2 py-1 rounded-full bg-indigo-500/12 text-indigo-300 font-medium">
                    Default account
                  </span>
                )}
                <span className="text-[10px] px-2 py-1 rounded-full bg-white/[0.04] text-zinc-400 font-medium">
                  {getChainConfig(qrSafe.chain_id).name}
                </span>
              </div>

              <div className="grid gap-5 lg:grid-cols-[1fr_260px] lg:items-center">
                <div className="space-y-3">
                  <div className="rounded-xl border border-white/[0.06] bg-[#18181d] p-4">
                    <p className="text-[11px] uppercase tracking-wide text-zinc-600 mb-2">
                      Safe address
                    </p>
                    <div className="flex items-start gap-2">
                      <code className="flex-1 text-xs font-mono text-zinc-200 break-all">
                        {qrSafe.safe_address}
                      </code>
                      <CopyButton text={qrSafe.safe_address} />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <a
                      href={getExplorerUrl(qrSafe.chain_id, 'address', qrSafe.safe_address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-xs text-zinc-300 hover:bg-white/[0.05] transition-colors"
                    >
                      View on explorer
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                      </svg>
                    </a>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/[0.06] bg-[#121216] p-4 flex items-center justify-center min-h-[260px]">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={`${qrSafe.name} deposit address QR code`}
                      className="w-[220px] h-[220px] rounded-xl"
                    />
                  ) : (
                    <div className="text-center">
                      <div className="w-10 h-10 mx-auto rounded-full border-2 border-white/[0.08] border-t-indigo-500 animate-spin" />
                      <p className="text-xs text-zinc-500 mt-3">Preparing QR code...</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="px-6 py-6">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 mb-4">
              <p className="text-sm text-zinc-200">Your linked Safe accounts</p>
              <p className="text-xs text-zinc-500 mt-1">
                Copy any address instantly or open a QR code when someone needs to send funds to a specific account.
              </p>
            </div>

            <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
              {safes.map((safe) => {
                const chainName = getChainConfig(safe.chain_id).name
                return (
                  <div
                    key={safe.id}
                    className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                      <p className="text-sm font-semibold text-zinc-100">{safe.name}</p>
                      {safe.is_default && (
                        <span className="text-[10px] px-2 py-1 rounded-full bg-indigo-500/12 text-indigo-300 font-medium">
                          Default account
                        </span>
                      )}
                      <span className="text-[10px] px-2 py-1 rounded-full bg-white/[0.04] text-zinc-400 font-medium">
                        {chainName}
                      </span>
                    </div>

                    <div className="rounded-xl border border-white/[0.06] bg-[#18181d] px-3 py-3 mb-3">
                      <div className="flex items-start gap-2">
                        <code className="flex-1 text-xs font-mono text-zinc-200 break-all">
                          {safe.safe_address}
                        </code>
                        <CopyButton text={safe.safe_address} />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setQrSafeId(safe.id)}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-xs font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
                      >
                        Show QR code
                      </button>
                      <a
                        href={getExplorerUrl(safe.chain_id, 'address', safe.safe_address)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-xs text-zinc-300 hover:bg-white/[0.05] transition-colors"
                      >
                        View on explorer
                      </a>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

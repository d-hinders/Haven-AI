'use client'

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import type { UserSafe } from '@/context/AuthContext'

type Stage = 'fund' | 'add-agent'

interface Props {
  stage: Stage
  safes: UserSafe[]
  selectedSafeId: string | null
  onSelectSafe: (id: string) => void
  onAddAgent: () => void
  onDismiss: () => void
}

function StepTracker({ stage }: { stage: Stage }) {
  const steps = [
    { label: 'Account ready', state: 'done' as const },
    {
      label: 'Fund account',
      state: stage === 'fund' ? ('active' as const) : ('done' as const),
    },
    {
      label: 'Connect agent',
      state: stage === 'add-agent' ? ('active' as const) : ('todo' as const),
    },
  ]

  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Onboarding progress">
      {steps.map((step, index) => (
        <li key={step.label} className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold ${
                step.state === 'done'
                  ? 'border-emerald-500/20 bg-emerald-500/12 text-emerald-300'
                  : step.state === 'active'
                    ? 'border-indigo-400/30 bg-indigo-500 text-white shadow-[0_0_18px_rgba(99,102,241,0.3)]'
                    : 'border-white/[0.08] bg-white/[0.03] text-zinc-500'
              }`}
            >
              {step.state === 'done' ? (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                index + 1
              )}
            </span>
            <span
              className={`text-sm font-medium ${
                step.state === 'done'
                  ? 'text-zinc-200'
                  : step.state === 'active'
                    ? 'text-zinc-100'
                    : 'text-zinc-500'
              }`}
            >
              {step.label}
            </span>
          </div>
          {index < steps.length - 1 && (
            <div className="w-8 md:w-16">
              {step.state === 'done' ? (
                <div className="h-px bg-indigo-400/60" />
              ) : (
                <div className="border-t border-dashed border-white/[0.10]" />
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <button
      onClick={copy}
      title="Copy address"
      className="rounded p-1 text-zinc-500 transition-colors hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

function FundingPanel({
  safes,
  selectedSafeId,
  onSelectSafe,
}: {
  safes: UserSafe[]
  selectedSafeId: string | null
  onSelectSafe: (id: string) => void
}) {
  const safe = safes.find((entry) => entry.id === selectedSafeId) ?? safes[0] ?? null
  const chainConfig = safe ? getChainConfig(safe.chain_id) : null
  const tokens = chainConfig ? Object.values(chainConfig.tokens) : []

  const [showQr, setShowQr] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!safe?.safe_address || !showQr) {
      setQrDataUrl(null)
      return
    }

    let cancelled = false
    QRCode.toDataURL(safe.safe_address, {
      margin: 1,
      width: 160,
      color: { dark: '#ededed', light: '#0e0e0e' },
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
  }, [safe?.safe_address, showQr])

  useEffect(() => {
    setShowQr(false)
  }, [safe?.id])

  if (!safe || !chainConfig) return null

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr),220px] lg:items-start">
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 text-[30px] font-semibold leading-tight tracking-tight text-zinc-50 sm:text-[32px]">
            Add funds to start using Haven
          </h3>
          <p className="text-sm text-zinc-300">
            Send a supported token to your Haven account on{' '}
            <span className="text-zinc-100">{chainConfig.name}</span>.
          </p>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.22em] text-zinc-500">
            Account
          </p>
          {safes.length > 1 ? (
            <select
              value={safe.id}
              onChange={(e) => onSelectSafe(e.target.value)}
              className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm text-zinc-200 focus:outline-none focus:border-indigo-400/50"
            >
              {safes.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} — {getChainConfig(entry.chain_id).name}
                </option>
              ))}
            </select>
          ) : (
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm text-zinc-200">
              {safe.name} — {chainConfig.name}
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.22em] text-zinc-500">
            Deposit address
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
              <code className="min-w-0 flex-1 truncate text-xs text-zinc-100">
                {safe.safe_address}
              </code>
              <CopyButton text={safe.safe_address} />
              <a
                href={getExplorerUrl(safe.chain_id, 'address', safe.safe_address)}
                target="_blank"
                rel="noopener noreferrer"
                title="View on explorer"
                className="rounded p-1 text-zinc-500 transition-colors hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
              >
                <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </a>
            </div>

            <button
              onClick={() => setShowQr((value) => !value)}
              className="inline-flex items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/[0.06]"
            >
              {showQr ? 'Hide QR code' : 'Show QR code'}
            </button>
          </div>
        </div>

        {showQr && qrDataUrl && (
          <div className="w-fit rounded-xl border border-white/[0.08] bg-black/25 p-3">
            <img
              src={qrDataUrl}
              alt="Deposit address QR code"
              className="h-[128px] w-[128px] rounded-lg"
            />
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 lg:min-h-full lg:rounded-none lg:border-l lg:border-r-0 lg:border-y-0 lg:bg-transparent lg:py-1 lg:pl-5 lg:pr-0">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-zinc-300">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4z" />
                <path d="M9 10h6M9 14h6" />
              </svg>
            </div>
            <div>
              <p className="text-sm text-zinc-400">Network</p>
              <p className="mt-1 text-lg font-medium text-zinc-100">{chainConfig.name}</p>
            </div>
          </div>

          <div className="h-px bg-white/[0.06]" />

          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-zinc-300">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v10" />
                <path d="M15 9.5c0-1.38-1.34-2.5-3-2.5s-3 1.12-3 2.5 1.34 2.5 3 2.5 3 1.12 3 2.5-1.34 2.5-3 2.5-3-1.12-3-2.5" />
              </svg>
            </div>
            <div>
              <p className="text-sm text-zinc-400">Supported tokens</p>
              <p className="mt-1 text-lg font-medium text-zinc-100">
                {tokens.map((token) => token.symbol).join(', ')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function AddAgentPanel({
  onAddAgent,
}: {
  onAddAgent: () => void
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-50">
          Connect your first agent
        </h3>
        <p className="max-w-2xl text-sm text-zinc-300">
          Give an agent access to spend from your Haven account with clear limits
          that you control.
        </p>
      </div>

      <button
        onClick={onAddAgent}
        className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-4 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:from-indigo-400 hover:to-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Set up my first agent
      </button>
    </div>
  )
}

export default function DashboardOnboardingGuide({
  stage,
  safes,
  selectedSafeId,
  onSelectSafe,
  onAddAgent,
  onDismiss,
}: Props) {
  return (
    <div className="relative mb-6 overflow-hidden rounded-2xl border border-white/[0.06]">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(135deg, rgba(99,102,241,0.10) 0%, rgba(79,70,229,0.07) 42%, rgba(12,12,16,0.98) 100%)',
        }}
      />
      <div className="absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_top_right,rgba(129,140,248,0.18),transparent_58%)] pointer-events-none" />

      <div className="relative p-5">
        <div className="flex flex-col gap-4 border-b border-white/[0.06] pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <StepTracker stage={stage} />
          </div>

          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center gap-2 self-start rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white"
            aria-label="Dismiss onboarding guide"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            Dismiss
          </button>
        </div>

        <div className="pt-5">
          {stage === 'fund' && (
            <FundingPanel
              safes={safes}
              selectedSafeId={selectedSafeId}
              onSelectSafe={onSelectSafe}
            />
          )}
          {stage === 'add-agent' && <AddAgentPanel onAddAgent={onAddAgent} />}
        </div>
      </div>
    </div>
  )
}

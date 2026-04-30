'use client'

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import type { UserSafe } from '@/context/AuthContext'

type Stage = 'fund' | 'add-agent'

interface Props {
  stage: Stage
  safes: UserSafe[]
  /** The Safe to highlight in the funding panel. Caller picks default-or-first. */
  selectedSafeId: string | null
  onSelectSafe: (id: string) => void
  onAddAgent: () => void
  onAddDemoAgent: () => void
}

// ── Step tracker ───────────────────────────────────────────────────

function StepTracker({ stage }: { stage: Stage }) {
  const steps = [
    { label: 'Account created', state: 'done' as const },
    {
      label: 'Fund your wallet',
      state: stage === 'fund' ? ('active' as const) : ('done' as const),
    },
    {
      label: 'Add an agent',
      state: stage === 'add-agent' ? ('active' as const) : ('todo' as const),
    },
  ]

  return (
    <ol className="flex items-center gap-2 mb-5" aria-label="Onboarding progress">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-2">
          <div
            className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 ${
              s.state === 'done'
                ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                : s.state === 'active'
                  ? 'bg-indigo-500 text-white'
                  : 'bg-white/[0.04] text-zinc-700 border border-white/[0.06]'
            }`}
          >
            {s.state === 'done' ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              i + 1
            )}
          </div>
          <span
            className={`text-[11px] font-medium ${
              s.state === 'done'
                ? 'text-zinc-500'
                : s.state === 'active'
                  ? 'text-zinc-200'
                  : 'text-zinc-600'
            }`}
          >
            {s.label}
          </span>
          {i < steps.length - 1 && (
            <div className="w-6 h-px bg-white/[0.06] mx-1" />
          )}
        </li>
      ))}
    </ol>
  )
}

// ── Inline copy button ────────────────────────────────────────────

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
      className="text-zinc-500 hover:text-zinc-200 transition-colors p-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400 animate-check-pop">
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

// ── Funding panel ─────────────────────────────────────────────────

function FundingPanel({
  safes,
  selectedSafeId,
  onSelectSafe,
}: {
  safes: UserSafe[]
  selectedSafeId: string | null
  onSelectSafe: (id: string) => void
}) {
  const safe = safes.find((s) => s.id === selectedSafeId) ?? safes[0] ?? null
  const chainConfig = safe ? getChainConfig(safe.chain_id) : null
  const tokens = chainConfig ? Object.values(chainConfig.tokens) : []

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!safe?.safe_address) {
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
  }, [safe?.safe_address])

  if (!safe || !chainConfig) return null

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100 mb-1">
          Fund your wallet
        </h3>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Send any of the supported tokens below to your Safe address on{' '}
          <span className="text-zinc-200 font-medium">{chainConfig.name}</span>. Once it
          arrives, your balance will update.
        </p>
      </div>

      {/* Multi-safe selector */}
      {safes.length > 1 && (
        <div>
          <label className="block text-[10px] text-zinc-600 uppercase tracking-wide mb-1">
            Deposit into
          </label>
          <select
            value={safe.id}
            onChange={(e) => onSelectSafe(e.target.value)}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500/50"
          >
            {safes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {getChainConfig(s.chain_id).name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Address row + QR */}
      <div className="flex items-start gap-4 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
        {qrDataUrl && (
          <img
            src={qrDataUrl}
            alt="Deposit address QR code"
            className="w-[120px] h-[120px] rounded-lg flex-shrink-0 hidden sm:block"
          />
        )}
        <div className="flex-1 min-w-0 space-y-2">
          <div>
            <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-1">
              Safe address
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono text-zinc-200 break-all sm:break-normal sm:truncate">
                {safe.safe_address}
              </code>
              <CopyButton text={safe.safe_address} />
              <a
                href={getExplorerUrl(safe.chain_id, 'address', safe.safe_address)}
                target="_blank"
                rel="noopener noreferrer"
                title="View on explorer"
                className="text-zinc-500 hover:text-zinc-200 transition-colors p-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
              >
                <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </a>
            </div>
          </div>
          <div>
            <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-1.5">
              Supported tokens on {chainConfig.name}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {tokens.map((t) => (
                <span
                  key={t.symbol}
                  className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06] text-zinc-300"
                >
                  {t.symbol}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <p className="text-[10px] text-zinc-600 leading-relaxed">
        Deposits arrive directly on-chain. Bridging and on-ramps are coming soon.
      </p>
    </div>
  )
}

// ── Add-agent panel ───────────────────────────────────────────────

function AddAgentPanel({
  onAddAgent,
  onAddDemoAgent,
}: {
  onAddAgent: () => void
  onAddDemoAgent: () => void
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100 mb-1">
          Add your first agent
        </h3>
        <p className="text-xs text-zinc-400 leading-relaxed max-w-xl">
          Issue payment credentials and on-chain spending limits, then hand them off
          to your agent so it can spend from your Safe within the rules you set.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onAddAgent}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Connect agent
        </button>
        <button
          onClick={onAddDemoAgent}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-zinc-300 text-sm font-medium hover:bg-white/[0.05] hover:text-zinc-100 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          Spin up a demo agent
        </button>
      </div>
    </div>
  )
}

// ── Main guide ────────────────────────────────────────────────────

export default function DashboardOnboardingGuide({
  stage,
  safes,
  selectedSafeId,
  onSelectSafe,
  onAddAgent,
  onAddDemoAgent,
}: Props) {
  return (
    <div className="p-5 mb-6 rounded-xl bg-gradient-to-br from-indigo-500/[0.08] to-violet-500/[0.06] border border-indigo-500/20">
      <StepTracker stage={stage} />
      {stage === 'fund' && (
        <FundingPanel
          safes={safes}
          selectedSafeId={selectedSafeId}
          onSelectSafe={onSelectSafe}
        />
      )}
      {stage === 'add-agent' && (
        <AddAgentPanel
          onAddAgent={onAddAgent}
          onAddDemoAgent={onAddDemoAgent}
        />
      )}
    </div>
  )
}

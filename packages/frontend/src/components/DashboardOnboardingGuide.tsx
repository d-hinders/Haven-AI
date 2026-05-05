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
  onDismiss: () => void
}

// ── Step tracker ───────────────────────────────────────────────────

function StepTracker({ stage }: { stage: Stage }) {
  const steps = [
    { label: 'Account ready', state: 'done' as const },
    {
      label: 'Add funds',
      state: stage === 'fund' ? ('active' as const) : ('done' as const),
    },
    {
      label: 'Connect agent',
      state: stage === 'add-agent' ? ('active' as const) : ('todo' as const),
    },
  ]

  return (
    <ol className="flex flex-wrap items-center gap-2.5" aria-label="Onboarding progress">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-2">
          <div
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${
              s.state === 'done'
                ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                : s.state === 'active'
                  ? 'border-indigo-400/30 bg-indigo-500/15 text-white'
                  : 'border-white/[0.08] bg-white/[0.03] text-zinc-500'
            }`}
          >
            <span
              className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                s.state === 'done'
                  ? 'bg-emerald-400/15 text-emerald-300'
                  : s.state === 'active'
                    ? 'bg-indigo-400 text-white'
                    : 'bg-white/[0.05] text-zinc-500'
              }`}
            >
              {s.state === 'done' ? (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                i + 1
              )}
            </span>
            <span
              className={`text-[11px] font-medium ${
                s.state === 'done'
                  ? 'text-emerald-200'
                  : s.state === 'active'
                    ? 'text-zinc-100'
                    : 'text-zinc-500'
              }`}
            >
              {s.label}
            </span>
          </div>
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
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-zinc-50 mb-2">
          Add funds to start using Haven
        </h3>
        <p className="max-w-2xl text-sm text-zinc-300 leading-relaxed">
          Send a supported token to your Haven account on{' '}
          <span className="text-zinc-100 font-medium">{chainConfig.name}</span>. As soon as the
          deposit lands, you can send payments and start connecting agents.
        </p>
      </div>

      {safes.length > 1 && (
        <div>
          <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
            Account to fund
          </label>
          <select
            value={safe.id}
            onChange={(e) => onSelectSafe(e.target.value)}
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 focus:outline-none focus:border-indigo-400/50"
          >
            {safes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {getChainConfig(s.chain_id).name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr),minmax(0,1fr)]">
        <div className="rounded-2xl border border-white/[0.08] bg-black/20 p-4 sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {showQr && qrDataUrl && (
              <img
                src={qrDataUrl}
                alt="Deposit address QR code"
                className="h-[120px] w-[120px] rounded-xl border border-white/[0.08] bg-black/30 p-2"
              />
            )}
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-indigo-400/20 bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-200">
                  {chainConfig.name}
                </span>
                <span className="inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-zinc-300">
                  {safe.name}
                </span>
              </div>

              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                  Your Haven account address
                </p>
                <div className="flex items-start gap-2">
                  <code className="flex-1 break-all rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-3 text-xs text-zinc-100">
                    {safe.safe_address}
                  </code>
                  <div className="flex items-center gap-1">
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
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setShowQr((value) => !value)}
                  className="inline-flex items-center justify-center rounded-xl border border-indigo-400/20 bg-indigo-500/10 px-3 py-2 text-sm font-medium text-indigo-200 hover:bg-indigo-500/15 transition-colors"
                >
                  {showQr ? 'Hide QR code' : 'Show QR code'}
                </button>
                <p className="text-xs text-zinc-500">
                  Copy the address into your wallet or exchange withdrawal flow.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 sm:p-5">
          <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
            Quick guide
          </p>
          <div className="space-y-3">
            <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3">
              <p className="text-sm font-medium text-zinc-100">Use the same network</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                Send funds on <span className="text-zinc-200">{chainConfig.name}</span> so they
                arrive in this account.
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3">
              <p className="text-sm font-medium text-zinc-100">Supported tokens</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {tokens.map((t) => (
                  <span
                    key={t.symbol}
                    className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-300"
                  >
                    {t.symbol}
                  </span>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3">
              <p className="text-sm font-medium text-zinc-100">What happens next</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                Your balance updates automatically after the transfer confirms on-chain.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Add-agent panel ───────────────────────────────────────────────

function AddAgentPanel({
  onAddAgent,
}: {
  onAddAgent: () => void
}) {
  const highlights = [
    {
      title: 'Stay in control',
      body: 'You choose which account the agent can use and how much it can spend.',
    },
    {
      title: 'Start small',
      body: 'Begin with a tight limit for one token, then expand once you are comfortable.',
    },
    {
      title: 'Change it anytime',
      body: 'Pause, edit, or revoke access later from the Agents page.',
    },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-zinc-50 mb-2">
          Connect your first agent
        </h3>
        <p className="max-w-2xl text-sm text-zinc-300 leading-relaxed">
          Give your agent access to spend from your Haven account with clear rules.
          You will pick the token, the budget, and how often that limit resets
          before anything can spend.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {highlights.map((item) => (
          <div
            key={item.title}
            className="rounded-2xl border border-white/[0.08] bg-black/20 p-4"
          >
            <p className="text-sm font-medium text-zinc-100">{item.title}</p>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">{item.body}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onAddAgent}
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Set up my first agent
        </button>
        <p className="text-xs text-zinc-500">
          A good first setup is one small allowance for a single workflow.
        </p>
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
  onDismiss,
}: Props) {
  return (
    <div className="relative mb-6 overflow-hidden rounded-2xl border border-white/[0.06]">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(135deg, rgba(99,102,241,0.12) 0%, rgba(79,70,229,0.08) 35%, rgba(12,12,16,0.96) 100%)',
        }}
      />
      <div className="absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_top_right,rgba(129,140,248,0.22),transparent_58%)] pointer-events-none" />

      <div className="relative p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-3">
            <span className="inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.05] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-300">
              Getting started
            </span>
            <StepTracker stage={stage} />
          </div>

          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center gap-2 self-start rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white"
            aria-label="Dismiss onboarding guide"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            Dismiss
          </button>
        </div>

        <div className="mt-5">
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
            />
          )}
        </div>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { getChainConfig } from '@/lib/chains'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import type { UserSafe } from '@/context/AuthContext'

type Stage = 'fund' | 'add-agent'

interface Props {
  stage: Stage
  safes: UserSafe[]
  onAddAgent: () => void
  onDismiss: () => void
}

function getDefaultSafe(safes: UserSafe[]): UserSafe | null {
  return safes.find((entry) => entry.is_default) ?? safes[0] ?? null
}

function compactAddress(address: string): string {
  if (address.length <= 18) return address
  return `${address.slice(0, 8)}...${address.slice(-6)}`
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
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Onboarding progress">
      {steps.map((step, index) => (
        <li key={step.label} className="flex items-center gap-1.5">
          <div className="flex items-center gap-1.5">
            <span
              className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
                step.state === 'done'
                  ? 'border-emerald-500/20 bg-emerald-500/12 text-emerald-300'
                  : step.state === 'active'
                    ? 'border-indigo-400/30 bg-indigo-500 text-white shadow-[0_0_18px_rgba(99,102,241,0.3)]'
                    : 'border-[var(--v2-border)] bg-[var(--v2-surface)] text-[var(--v2-ink-3)]'
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
              className={`text-[12px] font-medium ${
                step.state === 'done'
                  ? 'text-[var(--v2-ink)]'
                  : step.state === 'active'
                    ? 'text-[var(--v2-ink)]'
                    : 'text-[var(--v2-ink-3)]'
              }`}
            >
              {step.label}
            </span>
          </div>
          {index < steps.length - 1 && (
            <div className="w-5 md:w-10">
              {step.state === 'done' ? (
                <div className="h-px bg-indigo-400/60" />
              ) : (
                <div className="border-t border-dashed border-[var(--v2-border-strong)]" />
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
      type="button"
      onClick={copy}
      aria-label="Copy deposit address"
      title="Copy deposit address"
      className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--v2-border-strong)] bg-white text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-button)] transition-colors hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
    >
      {copied ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--v2-success)]">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

function FundingPanel({
  safes,
}: {
  safes: UserSafe[]
}) {
  const defaultSafe = getDefaultSafe(safes)
  const [selectedSafeId, setSelectedSafeId] = useState(defaultSafe?.id ?? '')
  const safe = safes.find((entry) => entry.id === selectedSafeId) ?? defaultSafe
  const chainConfig = safe ? getChainConfig(safe.chain_id) : null
  const tokens = chainConfig ? Object.values(chainConfig.tokens) : []

  const [showQr, setShowQr] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  useEscapeToClose(showQr, () => setShowQr(false))

  useEffect(() => {
    if (!safe?.safe_address || !showQr) {
      setQrDataUrl(null)
      return
    }

    let cancelled = false
    QRCode.toDataURL(safe.safe_address, {
      margin: 1,
      width: 280,
      color: { dark: '#171A2F', light: '#FFFFFF' },
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

  useEffect(() => {
    if (!defaultSafe) return
    if (selectedSafeId && safes.some((entry) => entry.id === selectedSafeId)) return
    setSelectedSafeId(defaultSafe.id)
  }, [defaultSafe, safes, selectedSafeId])

  if (!safe || !chainConfig) return null

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[minmax(270px,0.55fr)_minmax(520px,1fr)_220px] lg:items-center">
      <div>
        <h3 className="mb-4 text-[30px] font-semibold leading-[1.14] tracking-tight text-[var(--v2-ink)] sm:text-[34px]">
          Add funds to start using Haven
        </h3>
        <p className="max-w-[280px] text-[15px] leading-relaxed text-[var(--v2-ink-2)]">
          Send a supported token to your Haven account on{' '}
          <span className="font-semibold text-[var(--v2-ink)]">{chainConfig.name}</span>.
        </p>
      </div>

      <div className="space-y-3">
        <div className="grid overflow-hidden rounded-xl border border-[var(--v2-border-strong)] bg-white shadow-[0_10px_28px_rgba(16,24,40,0.06),var(--v2-shadow-card)] sm:grid-cols-[minmax(190px,0.72fr)_minmax(0,1fr)_auto] sm:items-stretch">
          <div className="min-w-0 px-5 py-6">
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--v2-ink-3)]">
              Account
            </p>
            {safes.length > 1 ? (
              <div className="relative mt-3">
                <select
                  value={safe.id}
                  onChange={(event) => setSelectedSafeId(event.target.value)}
                  className="w-full min-w-0 cursor-pointer appearance-none bg-transparent pr-6 text-[15px] font-semibold text-[var(--v2-ink)] outline-none"
                >
                  {safes.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--v2-ink-2)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
                </svg>
              </div>
            ) : (
              <p className="mt-3 truncate text-[15px] font-semibold text-[var(--v2-ink)]">{safe.name}</p>
            )}
          </div>

          <div className="min-w-0 border-t border-[var(--v2-border)] px-5 py-6 sm:border-l sm:border-t-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--v2-ink-3)]">
              Address
            </p>
            <div className="mt-3 flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(safe.safe_address)}
                title="Copy deposit address"
                className="min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
              >
                <code className="block truncate text-[15px] font-semibold text-[var(--v2-ink)]">
                  {compactAddress(safe.safe_address)}
                </code>
              </button>
              <CopyButton text={safe.safe_address} />
            </div>
          </div>

          <div className="flex border-t border-[var(--v2-border)] p-5 sm:border-l sm:border-t-0 sm:items-center">
            <button
              type="button"
              onClick={() => setShowQr(true)}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-[var(--v2-border-strong)] bg-white px-4 text-[14px] font-semibold text-[var(--v2-ink)] shadow-[var(--v2-shadow-button)] transition-colors hover:bg-[var(--v2-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
            >
              <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h2m4 0h-1m-5 3h6m-6 3h2m4 0h-1" />
              </svg>
              QR Code
            </button>
          </div>
        </div>
      </div>

      <div className="border-t border-[var(--v2-border)] pt-4 lg:min-h-full lg:border-l lg:border-t-0 lg:py-2 lg:pl-6">
        <div className="space-y-5">
          <div className="flex items-start gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface)] text-[var(--v2-ink)] shadow-[var(--v2-shadow-card)]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4z" />
                <path d="M9 10h6M9 14h6" />
              </svg>
            </div>
            <div>
              <p className="text-[13px] text-[var(--v2-ink-2)]">Network</p>
              <p className="mt-1 text-[15px] font-semibold text-[var(--v2-ink)]">{chainConfig.name}</p>
            </div>
          </div>

          <div className="h-px bg-[var(--v2-surface-2)]" />

          <div className="flex items-start gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface)] text-[var(--v2-ink)] shadow-[var(--v2-shadow-card)]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v10" />
                <path d="M15 9.5c0-1.38-1.34-2.5-3-2.5s-3 1.12-3 2.5 1.34 2.5 3 2.5 3 1.12 3 2.5-1.34 2.5-3 2.5-3-1.12-3-2.5" />
              </svg>
            </div>
            <div>
              <p className="text-[13px] text-[var(--v2-ink-2)]">Supported tokens</p>
              <p className="mt-1 text-[15px] font-semibold text-[var(--v2-ink)]">
                {tokens.map((token) => token.symbol).join(', ')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
    {showQr && (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="funding-qr-title"
        className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      >
        <div
          className="absolute inset-0 bg-[var(--v2-ink)]/50 backdrop-blur-sm"
          onClick={() => setShowQr(false)}
        />
        <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]">
          <div className="flex items-center justify-between border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-6 py-4">
            <div className="min-w-0">
              <h2 id="funding-qr-title" className="text-base font-semibold text-[var(--v2-ink)]">
                Deposit QR code
              </h2>
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                Scan to fund {safe.name} on {chainConfig.name}.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowQr(false)}
              aria-label="Close QR code"
              className="rounded-md p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex flex-col items-center px-6 py-6">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="Deposit address QR code"
                className="h-[280px] w-[280px] rounded-xl border border-[var(--v2-border)] bg-white p-2"
              />
            ) : (
              <div className="h-[280px] w-[280px] animate-pulse rounded-xl bg-[var(--v2-surface-2)]" />
            )}
            <div className="mt-4 flex max-w-full items-start gap-2 rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
              <code className="min-w-0 flex-1 break-all text-xs leading-relaxed text-[var(--v2-ink-2)]">
                {safe.safe_address}
              </code>
              <CopyButton text={safe.safe_address} />
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

function AddAgentPanel({
  onAddAgent,
}: {
  onAddAgent: () => void
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="mb-1.5 text-xl font-semibold tracking-tight text-[var(--v2-ink)]">
          Connect your first agent
        </h3>
        <p className="max-w-2xl text-[13px] text-[var(--v2-ink-2)]">
          Give an agent access to spend from your Haven account with clear limits
          that you control.
        </p>
      </div>

      <button
        onClick={onAddAgent}
        className="inline-flex items-center gap-2 rounded-xl bg-[var(--v2-brand)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--v2-brand-strong)] shadow-[var(--v2-shadow-button)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
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
  onAddAgent,
  onDismiss,
}: Props) {
  return (
    <div className="relative mb-6 overflow-hidden rounded-2xl border border-[#CFE7FF]">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(90deg, #F2F8FF 0%, #EAF6FF 52%, #F5FCFF 100%)',
        }}
      />
      <div className="absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.22),transparent_58%)] pointer-events-none" />

      <div className="relative p-4">
        <div className="flex flex-col gap-3 border-b border-[#CFE7FF] pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <StepTracker stage={stage} />
          </div>

          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center gap-2 self-start rounded-full border border-[var(--v2-border)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--v2-ink-2)] transition-colors hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)]"
            aria-label="Dismiss onboarding guide"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            Dismiss
          </button>
        </div>

        <div className="pt-4">
          {stage === 'fund' && (
            <FundingPanel
              safes={safes}
            />
          )}
          {stage === 'add-agent' && <AddAgentPanel onAddAgent={onAddAgent} />}
        </div>
      </div>
    </div>
  )
}

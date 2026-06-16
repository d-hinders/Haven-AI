'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { PageHeader } from '@/components/ui/PageHeader'

interface DelegateBalance {
  delegate_address: string
  safe_address: string | null
  chain_id: number
  eth: string
  eth_atomic: string
  usdc: string
  usdc_atomic: string
  usdc_address: string | null
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])

  return (
    <button
      onClick={copy}
      className="ml-2 inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)] hover:bg-[var(--v2-border)] transition-colors"
    >
      {copied ? (
        <>
          <svg className="h-3 w-3 text-[var(--v2-success)]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 8l3.5 3.5L13 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <rect x="5" y="5" width="8" height="8" rx="1" />
            <path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" />
          </svg>
          Copy
        </>
      )}
    </button>
  )
}

export default function SweepClient({ agentId }: { agentId: string }) {
  const [balance, setBalance] = useState<DelegateBalance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get<DelegateBalance>(`/agents/${agentId}/delegate-balance`)
      .then(setBalance)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load delegate balance.'))
      .finally(() => setLoading(false))
  }, [agentId])

  const hasUsdc = balance && balance.usdc_atomic !== '0'
  const hasEth = balance && balance.eth_atomic !== '0'

  const sweepCommand = `haven_sweep_delegate`

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Recover funds"
        subtitle="Move funds left in your agent's wallet back to your Haven wallet."
      />

      <div className="mt-1 mb-6">
        <Link
          href={`/agents/${agentId}`}
          className="inline-flex items-center gap-1.5 text-sm text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] transition-colors"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M10 4L6 8l4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to agent
        </Link>
      </div>

      {loading ? (
        <Card>
          <div className="px-6 py-8 text-center text-sm text-[var(--v2-ink-3)]">
            Checking delegate balance…
          </div>
        </Card>
      ) : error ? (
        <Card>
          <div className="px-6 py-6">
            <p className="text-sm font-medium text-[var(--v2-danger)]">Could not load balance</p>
            <p className="mt-1 text-sm text-[var(--v2-ink-3)]">{error}</p>
          </div>
        </Card>
      ) : !hasUsdc ? (
        <Card>
          <div className="px-6 py-8 text-center">
            <p className="text-sm font-medium text-[var(--v2-ink)]">No recoverable funds</p>
            <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
              {hasEth
                ? `Your agent's wallet holds ${balance!.eth} ETH but no USDC. The one-click recovery tool returns USDC only — ETH can't be recovered this way.`
                : 'Your agent\'s wallet holds no USDC. Nothing to recover.'}
            </p>
            <div className="mt-4">
              <Button href={`/agents/${agentId}`} variant="ghost" size="sm">
                Back to agent
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <div className="px-6 py-5">
              <h2 className="text-sm font-semibold text-[var(--v2-ink)] mb-4">Recoverable balance</h2>

              <div className="space-y-2">
                <div className="flex items-center justify-between py-2 border-b border-[var(--v2-border)]">
                  <span className="text-sm text-[var(--v2-ink-2)]">USDC</span>
                  <span className="text-sm font-medium text-[var(--v2-ink)]">{balance!.usdc}</span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-[var(--v2-ink-3)]">Goes to your Haven wallet</span>
                  <span className="text-sm text-[var(--v2-ink-2)] font-mono text-right truncate max-w-[240px]">
                    {balance!.safe_address ?? 'Your Haven wallet'}
                  </span>
                </div>
              </div>

              {hasEth && (
                <p className="mt-3 text-xs text-[var(--v2-ink-3)]">
                  The wallet also holds {balance!.eth} ETH. This recovery returns USDC only; ETH stays on the wallet.
                </p>
              )}
            </div>
          </Card>

          <Card elevation="anchor">
            <div className="px-6 py-5">
              <h2 className="text-sm font-semibold text-[var(--v2-ink)] mb-2">How to recover</h2>
              <p className="text-sm text-[var(--v2-ink-2)] mb-4">
                Only your agent can do this, because only it holds the signing key.
                Tell your agent to run this tool — it signs the transfer and Haven covers the gas,
                so the funds come straight back to your Haven wallet.
              </p>

              <div className="rounded-lg bg-[var(--v2-surface-2)] px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-[var(--v2-ink-3)]">MCP tool call</span>
                  <CopyButton text={sweepCommand} />
                </div>
                <code className="text-sm text-[var(--v2-ink)] font-mono">{sweepCommand}</code>
              </div>

              <div className="mt-4 rounded-lg bg-[var(--v2-surface-2)] px-4 py-3">
                <p className="text-xs font-medium text-[var(--v2-ink-3)] mb-1">Or tell your agent in plain language:</p>
                <p className="text-sm text-[var(--v2-ink-2)] italic">
                  &quot;Sweep any stranded funds from the delegate wallet back to my Safe.&quot;
                </p>
              </div>

              <div className="mt-4 rounded-lg border border-[var(--v2-border)] px-4 py-3">
                <p className="text-xs text-[var(--v2-ink-3)]">
                  <strong className="text-[var(--v2-ink-2)]">Why does my agent do this, not Haven?</strong>{' '}
                  The delegate signing key exists only in your agent&apos;s runtime — Haven never holds it.
                  This is by design (MiCA/CASP compliance): Haven cannot construct signed transactions on your behalf.
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

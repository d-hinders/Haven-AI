'use client'

import { Check, ChevronLeft, Copy } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAgents } from '@/hooks/useAgents'
import { resolveChainOrNull } from '@/lib/chains'
import { usdcSweepStatus } from '@/lib/sweep-eligibility'

type DelegateBalance = ApiSchema<'DelegateBalance'>

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])

  return (
    <Button type="button" variant="tertiary" size="sm" onClick={copy} aria-label="Copy recovery tool name">
      {copied ? (
        <>
          <Icon icon={Check} className="h-3 w-3 text-[var(--v2-success)]" />
          Copied
        </>
      ) : (
        <>
          <Icon icon={Copy} className="h-3 w-3" />
          Copy
        </>
      )}
    </Button>
  )
}

export default function SweepClient({ agentId }: { agentId: string }) {
  const { agents } = useAgents()
  const agent = agents.find((item) => item.id === agentId)
  const [balance, setBalance] = useState<DelegateBalance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestGeneration = useRef(0)

  const loadBalance = useCallback(() => {
    const generation = ++requestGeneration.current
    // Clear the previous agent's result before starting the next request, and
    // Ignore late responses from a superseded route with a generation guard.
    // Without both guards, navigation can briefly show one agent's balance
    // under another agent's name and destination.
    setBalance(null)
    setError(null)
    setLoading(true)

    api
      .get<DelegateBalance>(`/agents/${agentId}/delegate-balance`)
      .then((data) => {
        if (generation === requestGeneration.current) setBalance(data)
      })
      .catch(() => {
        if (generation === requestGeneration.current) {
          setError("We couldn't check this agent's wallet right now. Please try again.")
        }
      })
      .finally(() => {
        if (generation === requestGeneration.current) setLoading(false)
      })
  }, [agentId])

  useEffect(() => {
    void loadBalance()
    return () => {
      requestGeneration.current += 1
    }
  }, [loadBalance])

  const usdcStatus = balance ? usdcSweepStatus(balance) : 'none'
  const hasVerifiedDestination = Boolean(balance?.safe_address)
  const hasUsdc = usdcStatus === 'recoverable' && hasVerifiedDestination
  const hasEth = Boolean(balance && balance.eth_atomic !== '0')
  const network = balance
    ? resolveChainOrNull(balance.chain_id)?.name ?? `Chain ${balance.chain_id}`
    : null
  const agentLabel = agent?.name ?? 'Your agent'
  const destination = balance?.safe_address
  const pageSubtitle =
    balance && !hasVerifiedDestination
      ? `${agentLabel} · ${network ?? `Chain ${balance.chain_id}`}. Recovery is unavailable without a verified Haven wallet.`
      : network
        ? `${agentLabel} · ${network}. Move eligible funds back to your Haven wallet.`
        : "Move eligible funds left in your agent's wallet back to your Haven wallet."

  const sweepCommand = `haven_sweep_delegate`

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Recover funds"
        subtitle={pageSubtitle}
      />

      <div className="mt-1 mb-6">
        <Button href={`/agents/${agentId}`} variant="tertiary" size="sm" className="-ml-3">
          <Icon icon={ChevronLeft} className="h-3.5 w-3.5" />
          Back to agent
        </Button>
      </div>

      {loading ? (
        <Card>
          <div
            role="status"
            aria-busy="true"
            aria-label="Checking recovery balance"
            className="px-6 py-8"
          >
            <div className="space-y-3">
              <p className="text-center text-sm text-[var(--v2-ink-3)]">Checking recovery balance…</p>
              <Skeleton variant="text" className="mx-auto h-3 w-3/4 max-w-md" />
              <Skeleton className="mx-auto h-9 w-28" />
            </div>
          </div>
        </Card>
      ) : error ? (
        <Card>
          <div role="alert" className="px-6 py-6">
            <p className="text-sm font-medium text-[var(--v2-danger)]">
              Could not load recovery balance
            </p>
            <p className="mt-1 text-sm text-[var(--v2-ink-3)]">{error}</p>
            <div className="mt-4">
              <Button type="button" variant="ghost" size="sm" onClick={() => void loadBalance()}>
                Try again
              </Button>
            </div>
          </div>
        </Card>
      ) : balance && !hasVerifiedDestination ? (
        <Card>
          <div className="px-6 py-8 text-center">
            <p className="text-sm font-medium text-[var(--v2-ink)]">Recovery unavailable</p>
            <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
              This agent is no longer linked to a Haven wallet, so the recovery destination cannot be verified. No recovery action is available.
            </p>
            <div className="mt-4">
              <Button href={`/agents/${agentId}`} variant="ghost" size="sm">
                Back to agent
              </Button>
            </div>
          </div>
        </Card>
      ) : usdcStatus === 'below_minimum' && balance ? (
        <Card>
          <div className="px-6 py-8 text-center">
            <p className="text-sm font-medium text-[var(--v2-ink)]">Recovery minimum not met</p>
            <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
              {agentLabel}&apos;s wallet holds {balance.usdc} USDC on {network ?? `Chain ${balance.chain_id}`}, below the {balance.sweep_min_usdc} USDC recovery minimum. No recovery action is available until the balance reaches the minimum.
            </p>
            <div className="mt-4">
              <Button href={`/agents/${agentId}`} variant="ghost" size="sm">
                Back to agent
              </Button>
            </div>
          </div>
        </Card>
      ) : usdcStatus === 'unknown' && balance ? (
        <Card>
          <div className="px-6 py-8 text-center">
            <p className="text-sm font-medium text-[var(--v2-ink)]">Recovery minimum could not be verified</p>
            <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
              We could not verify whether {agentLabel}&apos;s USDC balance is eligible for recovery. No recovery action is available right now.
            </p>
            <div className="mt-4">
              <Button href={`/agents/${agentId}`} variant="ghost" size="sm">
                Back to agent
              </Button>
            </div>
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
              <p className="mb-3 text-xs text-[var(--v2-ink-3)]">{agentLabel} · {network ?? `Chain ${balance!.chain_id}`}</p>

              <div className="space-y-2">
                <div className="flex items-center justify-between py-2 border-b border-[var(--v2-border)]">
                  <span className="text-sm text-[var(--v2-ink-2)]">USDC</span>
                  <span className="text-sm font-medium text-[var(--v2-ink)]">{balance!.usdc}</span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-[var(--v2-ink-3)]">Goes to your Haven wallet</span>
                  <span className="text-sm text-[var(--v2-ink-2)] font-mono text-right truncate max-w-[240px]">
                    {destination!}
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
                  &quot;Sweep any stranded funds from the delegate wallet back to my Haven wallet.&quot;
                </p>
              </div>

              <div className="mt-4 rounded-lg border border-[var(--v2-border)] px-4 py-3">
                <p className="text-xs text-[var(--v2-ink-3)]">
                  <strong className="text-[var(--v2-ink-2)]">Why does my agent do this, not Haven?</strong>{' '}
                  The delegate signing key exists only in your agent&apos;s runtime — Haven never holds it,
                  so Haven cannot construct signed transactions on your behalf.
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { useAuth } from '@/context/AuthContext'
import { useAgents } from '@/hooks/useAgents'
import { useAgentActivity } from '@/hooks/useAgentActivity'
import { RESET_PERIODS } from '@/lib/allowance-module'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import { truncate, timeAgo } from '@/lib/format'

function statusLabel(status: string): string {
  if (status === 'active') return 'Connected'
  if (status === 'paused') return 'Paused'
  if (status === 'revoked') return 'Revoked'
  return status
}

function statusClasses(status: string): string {
  if (status === 'active') return 'bg-emerald-500/10 text-emerald-400'
  if (status === 'paused') return 'bg-amber-500/10 text-amber-300'
  if (status === 'revoked') return 'bg-red-500/10 text-red-300'
  return 'bg-white/[0.06] text-zinc-500'
}

function formatAllowanceAmount(amount: string, decimals: number): string {
  try {
    const raw = BigInt(amount)
    const divisor = 10n ** BigInt(decimals)
    const whole = raw / divisor
    const fraction = raw % divisor
    const fractionText = fraction
      .toString()
      .padStart(decimals, '0')
      .slice(0, 4)
      .replace(/0+$/, '')

    return fractionText ? `${whole}.${fractionText}` : whole.toString()
  } catch {
    return amount
  }
}

function resetLabel(resetPeriodMin: number): string {
  return RESET_PERIODS.find((item) => item.value === resetPeriodMin)?.label ?? `${resetPeriodMin}m`
}

function StatBlock({
  label,
  value,
  helper,
}: {
  label: string
  value: string
  helper?: string
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <p className="text-xs uppercase tracking-wide text-zinc-600">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-zinc-100">{value}</p>
      {helper ? <p className="mt-2 text-xs text-zinc-500">{helper}</p> : null}
    </div>
  )
}

interface Props {
  agentId: string
}

export default function AgentDetailClient({ agentId }: Props) {
  const { user } = useAuth()
  const { agents, loading } = useAgents()
  const agent = agents.find((item) => item.id === agentId) ?? null
  const safe = useMemo(
    () => user?.safes.find((item) => item.id === agent?.safe_id) ?? null,
    [agent?.safe_id, user?.safes],
  )
  const chainConfig = safe ? getChainConfig(safe.chain_id) : null
  const { activity, stats, loading: activityLoading } = useAgentActivity(agent?.id ?? null)

  if (loading) {
    return (
      <div className="max-w-5xl">
        <div className="space-y-4">
          <div className="h-6 w-40 rounded bg-white/[0.06] animate-pulse" />
          <div className="h-24 rounded-xl bg-white/[0.04] animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-28 rounded-xl bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="max-w-3xl">
        <Link href="/agents" className="text-sm font-medium text-indigo-300 hover:text-indigo-200 transition-colors">
          ← Back to Agents
        </Link>
        <div className="mt-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-8 text-center">
          <h1 className="text-xl font-semibold text-zinc-100">Agent not found</h1>
          <p className="mt-2 text-sm text-zinc-500">
            This agent may have been removed or you may no longer have access to it.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl">
      <Link href="/agents" className="text-sm font-medium text-indigo-300 hover:text-indigo-200 transition-colors">
        ← Back to Agents
      </Link>

      <div className="mt-5 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">{agent.name}</h1>
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusClasses(agent.status)}`}>
                {statusLabel(agent.status)}
              </span>
            </div>
            {agent.description ? (
              <p className="mt-3 text-sm text-zinc-400 max-w-2xl">{agent.description}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-4 text-sm text-zinc-500">
              <span>Account: <span className="text-zinc-300">{agent.safe_name ?? safe?.name ?? 'Unassigned'}</span></span>
              {chainConfig ? <span>Network: <span className="text-zinc-300">{chainConfig.name}</span></span> : null}
              <span>Recipients: <span className="text-zinc-300">{agent.restrict_recipients ? `${agent.allowed_recipients.length} allowlisted` : 'Any recipient'}</span></span>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/agents"
              className="inline-flex items-center justify-center rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
            >
              Manage on Agents page
            </Link>
            {agent.delegate_address && chainConfig ? (
              <a
                href={getExplorerUrl(safe?.chain_id ?? 100, 'address', agent.delegate_address)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-zinc-200 hover:bg-white/[0.06] transition-colors"
              >
                View delegate
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatBlock
          label="All-time transactions"
          value={stats ? String(stats.all_time.reduce((sum, item) => sum + item.tx_count, 0)) : '0'}
          helper="Confirmed agent payments"
        />
        <StatBlock
          label="Today"
          value={stats ? String(stats.today.reduce((sum, item) => sum + item.tx_count, 0)) : '0'}
          helper="Payments started today"
        />
        <StatBlock
          label="Pending approvals"
          value={stats ? String(stats.pending_approvals) : '0'}
          helper="Payments waiting on you"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.06]">
            <h2 className="text-sm font-semibold text-zinc-100">Spending limits</h2>
          </div>
          {agent.allowances.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-zinc-300">No spend limits configured</p>
              <p className="mt-2 text-xs text-zinc-500">Add an allowance on the Agents page to let this agent spend.</p>
            </div>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {agent.allowances.map((allowance) => {
                const decimals =
                  chainConfig &&
                  Object.values(chainConfig.tokens).find((token) => token.symbol === allowance.token_symbol)?.decimals

                return (
                  <div key={allowance.id} className="px-5 py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-zinc-100">{allowance.token_symbol}</p>
                        <p className="mt-1 text-xs text-zinc-500">
                          Resets: {resetLabel(allowance.reset_period_min)}
                        </p>
                      </div>
                      <p className="text-sm font-medium text-zinc-200">
                        {formatAllowanceAmount(allowance.allowance_amount, decimals ?? 18)} {allowance.token_symbol}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.06]">
            <h2 className="text-sm font-semibold text-zinc-100">Delegate</h2>
          </div>
          <div className="p-5">
            {agent.delegate_address ? (
              <>
                <p className="text-xs uppercase tracking-wide text-zinc-600">Delegate address</p>
                <code className="mt-3 block text-sm text-zinc-200 break-all">{agent.delegate_address}</code>
                <p className="mt-4 text-xs text-zinc-500">
                  If this delegate is ever compromised, revoke the agent from the Agents page and create a new one.
                </p>
              </>
            ) : (
              <p className="text-sm text-zinc-500">This agent does not currently expose a delegate address.</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-zinc-100">Recent activity</h2>
        </div>

        {activityLoading ? (
          <div className="p-5 space-y-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-14 rounded-lg bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        ) : activity.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm text-zinc-300">No activity yet</p>
            <p className="mt-2 text-xs text-zinc-500">Payments, approvals, and confirmations for this agent will appear here.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {activity.map((item) => (
              <div key={`${item.type}-${item.id}`} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-zinc-100">
                      {item.amount} {item.token}
                    </p>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${statusClasses(item.status)}`}>
                      {statusLabel(item.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500 truncate">
                    {item.type === 'approval' ? 'Approval' : 'Payment'} to {truncate(item.to)}
                    {item.reason ? ` • ${item.reason}` : ''}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  {item.tx_hash && item.explorer_url ? (
                    <a
                      href={item.explorer_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-indigo-300 hover:text-indigo-200 transition-colors"
                    >
                      View tx
                    </a>
                  ) : null}
                  <p className="mt-1 text-xs text-zinc-500">{timeAgo(item.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

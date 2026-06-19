'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { useUserSafes } from '@/hooks/useUserSafes'
import { useAgents, type Agent } from '@/hooks/useAgents'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { useOnChainAllowances } from '@/hooks/useOnChainAllowances'
import { type UserSafe } from '@/context/AuthContext'
import { getChainConfig, getTokensForChain } from '@/lib/chains'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { truncate } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'

/** EIP-3770 short names Safe{Wallet} uses in its deep links. */
const SAFE_SHORT_NAME: Record<number, string> = { 100: 'gno', 8453: 'base' }

function safeWalletUrl(safe: UserSafe): string {
  const prefix = SAFE_SHORT_NAME[safe.chain_id] ?? ''
  return `https://app.safe.global/home?safe=${prefix}:${safe.safe_address}`
}

function resetLabel(mins: number): string {
  if (mins === 0) return 'one-time'
  if (mins === 1440) return 'daily'
  if (mins === 10080) return 'weekly'
  if (mins === 43200) return 'monthly'
  return `every ${mins} min`
}

function OnChainBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--v2-success-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--v2-success)]">
      🔒 on-chain
    </span>
  )
}

function AdvisoryBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--v2-ink-3)]">
      ⓘ not on-chain
    </span>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
      <div className="mt-0.5 text-sm text-[var(--v2-ink)]">{children}</div>
    </div>
  )
}

function tokenSymbol(address: string, chainId: number): string {
  const tokens = getTokensForChain(chainId)
  const match = Object.values(tokens).find(
    (t) => t.address && t.address.toLowerCase() === address.toLowerCase(),
  )
  return match?.symbol ?? 'token'
}

function SafeControlCard({ safe, agents }: { safe: UserSafe; agents: Agent[] }) {
  const { details, loading: detailsLoading } = useSafeDetails(safe.safe_address, { chainId: safe.chain_id })
  const safeAgents = agents.filter((a) => a.safe_id === safe.id && a.delegate_address)
  const managedDelegates = safeAgents.map((a) => (a.delegate_address as string).toLowerCase())
  const { data, moduleEnabled, loading: allowancesLoading } = useOnChainAllowances(
    safe.safe_address,
    managedDelegates,
    safe.chain_id,
  )

  const agentByDelegate = new Map(
    safeAgents.map((a) => [(a.delegate_address as string).toLowerCase(), a]),
  )

  return (
    <Card className="p-5" hover={false}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="v2-text-h3 text-[var(--v2-ink)]">{safe.name}</h2>
          <p className="mt-0.5 font-mono text-xs text-[var(--v2-ink-3)]">
            {truncate(safe.safe_address)} · {getChainConfig(safe.chain_id).name}
          </p>
        </div>
        <a
          href={safeWalletUrl(safe)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-[var(--v2-brand)] hover:underline"
        >
          Open in Safe&#123;Wallet&#125; ↗
        </a>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Stat label="Owners (control this Safe — Haven is not one)">
          {detailsLoading ? (
            <Skeleton variant="text" className="h-4 w-40" />
          ) : details ? (
            <div className="space-y-1">
              {details.owners.map((o) => (
                <p key={o} className="font-mono text-xs text-[var(--v2-ink-2)]">{truncate(o)}</p>
              ))}
              <p className="text-xs text-[var(--v2-ink-3)]">Threshold: {details.threshold} of {details.owners.length}</p>
            </div>
          ) : (
            <span className="text-[var(--v2-ink-3)]">—</span>
          )}
        </Stat>

        <Stat label="Spend control">
          {allowancesLoading ? (
            <Skeleton variant="text" className="h-4 w-32" />
          ) : moduleEnabled ? (
            <span className="inline-flex items-center gap-2">Safe AllowanceModule <OnChainBadge /></span>
          ) : moduleEnabled === false ? (
            <span className="text-[var(--v2-ink-3)]">AllowanceModule not enabled</span>
          ) : (
            <span className="text-[var(--v2-ink-3)]">—</span>
          )}
        </Stat>
      </div>

      <div className="mt-5">
        <p className="mb-2 text-xs font-medium text-[var(--v2-ink-3)]">Agent spend authority (enforced on-chain)</p>
        {allowancesLoading ? (
          <Skeleton variant="text" className="h-4 w-48" />
        ) : data.size === 0 ? (
          <p className="text-sm text-[var(--v2-ink-3)]">No on-chain agent allowances on this Safe.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--v2-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--v2-table-header-bg)] text-left text-xs text-[var(--v2-ink-3)]">
                <tr>
                  <th className="px-3 py-2 font-medium">Agent / delegate</th>
                  <th className="px-3 py-2 font-medium">Token</th>
                  <th className="px-3 py-2 font-medium">Limit</th>
                  <th className="px-3 py-2 font-medium">Spent</th>
                  <th className="px-3 py-2 font-medium">Resets</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--v2-border)]">
                {[...data.entries()].flatMap(([delegate, info]) => {
                  const agent = agentByDelegate.get(delegate)
                  return info.allowances.map((al) => {
                    const sym = tokenSymbol(al.token, safe.chain_id)
                    return (
                      <tr key={`${delegate}-${al.token}`}>
                        <td className="px-3 py-2">
                          <span className="text-[var(--v2-ink)]">{agent?.name ?? 'Unmanaged delegate'}</span>
                          <span className="ml-1 font-mono text-xs text-[var(--v2-ink-3)]">{truncate(delegate)}</span>
                        </td>
                        <td className="px-3 py-2 text-[var(--v2-ink-2)]">{sym}</td>
                        <td className="px-3 py-2 text-[var(--v2-ink-2)]">{formatAllowanceForToken(al.amount.toString(), safe.chain_id, sym)}</td>
                        <td className="px-3 py-2 text-[var(--v2-ink-2)]">{formatAllowanceForToken(al.spent.toString(), safe.chain_id, sym)}</td>
                        <td className="px-3 py-2 text-[var(--v2-ink-2)]">{resetLabel(al.resetTimeMin)}</td>
                      </tr>
                    )
                  })
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
          Token, limit and reset are <OnChainBadge /> enforced. Recipient is <AdvisoryBadge /> constrained today.{' '}
          Revoke an agent on-chain from <Link href="/agents" className="text-[var(--v2-brand)] hover:underline">Agents</Link>.
        </p>
      </div>
    </Card>
  )
}

const HAVEN_CANNOT = [
  'Move your funds — every transfer needs your or your agent’s key signature; Haven only relays and pays gas.',
  'Hold your keys — no private keys, seed phrases, or agent keys are stored by Haven.',
  'Expand an agent’s allowance without a Safe transaction you sign.',
  'Block you — you can manage this Safe from any Safe-compatible app and revoke agents on-chain.',
]

export default function CustodyPage() {
  const { safes, loading: safesLoading } = useUserSafes()
  const { agents } = useAgents()

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Custody"
        subtitle="Proof that you — not Haven — control your funds. These limits live on-chain in your Safe, not in Haven’s database."
      />

      <Card className="mb-5 p-5" elevation="anchor" hover={false}>
        <p className="mb-2 text-sm font-medium text-[var(--v2-ink)]">What Haven cannot do</p>
        <ul className="space-y-1.5">
          {HAVEN_CANNOT.map((line) => (
            <li key={line} className="flex gap-2 text-sm text-[var(--v2-ink-2)]">
              <span className="text-[var(--v2-success)]">✓</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </Card>

      {safesLoading ? (
        <Skeleton variant="text" className="h-5 w-56" />
      ) : safes.length === 0 ? (
        <p className="text-sm text-[var(--v2-ink-3)]">No Safes linked yet.</p>
      ) : (
        <div className="space-y-5">
          {safes.map((safe) => (
            <SafeControlCard key={safe.id} safe={safe} agents={agents} />
          ))}
        </div>
      )}
    </div>
  )
}

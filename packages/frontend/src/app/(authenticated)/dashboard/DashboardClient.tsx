'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useContacts } from '@/hooks/useContacts'
import { useAgents } from '@/hooks/useAgents'
import { useActivityFeed } from '@/hooks/useAgentActivity'
import {
  useAggregatedPortfolio,
  useAggregatedBalances,
  useAggregatedTransactions,
} from '@/hooks/useAggregatedPortfolio'
import PortfolioHero from '@/components/PortfolioHero'
import BalanceCards from '@/components/BalanceCards'
import TransactionList from '@/components/TransactionList'
import DashboardInfo from '@/components/DashboardInfo'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
import CreateAgentModal from '@/components/CreateAgentModal'

// ── Status dot ───────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    active: 'bg-emerald-400',
    revoked: 'bg-red-400',
  }
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full ${color[status] ?? 'bg-zinc-600'}`} />
  )
}

// ── Agent Summary Card ───────────────────────────────────────────────

function AgentCard({ agent }: { agent: { name: string; status: string; safe_name: string | null; allowances: { token_symbol: string }[] } }) {
  const tokens = agent.allowances.map((a) => a.token_symbol)
  const isActive = agent.status === 'active'

  return (
    <div className={`p-3 rounded-lg border transition-colors ${
      isActive
        ? 'border-white/[0.06] bg-white/[0.02]'
        : 'border-white/[0.04] bg-white/[0.01] opacity-60'
    }`}>
      <div className="flex items-center gap-2 mb-1.5">
        <StatusDot status={agent.status} />
        <span className="text-xs font-medium text-zinc-200 truncate">{agent.name}</span>
      </div>
      {agent.safe_name && (
        <p className="text-[10px] text-zinc-600 mb-1.5 truncate">{agent.safe_name}</p>
      )}
      {tokens.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tokens.map((t) => (
            <span
              key={t}
              className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-zinc-500"
            >
              {t}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-zinc-700">No allowances</p>
      )}
    </div>
  )
}

// ── Account Mini Card ────────────────────────────────────────────────

function AccountMiniCard({ name, address, isDefault }: { name: string; address: string; isDefault: boolean }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.03] transition-colors">
      <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
        <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-zinc-200 truncate">{name}</span>
          {isDefault && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-500/10 text-indigo-400 font-medium flex-shrink-0">
              default
            </span>
          )}
        </div>
        <span className="text-[10px] font-mono text-zinc-600">
          {address.slice(0, 6)}...{address.slice(-4)}
        </span>
      </div>
    </div>
  )
}

// ── Main Dashboard ───────────────────────────────────────────────────

export default function DashboardClient() {
  const { user } = useAuth()
  const safes = user?.safes ?? []
  const { currency } = usePreferences()

  const { resolveAddress } = useContacts()
  const { agents, refetch: refetchAgents } = useAgents()
  const { pendingApprovals } = useActivityFeed()

  // Aggregated data across all Safes
  const { totalUsd, totalEur, loading: portfolioLoading, refetch: refetchPortfolio } = useAggregatedPortfolio()
  const { balances, loading: balancesLoading, error: balancesError, refetch: refetchBalances } = useAggregatedBalances()
  const { transactions, loading: txLoading, error: txError, total: txTotal, refetch: refetchTx } = useAggregatedTransactions(5)

  // Build delegate → agent name lookup for tx attribution
  const agentsByDelegate = new Map<string, string>()
  for (const agent of agents) {
    if (agent.delegate_address && agent.status === 'active') {
      agentsByDelegate.set(agent.delegate_address.toLowerCase(), agent.name)
    }
  }

  const activeAgents = agents.filter((a) => a.status === 'active')
  const totalFiat = currency === 'EUR' ? totalEur : totalUsd

  // Onboarding guide state.
  // - Fund step shows only when *every* Safe is empty across *every* token.
  //   We check raw balances rather than fiat — fiat < 1 misclassifies wallets
  //   that hold tokens without a price feed (e.g. xDAI on Gnosis at < $1).
  // - Add-agent step shows when the wallet has any balance but the user
  //   hasn't added an agent yet (counts revoked agents too — once added,
  //   the user has been through the flow).
  const hasAnyBalance = balances.some((b) => {
    try {
      return BigInt(b.balance) > 0n
    } catch {
      return false
    }
  })
  const onboardingStage: 'fund' | 'add-agent' | null =
    safes.length === 0 || balancesLoading
      ? null
      : !hasAnyBalance
        ? 'fund'
        : agents.length === 0
          ? 'add-agent'
          : null

  // Track which Safe the user wants to deposit into; default to default-or-first
  // so the QR/address loads immediately on mount.
  const [guideSafeId, setGuideSafeId] = useState<string | null>(null)
  useEffect(() => {
    if (guideSafeId && safes.some((s) => s.id === guideSafeId)) return
    setGuideSafeId((safes.find((s) => s.is_default) ?? safes[0])?.id ?? null)
  }, [safes, guideSafeId])

  const [infoOpen, setInfoOpen] = useState(false)
  const [createAgentOpen, setCreateAgentOpen] = useState(false)
  const [createAgentPreset, setCreateAgentPreset] = useState<'demo' | null>(null)

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">Dashboard</h1>
          <p className="text-sm text-zinc-500">Overview across all accounts</p>
        </div>
        <button
          onClick={() => setInfoOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-zinc-400 text-sm font-medium hover:bg-white/[0.05] hover:text-zinc-300 transition-all duration-200"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          How it works
        </button>
      </div>

      {/* Pending approvals banner */}
      {pendingApprovals > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 mb-6 rounded-lg bg-amber-500/[0.05] border border-amber-500/20">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-amber-400 flex-shrink-0">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="text-sm text-amber-400">
            {pendingApprovals} payment{pendingApprovals !== 1 ? 's' : ''} pending your approval
          </span>
          <Link
            href="/agents"
            className="text-xs text-amber-300 hover:text-amber-200 ml-auto font-medium"
          >
            Review
          </Link>
        </div>
      )}

      {/* Portfolio total */}
      <PortfolioHero
        totalFiat={totalFiat}
        currency={currency}
        accountCount={safes.length}
        agentCount={activeAgents.length}
        loading={portfolioLoading}
      />

      {/* Stage-aware onboarding guide — fund first, then add an agent. Hides
          itself once both milestones are met. */}
      {onboardingStage && (
        <DashboardOnboardingGuide
          stage={onboardingStage}
          safes={safes}
          selectedSafeId={guideSafeId}
          onSelectSafe={setGuideSafeId}
          onAddAgent={() => {
            setCreateAgentPreset(null)
            setCreateAgentOpen(true)
          }}
          onAddDemoAgent={() => {
            setCreateAgentPreset('demo')
            setCreateAgentOpen(true)
          }}
        />
      )}

      {/* Two-column layout: Balances + Accounts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Token balances — 2 cols */}
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-zinc-300">Token Balances</h2>
            {safes.length > 1 && (
              <span className="text-[10px] text-zinc-600">Combined across all accounts</span>
            )}
          </div>
          <BalanceCards
            balances={balances}
            loading={balancesLoading}
            error={balancesError}
            onRefresh={refetchBalances}
          />
        </div>

        {/* Accounts summary — 1 col */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-zinc-300">Accounts</h2>
            <Link
              href="/accounts"
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Manage
            </Link>
          </div>
          {safes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/[0.08] p-6 text-center">
              <p className="text-xs text-zinc-600 mb-2">No accounts yet</p>
              <Link href="/accounts" className="text-xs text-indigo-400 hover:text-indigo-300">
                Add your first account
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {safes.map((safe) => (
                <Link key={safe.id} href={`/accounts/${safe.id}`}>
                  <AccountMiniCard
                    name={safe.name}
                    address={safe.safe_address}
                    isDefault={safe.is_default}
                  />
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Agents summary */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">
          Agents
          {activeAgents.length > 0 && (
            <span className="text-zinc-600 font-normal ml-1.5">
              ({activeAgents.length} active)
            </span>
          )}
        </h2>
        <Link
          href="/agents"
          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          View all
        </Link>
      </div>

      {activeAgents.length === 0 ? (
        // The dashboard onboarding guide above handles the "no agents" state
        // when the wallet is funded. Render a quiet placeholder otherwise so
        // the layout doesn't jump.
        <div className="rounded-lg border border-dashed border-white/[0.08] p-6 mb-8 text-center">
          <svg className="w-8 h-8 mx-auto mb-2 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
          </svg>
          <p className="text-xs text-zinc-600">No agents yet</p>
        </div>
      ) : (
        <div className="mb-8">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {activeAgents.slice(0, 8).map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
          {activeAgents.length > 8 && (
            <Link
              href="/agents"
              className="block text-center text-xs text-zinc-500 hover:text-zinc-400 mt-2 transition-colors"
            >
              +{activeAgents.length - 8} more
            </Link>
          )}
        </div>
      )}

      {/* Recent transactions */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">
          Recent Transactions
          {safes.length > 1 && (
            <span className="text-zinc-600 font-normal ml-1.5">
              (all accounts)
            </span>
          )}
        </h2>
        {(() => {
          // When the user has a single account, "View all" should deep-link to
          // that account's detail page (which has a real transactions list),
          // not the accounts overview.
          const target =
            safes.length === 1
              ? `/accounts/${safes[0].id}`
              : `/accounts/${(safes.find((s) => s.is_default) ?? safes[0])?.id ?? ''}`
          return target ? (
            <Link
              href={target}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded"
            >
              View all
            </Link>
          ) : null
        })()}
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.01] p-4">
        <TransactionList
          transactions={transactions}
          loading={txLoading}
          error={txError}
          page={1}
          pages={1}
          total={txTotal}
          onPageChange={() => {}}
          onRefresh={refetchTx}
          resolveAddress={resolveAddress}
          agentsByDelegate={agentsByDelegate}
        />
      </div>

      <DashboardInfo open={infoOpen} onClose={() => setInfoOpen(false)} />

      {/* Agent modal mounted at the dashboard so the onboarding guide can open
          it in-place. The modal carries its own Safe picker, so we don't need
          to preselect one — letting it default to activeSafe / default Safe. */}
      <CreateAgentModal
        open={createAgentOpen}
        onClose={() => {
          setCreateAgentOpen(false)
          setCreateAgentPreset(null)
        }}
        safeId={guideSafeId}
        preset={createAgentPreset}
        onCreated={() => {
          // Refresh agents and portfolio so the guide flips to "done" the
          // moment the agent comes back. Don't close here — the modal's Done
          // step shows the one-time handoff file.
          refetchAgents()
          refetchPortfolio()
        }}
      />
    </div>
  )
}

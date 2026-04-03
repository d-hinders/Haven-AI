'use client'

import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { useBalances } from '@/hooks/useBalances'
import { useTransactions } from '@/hooks/useTransactions'
import { usePortfolio } from '@/hooks/usePortfolio'
import { usePreferences } from '@/hooks/usePreferences'
import PortfolioHero from '@/components/PortfolioHero'
import BalanceCards from '@/components/BalanceCards'
import TransactionList from '@/components/TransactionList'

export default function DashboardClient() {
  const { user } = useAuth()
  const safeAddress = user?.safe_address ?? null
  const { currency } = usePreferences()

  const {
    totalUsd,
    totalEur,
    loading: portfolioLoading,
  } = usePortfolio(safeAddress)

  const {
    balances,
    loading: balancesLoading,
    error: balancesError,
    refetch: refetchBalances,
  } = useBalances(safeAddress)

  const {
    transactions,
    loading: txLoading,
    error: txError,
    page,
    pages,
    total,
    setPage,
    refetch: refetchTx,
  } = useTransactions(safeAddress, 5)

  const totalFiat = currency === 'EUR' ? totalEur : totalUsd

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight mb-1">Dashboard</h1>
        <p className="text-sm text-zinc-500">Your Safe overview</p>
      </div>

      {/* Portfolio total */}
      {safeAddress && (
        <PortfolioHero
          totalFiat={totalFiat}
          currency={currency}
          safeAddress={safeAddress}
          loading={portfolioLoading}
        />
      )}

      {/* Token balances */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-300">Token Balances</h2>
        </div>
      </div>
      <BalanceCards
        balances={balances}
        loading={balancesLoading}
        error={balancesError}
        onRefresh={refetchBalances}
      />

      {/* Recent transactions */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">
          Recent Transactions
        </h2>
        <Link
          href="/account"
          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          View all
        </Link>
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.01] p-4">
        <TransactionList
          transactions={transactions}
          loading={txLoading}
          error={txError}
          page={page}
          pages={pages}
          total={total}
          onPageChange={setPage}
          onRefresh={refetchTx}
        />
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-8">
        <Link
          href="/account"
          className="group flex items-center gap-4 p-5 rounded-lg border border-white/[0.06] hover:border-indigo-500/30 bg-white/[0.01] hover:bg-indigo-500/[0.03] transition-all duration-200"
        >
          <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-500/20 transition-colors">
            <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-200">Manage Account</p>
            <p className="text-xs text-zinc-500">View owners, details & full history</p>
          </div>
        </Link>

        <div className="relative flex items-center gap-4 p-5 rounded-lg border border-dashed border-white/[0.06] bg-white/[0.01] opacity-60">
          <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-200">Create Agent</p>
            <p className="text-xs text-zinc-500">Coming soon</p>
          </div>
          <span className="absolute top-3 right-3 text-[10px] px-1.5 py-0.5 rounded-sm bg-indigo-500/10 text-indigo-400 font-medium">
            Soon
          </span>
        </div>
      </div>
    </div>
  )
}

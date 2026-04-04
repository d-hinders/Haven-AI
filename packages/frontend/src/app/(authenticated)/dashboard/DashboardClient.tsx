'use client'

import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { useBalances } from '@/hooks/useBalances'
import { useTransactions } from '@/hooks/useTransactions'
import { usePortfolio } from '@/hooks/usePortfolio'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { usePreferences } from '@/hooks/usePreferences'
import PortfolioHero from '@/components/PortfolioHero'
import BalanceCards from '@/components/BalanceCards'
import TransactionList from '@/components/TransactionList'
import SendButton from '@/components/SendButton'

export default function DashboardClient() {
  const { user } = useAuth()
  const safeAddress = user?.safe_address ?? null
  const { currency } = usePreferences()

  const { details: safeDetails } = useSafeDetails(safeAddress)

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

  const handleSendSuccess = () => {
    refetchBalances()
    refetchTx()
  }

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">Dashboard</h1>
          <p className="text-sm text-zinc-500">Your Safe overview</p>
        </div>
        {safeAddress && (
          <SendButton
            safeAddress={safeAddress}
            safeDetails={safeDetails}
            balances={balances}
            onSuccess={handleSendSuccess}
          />
        )}
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
      </div>

    </div>
  )
}

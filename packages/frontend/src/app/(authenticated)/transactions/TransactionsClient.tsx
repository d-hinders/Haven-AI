'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { useContacts } from '@/hooks/useContacts'
import { useTransactionFilters } from '@/hooks/useTransactionFilters'
import { useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import type { TransactionFilterState } from '@/types/transactions'
import FilterBar from '@/components/transactions/FilterBar'
import TransactionsTable from '@/components/transactions/TransactionsTable'

export default function TransactionsClient() {
  const { user } = useAuth()
  const { resolveAddress } = useContacts()
  const [filters, setFilters] = useState<TransactionFilterState>({})
  const {
    safes,
    agents,
    tokens,
    loading: filtersLoading,
    error: filtersError,
    refresh: refreshFilters,
  } = useTransactionFilters()
  const {
    transactions,
    total,
    loadingInitial,
    loadingMore,
    refreshing,
    hasMore,
    error,
    partialFailure,
    failedSafeIds,
    loadMore,
    refresh,
  } = useTransactionsFeed(filters, 25)

  const userSafes = user?.safes ?? []
  const hasSafes = userSafes.length > 0
  const hasActiveFilters = Boolean(filters.safeId || filters.agentId || filters.tokenKey)

  const safeNamesById = new Map(safes.map((safe) => [safe.id, safe.name]))
  const safeNamesByAddress = new Map(
    userSafes.map((safe) => [safe.safe_address.toLowerCase(), safe.name]),
  )
  const failedSafeNames = failedSafeIds
    .map((id) => safeNamesById.get(id))
    .filter((name): name is string => Boolean(name))

  const handleRefresh = async () => {
    await refresh()
    await refreshFilters(false)
  }

  if (!hasSafes) {
    return (
      <div className="max-w-5xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight mb-1">Transactions</h1>
          <p className="text-sm text-zinc-500">All activity across your Safes</p>
        </div>

        <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.02] p-10 text-center">
          <p className="text-sm text-zinc-400 mb-2">No accounts linked yet</p>
          <p className="text-xs text-zinc-600 mb-5">
            Add a Safe to Haven before we can show transaction history.
          </p>
          <Link
            href="/onboarding"
            className="inline-flex items-center rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 transition-colors"
          >
            Add a Safe
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">Transactions</h1>
          <p className="text-sm text-zinc-500">All activity across your Safes</p>
        </div>
        <button
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <svg
            className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.023 9.348h4.992V4.356M2.977 14.652H7.97v4.992m12.042-1.636a9 9 0 00-15.66-2.032M3.638 6.338A9 9 0 0119.298 8.37"
            />
          </svg>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {partialFailure && (
        <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-200">
          <div className="font-medium mb-1">Some accounts failed to load completely.</div>
          <div className="text-xs text-amber-200/80">
            {failedSafeNames.length > 0
              ? `Affected: ${failedSafeNames.join(', ')}.`
              : 'Some Safe explorers returned partial data.'}{' '}
            Try refresh to re-run the fetches.
          </div>
        </div>
      )}

      <FilterBar
        filters={filters}
        safes={safes}
        agents={agents}
        tokens={tokens}
        loading={filtersLoading}
        error={filtersError}
        onChange={setFilters}
      />

      <div className="mt-5 mb-3 flex items-center justify-between gap-4">
        <span className="text-xs text-zinc-600">
          {loadingInitial
            ? 'Loading transactions...'
            : `${total} transaction${total !== 1 ? 's' : ''}`}
        </span>
        {!loadingInitial && transactions.length > 0 && (
          <span className="text-xs text-zinc-700">
            Showing {transactions.length} of {total}
          </span>
        )}
      </div>

      <TransactionsTable
        transactions={transactions}
        loading={loadingInitial}
        error={error}
        onRefresh={() => void refresh()}
        resolveAddress={resolveAddress}
        safeNamesByAddress={safeNamesByAddress}
        showSafeTag={!filters.safeId}
        hasActiveFilters={hasActiveFilters}
      />

      {transactions.length > 0 && (
        <div className="mt-5 flex items-center justify-center">
          {hasMore ? (
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="inline-flex min-w-36 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          ) : (
            <span className="text-xs text-zinc-700">You&apos;ve reached the end.</span>
          )}
        </div>
      )}
    </div>
  )
}

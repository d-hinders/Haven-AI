'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { useContacts } from '@/hooks/useContacts'
import { useTransactionFilters } from '@/hooks/useTransactionFilters'
import { useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import type { TransactionFilterState } from '@/types/transactions'
import FilterBar from '@/components/transactions/FilterBar'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'

export default function TransactionsClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const { resolveAddress } = useContacts()
  const [filters, setFilters] = useState<TransactionFilterState>(() => ({
    safeId: searchParams.get('safeId') ?? undefined,
    agentId: searchParams.get('agentId') ?? undefined,
    tokenKey: searchParams.get('tokenKey') ?? undefined,
  }))
  const {
    safes,
    agents,
    tokens,
    loading: filtersLoading,
    error: filtersError,
  } = useTransactionFilters()
  const {
    transactions,
    total,
    loadingInitial,
    loadingMore,
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
  const handleFilterChange = (nextFilters: TransactionFilterState) => {
    setFilters(nextFilters)

    const params = new URLSearchParams()
    if (nextFilters.safeId) params.set('safeId', nextFilters.safeId)
    if (nextFilters.agentId) params.set('agentId', nextFilters.agentId)
    if (nextFilters.tokenKey) params.set('tokenKey', nextFilters.tokenKey)

    const query = params.toString()
    router.replace(query ? `/transactions?${query}` : '/transactions', { scroll: false })
  }

  if (!hasSafes) {
    return (
      <div className="max-w-5xl">
        <PageHeader
          title="Transaction history"
          subtitle="Payments and account activity across your Haven wallets."
        />

        <EmptyState
          title="No accounts linked yet"
          body="Add a Haven account before we can show transaction history."
          action={<Button href="/onboarding">Add account</Button>}
        />
      </div>
    )
  }

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Transaction history"
        subtitle="Payments and account activity across your Haven wallets."
      />

      {partialFailure && (
        <div className="mb-4 rounded-lg border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-warning)]">
          <div className="font-medium mb-1">Some accounts failed to load completely.</div>
          <div className="text-xs text-[var(--v2-warning)]">
            {failedSafeNames.length > 0
              ? `Affected: ${failedSafeNames.join(', ')}.`
              : 'Some network explorers returned partial data.'}{' '}
            Reload the page to try again.
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
        onChange={handleFilterChange}
      />

      <div className="mt-5 mb-3 flex items-center justify-between gap-4">
        <span className="text-xs text-[var(--v2-ink-3)]">
          {loadingInitial ? (
            'Loading transactions...'
          ) : (
            <>
              <span className="v2-tabular">{transactions.length}</span> transaction{transactions.length !== 1 ? 's' : ''}
            </>
          )}
        </span>
        {!loadingInitial && hasMore && transactions.length > 0 && (
          <span className="text-xs text-[var(--v2-ink-3)]">
            Showing <span className="v2-tabular">{transactions.length}</span> of <span className="v2-tabular">{total}</span>
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
        hasActiveFilters={hasActiveFilters}
      />

      {transactions.length > 0 && (
        <div className="mt-5 flex items-center justify-center">
          {hasMore ? (
            <Button
              variant="ghost"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="min-w-36"
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </Button>
          ) : (
            <span className="text-xs text-[var(--v2-ink-3)]">You&apos;ve reached the end.</span>
          )}
        </div>
      )}
    </div>
  )
}

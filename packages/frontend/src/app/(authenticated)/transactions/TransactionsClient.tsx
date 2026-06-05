'use client'

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { useContacts } from '@/hooks/useContacts'
import { useTransactionFilters } from '@/hooks/useTransactionFilters'
import { useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import {
  buildTransactionScopeSubtitle,
  buildTransactionSummary,
} from '@/lib/transaction-scope'
import type { TransactionFilterState } from '@/types/transactions'
import FilterBar from '@/components/transactions/FilterBar'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'

export default function TransactionsClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const { resolveAddress } = useContacts()
  const [filters, setFilters] = useState<TransactionFilterState>(() => {
    const direction = searchParams.get('direction')
    return {
      safeId: searchParams.get('safeId') ?? undefined,
      agentId: searchParams.get('agentId') ?? undefined,
      tokenKey: searchParams.get('tokenKey') ?? undefined,
      direction: direction === 'in' || direction === 'out' ? direction : undefined,
    }
  })
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
  const hasActiveFilters = Boolean(
    filters.safeId || filters.agentId || filters.tokenKey || filters.direction,
  )

  // Client-side direction filter — the API doesn't yet support this dimension,
  // so we filter the fetched page in memory. Honest UX caveat: when combined
  // with paginated results this only filters what's loaded, same constraint
  // as the client-side sort.
  const visibleTransactions = useMemo(() => {
    if (!filters.direction) return transactions
    return transactions.filter((tx) => tx.direction === filters.direction)
  }, [transactions, filters.direction])

  const safeNamesById = new Map(safes.map((safe) => [safe.id, safe.name]))
  const agentNamesById = new Map(agents.map((agent) => [agent.id, agent.name]))
  const tokenSymbolsByKey = new Map(tokens.map((token) => [token.key, token.symbol]))
  const safeNamesByAddress = new Map(
    userSafes.map((safe) => [
      `${safe.safe_address.toLowerCase()}:${safe.chain_id}`,
      safe.name,
    ]),
  )
  const failedSafeNames = failedSafeIds
    .map((id) => safeNamesById.get(id))
    .filter((name): name is string => Boolean(name))

  // Plain-English page subtitle that reflects the active filter scope. When
  // the user lands here from the "View all →" link on an account or agent
  // detail page, this turns the static "All activity across your accounts."
  // line into "Transactions for {accountName}" so the view feels intentional.
  const subtitle = useMemo(
    () =>
      buildTransactionScopeSubtitle(filters, {
        accountNamesById: safeNamesById,
        agentNamesById,
        tokenSymbolsByKey,
      }),
    [filters, safeNamesById, agentNamesById, tokenSymbolsByKey],
  )

  // Cheap summary stats — count by direction over what's currently loaded.
  // See `buildTransactionSummary` for the mutually-exclusive bucket rule.
  const summary = useMemo(
    () => buildTransactionSummary(visibleTransactions),
    [visibleTransactions],
  )
  const showSummary = hasActiveFilters && visibleTransactions.length > 0
  const handleFilterChange = (nextFilters: TransactionFilterState) => {
    setFilters(nextFilters)

    const params = new URLSearchParams()
    if (nextFilters.safeId) params.set('safeId', nextFilters.safeId)
    if (nextFilters.agentId) params.set('agentId', nextFilters.agentId)
    if (nextFilters.tokenKey) params.set('tokenKey', nextFilters.tokenKey)
    if (nextFilters.direction) params.set('direction', nextFilters.direction)

    const query = params.toString()
    router.replace(query ? `/transactions?${query}` : '/transactions', { scroll: false })
  }

  const handleClearFilters = () => {
    handleFilterChange({})
  }

  if (!hasSafes) {
    return (
      <div className="max-w-5xl">
        <PageHeader
          title="Transaction history"
          subtitle="All activity across your accounts."
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
      <PageHeader title="Transaction history" subtitle={subtitle} />

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

      <div className="mt-5 mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--v2-ink-3)]">
          <span>
            {loadingInitial ? (
              'Loading transactions...'
            ) : (
              <>
                <span className="v2-tabular">{visibleTransactions.length}</span> transaction
                {visibleTransactions.length !== 1 ? 's' : ''}
              </>
            )}
          </span>
          {showSummary ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                <span className="v2-tabular font-medium text-[var(--v2-success)]">{summary.received}</span> received
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <span className="v2-tabular font-medium text-[var(--v2-debit)]">{summary.sent}</span> sent
              </span>
              {summary.failed > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    <span className="v2-tabular font-medium text-[var(--v2-danger)]">{summary.failed}</span> failed
                  </span>
                </>
              ) : null}
              {hasMore ? <span className="text-[var(--v2-ink-3)]">(loaded results)</span> : null}
            </>
          ) : null}
        </div>
        {!loadingInitial && hasMore && visibleTransactions.length > 0 && (
          <span className="text-xs text-[var(--v2-ink-3)]">
            Showing <span className="v2-tabular">{visibleTransactions.length}</span> of <span className="v2-tabular">{total}</span>
          </span>
        )}
      </div>

      <Card hover={false}>
        <TransactionsTable
          transactions={visibleTransactions}
          loading={loadingInitial}
          error={error}
          onRefresh={() => void refresh()}
          resolveAddress={resolveAddress}
          safeNamesByAddress={safeNamesByAddress}
          hasActiveFilters={hasActiveFilters}
          onClearFilters={handleClearFilters}
          variant="page"
        />
      </Card>

      {visibleTransactions.length > 0 && (
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
            <span className="text-xs text-[var(--v2-ink-3)]">You&apos;ve reached the end</span>
          )}
        </div>
      )}
    </div>
  )
}

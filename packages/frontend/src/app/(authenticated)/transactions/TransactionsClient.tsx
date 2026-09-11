'use client'

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { useContacts } from '@/hooks/useContacts'
import { useChainScope } from '@/hooks/useActiveChain'
import { getChainConfig } from '@/lib/chains'
import { useTransactionFilters } from '@/hooks/useTransactionFilters'
import { useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import { Select } from '@/components/ui/Select'
import {
  buildTransactionScopeSubtitle,
  buildTransactionSummary,
} from '@/lib/transaction-scope'
import type { AggregatedTransaction, TransactionFilterState } from '@/types/transactions'
import { buildCsvFilename, downloadCsv } from '@/lib/transaction-csv'
import { api, ApiRequestError } from '@/lib/api'
import FilterBar from '@/components/transactions/FilterBar'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'

/**
 * What to show the user when an export fails.
 *
 * The refusal that matters is the row cap: the backend's `details` carries the
 * count, the limit and the way out ("narrow the filters"), and `message` is
 * only the three-word summary — so `details` is read where the route sends
 * one, via the `body` escape hatch `ApiRequestError` exists for. Every other
 * status gets a written sentence rather than a passthrough: the remaining
 * refusals on this route are validation strings for query parameters the UI
 * builds itself, and a 500 would otherwise surface Fastify's
 * "Internal Server Error" as product copy.
 */
function exportFailureMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const details = (err.body as { details?: unknown } | undefined)?.details
    if (err.status === 413 && typeof details === 'string' && details.length > 0) {
      return details
    }
  }
  return 'The export could not be generated. Try again.'
}

function chainName(chainId: number): string {
  try {
    return getChainConfig(chainId).name
  } catch {
    return `Chain ${chainId}`
  }
}

export default function TransactionsClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const { resolveAddress } = useContacts()
  const [selectedTx, setSelectedTx] = useState<AggregatedTransaction | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
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

  // Transactions follow the active chain by default and re-default when it
  // switches; the network dropdown overrides to another chain or all (#620).
  const { scope, setScope } = useChainScope('follow-active')
  const chainIds = Array.from(new Set(userSafes.map((s) => s.chain_id))).sort((a, b) => a - b)
  const showNetworkFilter = chainIds.length > 1

  // Client-side direction + network filters — the API doesn't yet support these
  // dimensions, so we filter the fetched page in memory. Honest UX caveat: when
  // combined with paginated results this only filters what's loaded, same
  // constraint as the client-side sort.
  const visibleTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      if (filters.direction && tx.direction !== filters.direction) return false
      if (scope !== 'all' && tx.chainId !== scope) return false
      return true
    })
  }, [transactions, filters.direction, scope])

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
  // the user lands here from the "View all" link on an account or agent
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
    // The dominant failure tells the user to narrow the filters; leaving the
    // banner up once they have makes it assert something no longer true.
    setExportError(null)

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

  // The backend generates the file (#2871): it sees the whole filtered result
  // set, where the browser only ever had the pages it had loaded. Every filter
  // the table applies goes on the query — including `direction` and the
  // network scope, which used to be applied here in memory — so the file and
  // the on-screen rows agree.
  const handleExportCsv = async () => {
    const params = new URLSearchParams()
    if (filters.safeId) params.set('safeId', filters.safeId)
    if (filters.agentId) params.set('agentId', filters.agentId)
    if (filters.tokenKey) params.set('tokenKey', filters.tokenKey)
    if (filters.direction) params.set('direction', filters.direction)
    if (scope !== 'all') params.set('chainId', String(scope))

    setExporting(true)
    setExportError(null)
    try {
      const csv = await api.getText(`/transactions/export.csv?${params.toString()}`)
      downloadCsv(csv, buildCsvFilename(new Date()))
    } catch (err) {
      setExportError(exportFailureMessage(err))
    } finally {
      setExporting(false)
    }
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

  // Gated on the server's filtered total, not on the rows the browser happens
  // to hold: since #2871 the export covers the whole result set, so gating on
  // `visibleTransactions` would disable the button whenever the loaded page
  // held no row matching the in-memory direction/network filter while the
  // server still had plenty.
  const canExport = !loadingInitial && total > 0

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Transaction history"
        subtitle={subtitle}
        actions={
          <Button
            variant="tertiary"
            onClick={handleExportCsv}
            disabled={!canExport || exporting}
            aria-busy={exporting}
          >
            {exporting ? 'Preparing…' : 'Export CSV'}
          </Button>
        }
      />

      {exportError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]"
        >
          {exportError}
        </div>
      )}

      {partialFailure && (
        <div className="mb-4 rounded-lg border border-warning/20 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-warning)]">
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

      {showNetworkFilter && (
        <div className="mt-3 flex items-center gap-2">
          <label htmlFor="tx-network" className="text-xs font-medium text-[var(--v2-ink-3)]">
            Network
          </label>
          <Select
            id="tx-network"
            aria-label="Filter transactions by network"
            value={scope === 'all' ? 'all' : String(scope)}
            onChange={(e) => {
              setScope(e.target.value === 'all' ? 'all' : Number(e.target.value))
              setExportError(null)
            }}
            className="max-w-[200px]"
          >
            <option value="all">All networks</option>
            {chainIds.map((id) => (
              <option key={id} value={String(id)}>
                {chainName(id)}
              </option>
            ))}
          </Select>
        </div>
      )}

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
          onSelect={setSelectedTx}
        />
      </Card>

      <TransactionDetailPanel
        transaction={selectedTx}
        open={selectedTx !== null}
        onClose={() => setSelectedTx(null)}
        resolveAddress={resolveAddress}
        safeNamesByAddress={safeNamesByAddress}
      />

      {visibleTransactions.length > 0 && (
        <div className="mt-5 flex items-center justify-center">
          {hasMore ? (
            <Button
              variant="ghost"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="min-w-36"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          ) : (
            <span className="text-xs text-[var(--v2-ink-3)]">You&apos;ve reached the end</span>
          )}
        </div>
      )}
    </div>
  )
}

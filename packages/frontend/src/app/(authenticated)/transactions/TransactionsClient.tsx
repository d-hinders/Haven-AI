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
 * What the export tells the user when it does not hand back a file.
 *
 * Two tones, because two different things happen: `error` is a refusal, and
 * `info` is the export succeeding over an empty result set — which is not a
 * failure and must not be painted as one.
 *
 * The headline/detail split mirrors the partial-failure banner already on
 * this screen: a short first line, the specifics beneath.
 */
interface ExportNotice {
  tone: 'error' | 'info'
  headline: string
  detail?: string
}

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
function exportFailureNotice(err: unknown): ExportNotice {
  if (err instanceof ApiRequestError) {
    const details = (err.body as { details?: unknown } | undefined)?.details
    if (err.status === 413 && typeof details === 'string' && details.length > 0) {
      return { tone: 'error', headline: err.message, detail: details }
    }
  }
  return {
    tone: 'error',
    headline: 'The export could not be generated.',
    detail: 'Try again in a moment.',
  }
}

/**
 * Does this CSV body carry any record, or only the header?
 *
 * The export applies `direction` and the network scope server-side while the
 * table applies them in memory, so the two can disagree about whether there
 * is anything to show: the button is gated on the server's `total`, which
 * does not know about either. Rather than hand the user a silent header-only
 * file, the empty result is read back off the body and reported.
 *
 * This reads the body because it has to: the route sends the count in
 * `X-Export-Row-Count`, but the backend's CORS registration sets no
 * `exposedHeaders`, so no browser client can read it. The test below is exact
 * rather than heuristic — the backend's `toCsv` joins lines with CRLF and
 * writes no trailing terminator (pinned by `domain/__tests__/csv.test.ts`:
 * `toCsv(columns, [])` is the bare header), so a record-free body contains no
 * CRLF and any record guarantees one. A CRLF inside a quoted field cannot
 * cause a false positive, since such a field only exists inside a record.
 */
function hasCsvRecords(csv: string): boolean {
  return csv.replace(/^\uFEFF/, '').includes('\r\n')
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
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null)
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
    truncated,
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

  // Client-side direction + network filters — the LIST endpoint doesn't support
  // these dimensions, so we filter the fetched page in memory. (The export
  // route does, since #2871, which is why `handleExportCsv` sends both and why
  // its result can disagree with what this list shows.) Honest UX caveat: when
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
      buildTransactionScopeSubtitle(
        filters,
        {
          accountNamesById: safeNamesById,
          agentNamesById,
          tokenSymbolsByKey,
        },
        // #2882: "All activity" is the page's loudest completeness claim, and
        // it is the false one when the feed is capped at the explorer window.
        truncated ? 'Recent activity across your accounts.' : undefined,
      ),
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
    // Both notices name the filters as the thing to change; leaving one up
    // once the user has makes it assert something no longer true.
    setExportNotice(null)

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
    setExportNotice(null)
    try {
      const csv = await api.getText(`/transactions/export.csv?${params.toString()}`)
      if (!hasCsvRecords(csv)) {
        // An empty body has two causes and they need different copy: no row
        // matched, or the explorers that feed the aggregation failed. Claiming
        // "nothing matched" during an outage is a confident wrong diagnosis.
        setExportNotice(
          partialFailure
            ? {
                tone: 'info',
                headline: 'Nothing to export yet.',
                detail:
                  'Some accounts failed to load, so there was nothing to write. ' +
                  'Reload the page and try again.',
              }
            : {
                tone: 'info',
                headline: 'Nothing to export.',
                detail: 'No transactions match these filters. Widen them and try again.',
              },
        )
        return
      }
      downloadCsv(csv, buildCsvFilename(new Date()))
    } catch (err) {
      setExportNotice(exportFailureNotice(err))
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

  // Gated on the server's total for the FETCHED filter scope (safeId, agentId,
  // tokenKey — not direction or network, which the list applies in memory),
  // rather than on the rows the browser happens to hold: since #2871 the export
  // covers the whole result set, so gating on `visibleTransactions` would
  // disable the button whenever the loaded page held no row matching the
  // in-memory filter while the server still had plenty. The cost of the looser
  // gate is that the export can legitimately come back empty — which is why
  // that is a designed state below rather than a silent download.
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

      {exportNotice && (
        <div
          role={exportNotice.tone === 'error' ? 'alert' : 'status'}
          className={
            exportNotice.tone === 'error'
              ? 'mb-4 rounded-lg border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]'
              : 'mb-4 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 text-sm text-[var(--v2-ink-2)]'
          }
        >
          <div
            className={
              exportNotice.tone === 'error' ? 'font-medium' : 'font-medium text-[var(--v2-ink)]'
            }
          >
            {exportNotice.headline}
          </div>
          {exportNotice.detail && (
            <div className="mt-1 text-xs">{exportNotice.detail}</div>
          )}
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
              setExportNotice(null)
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
            Showing <span className="v2-tabular">{visibleTransactions.length.toLocaleString('en-US')}</span> of <span className="v2-tabular">{total.toLocaleString('en-US')}</span>
          </span>
        )}
        {/*
          #2882: `total` counts what the explorers returned, not what the
          account holds — each source is capped at a fixed window. This line
          qualifies that count, so it lives inside the count row rather than
          floating above the table. It corrects the SCREEN; the downloaded CSV
          carries no such note, which is recorded on the PR.
        */}
        {!loadingInitial && truncated && (
          <div className="mt-1 w-full text-xs text-[var(--v2-ink-3)]">
            Older transactions aren&apos;t included, so counts and exports cover
            what&apos;s shown here, not your full history.
          </div>
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
            <span className="text-xs text-[var(--v2-ink-3)]">
              {truncated
                ? 'End of the activity loaded here'
                : 'You\u2019ve reached the end'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

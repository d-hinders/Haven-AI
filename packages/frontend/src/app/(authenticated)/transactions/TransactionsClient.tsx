'use client'

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { useContacts } from '@/hooks/useContacts'
import { resolveChainOrNull } from '@/lib/chains'
import { useTransactionFilters } from '@/hooks/useTransactionFilters'
import { browserTimeZone, transactionFilterParams, useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import { hasActiveTransactionFilters, parseTransactionFilters } from '@/lib/transaction-filters'
import { Select } from '@/components/ui/Select'
import {
  buildTransactionScopeSubtitle,
  buildTransactionSummary,
} from '@/lib/transaction-scope'
import type { AggregatedTransaction, TransactionFilterState } from '@/types/transactions'
import { buildCsvFilename, downloadCsv, exportFailureNotice, hasCsvRecords, type ExportNotice } from '@/lib/transaction-csv'
import { api } from '@/lib/api'
import FilterBar from '@/components/transactions/FilterBar'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'

/**
 * The export helpers this page and the account Activity tab (#4098) share —
 * `ExportNotice`, `exportFailureNotice`, `hasCsvRecords` — live in
 * `lib/transaction-csv.ts`, the URL seed and the active-filter switch in
 * `lib/transaction-filters.ts`, and the URL/export param spelling in
 * `useTransactionsFeed.transactionFilterParams`, all shared since #4098 so
 * the two surfaces cannot drift. What is left here is what this page alone
 * decides.
 */

function chainName(chainId: number): string {
  return resolveChainOrNull(chainId)?.name ?? `Chain ${chainId}`
}

export default function TransactionsClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const { resolveAddress } = useContacts()
  const [selectedTx, setSelectedTx] = useState<AggregatedTransaction | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null)
  const [filters, setFilters] = useState<TransactionFilterState>(() =>
    // #4098: the URL seed is shared with the account Activity tab — same
    // validation, same drop rules for values the server would refuse.
    parseTransactionFilters(searchParams),
  )
  const {
    accounts,
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
    failedAccountIds,
    truncated,
    loadMore,
    refresh,
  } = useTransactionsFeed(filters, 25)

  const userAccounts = user?.accounts ?? []
  const hasAccounts = userAccounts.length > 0
  const hasActiveFilters = hasActiveTransactionFilters(filters)

  // Every network by default; the network dropdown narrows to one (#620).
  // There is no active chain to follow since #3719.
  const chainIds = Array.from(new Set(userAccounts.map((s) => s.chain_id))).sort((a, b) => a - b)
  const showNetworkFilter = chainIds.length > 1

  // #4095: direction and network are SERVER-side filters now — the browser
  // filtered the loaded page in memory, which quietly disagreed with the
  // count and the export over the whole result set. What the feed returns
  // is exactly the filtered set, so the table renders it as-is.

  const accountNamesById = new Map(accounts.map((account) => [account.id, account.name]))
  const agentNamesById = new Map(agents.map((agent) => [agent.id, agent.name]))
  const tokenSymbolsByKey = new Map(tokens.map((token) => [token.key, token.symbol]))
  const accountNamesByAddress = new Map(
    userAccounts.map((account) => [
      `${account.account_address.toLowerCase()}:${account.chain_id}`,
      account.name,
    ]),
  )
  const failedAccountNames = failedAccountIds
    .map((id) => accountNamesById.get(id))
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
          accountNamesById,
          agentNamesById,
          tokenSymbolsByKey,
        },
        // #2882: "All activity" is the page's loudest completeness claim, and
        // it is the false one when the feed is capped at the explorer window.
        truncated ? 'Recent activity across your accounts.' : undefined,
      ),
    [filters, accountNamesById, agentNamesById, tokenSymbolsByKey, truncated],
  )

  // Cheap summary stats — count by direction over the filtered rows the
  // server returned. See `buildTransactionSummary` for the mutually-exclusive
  // bucket rule.
  const summary = useMemo(() => buildTransactionSummary(transactions), [transactions])
  const showSummary = hasActiveFilters && transactions.length > 0
  const handleFilterChange = (nextFilters: TransactionFilterState) => {
    setFilters(nextFilters)
    // Both notices name the filters as the thing to change; leaving one up
    // once the user has makes it assert something no longer true.
    setExportNotice(null)

    // #4095: every filter dimension lives in the URL — a shared link (or a
    // refresh) lands on the same filtered feed the sender saw.
    const query = transactionFilterParams(nextFilters).toString()
    router.replace(query ? `/transactions?${query}` : '/transactions', { scroll: false })
  }

  const handleClearFilters = () => {
    handleFilterChange({})
  }

  // The backend generates the file (#2871): it sees the whole filtered result
  // set, where the browser only ever had the pages it had loaded. Every
  // filter the bar applies goes on the query — the same param spelling the
  // page URL and the list request use (#4095), plus the `tz` the server cuts
  // a custom range's calendar days in — so the file and the on-screen rows
  // agree.
  const handleExportCsv = async () => {
    const params = transactionFilterParams(filters)
    if (filters.from && filters.to) params.set('tz', browserTimeZone())

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

  if (!hasAccounts) {
    return (
      <div className="max-w-5xl">
        <PageHeader
          title="Transaction history"
          subtitle="All activity across your accounts."
        />

        <EmptyState
          title="No accounts yet"
          body="Add a Haven account before we can show transaction history."
          action={<Button href="/onboarding">Add account</Button>}
        />
      </div>
    )
  }

  // Gated on the server's total for the FETCHED filter scope. Since #4095
  // every FilterBar dimension — direction, network, search and Period
  // included — rides the list request, so `total` counts exactly the set the
  // export will write: an enabled button cannot produce a no-row file unless
  // an explorer leg failed, and that outage has its own notice below.
  const canExport = !loadingInitial && total > 0

  return (
    <div className="max-w-6xl">
      <PageHeader title="Transaction history" subtitle={subtitle} />

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
            {failedAccountNames.length > 0
              ? `Affected: ${failedAccountNames.join(', ')}.`
              : 'Some network explorers returned partial data.'}{' '}
            Reload the page to try again.
          </div>
        </div>
      )}

      <FilterBar
        filters={filters}
        accounts={accounts}
        agents={agents}
        tokens={tokens}
        loading={filtersLoading}
        error={filtersError}
        onChange={handleFilterChange}
        onExport={() => void handleExportCsv()}
        exporting={exporting}
        canExport={canExport}
      />

      {showNetworkFilter && (
        <div className="mt-3 flex items-center gap-2">
          <label htmlFor="tx-network" className="text-xs font-medium text-[var(--v2-ink-3)]">
            Network
          </label>
          <Select
            id="tx-network"
            aria-label="Filter transactions by network"
            value={filters.chainId === undefined ? 'all' : String(filters.chainId)}
            onChange={(e) => {
              // #4095: the scope rides the list request as `chainId` now —
              // through `handleFilterChange` so it lands in the URL and clears
              // any export notice, like every other filter.
              handleFilterChange({
                ...filters,
                chainId: e.target.value === 'all' ? undefined : Number(e.target.value),
              })
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
                <span className="v2-tabular">{transactions.length}</span> transaction
                {transactions.length !== 1 ? 's' : ''}
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
        {!loadingInitial && hasMore && transactions.length > 0 && (
          <span className="text-xs text-[var(--v2-ink-3)]">
            Showing <span className="v2-tabular">{transactions.length.toLocaleString('en-US')}</span> of <span className="v2-tabular">{total.toLocaleString('en-US')}</span>
          </span>
        )}
        {/*
          #2882/#2884: `total` counts what the explorers returned, not what
          the account holds — each source is read only up to a fixed page
          budget. This line qualifies that count, so it lives inside the count
          row rather than floating above the table.

          Hedged on purpose. The feed stops at the budget when a source has
          more, and a failed leg is unknown rather than capped, so "may not
          be" is true in every state at no cost. It corrects the SCREEN; the
          downloaded CSV carries no such note, which is recorded on the PR.
        */}
        {!loadingInitial && truncated && (
          <div className="w-full text-xs text-[var(--v2-ink-3)]">
            Counts and exports cover the transactions loaded here, which may
            not be your full history.
          </div>
        )}
      </div>

      <Card hover={false}>
        <TransactionsTable
          transactions={transactions}
          loading={loadingInitial}
          error={error}
          onRefresh={() => void refresh()}
          resolveAddress={resolveAddress}
          accountNamesByAddress={accountNamesByAddress}
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
        accountNamesByAddress={accountNamesByAddress}
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
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          ) : (
            <span className="text-xs text-[var(--v2-ink-3)]">
              {truncated
                ? 'End of what\u2019s loaded'
                : 'You\u2019ve reached the end'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

'use client'

/**
 * The account page's Activity tab (#4098, epic #4093): the account's FULL
 * transaction ledger, replacing the 10-row `TransactionsTable` preview the
 * page used to carry.
 *
 * What the tab owns, top to bottom:
 * - the upgraded `FilterBar` from #4095 — search, Initiator, Token,
 *   Direction, Period and Export CSV in one bar, with the Account chip
 *   HIDDEN because this page fixes the account (`hideAccountChip` was built
 *   for exactly this surface);
 * - filters that live in the URL NEXT TO `?tab=activity` (#4097's shell
 *   makes Activity the default tab, so a filtered link is
 *   `/accounts/<id>?search=…` and reproduces the view on any machine);
 * - a result line that never lies about scope: "Showing 14 of 55" while
 *   paging the unfiltered ledger, "N matching" while a filter narrows it,
 *   with `total` and the in/out totals both taken from the SERVER over the
 *   filtered set (#4095) — never summed off whatever page happens to be
 *   loaded — and a qualifier, not a completeness claim, when the feed is
 *   capped at the explorer window (#2882);
 * - rows grouped by day in #4096's ledger mode (`TransactionActivityRow`
 *   with `onOpen`, `TransactionActivityDayHeader`), "Load more" for the next
 *   page, and the shared `TransactionDetailPanel` on row open — click or
 *   Enter/Space, the row is a whole-row button;
 * - two distinct empty states: "No activity yet" with a Receive button for
 *   an account with no history, and "Nothing matches these filters" with a
 *   way to clear them when a filter matches nothing.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Amount, type AmountCurrency } from '@/components/haven/Amount'
import {
  TransactionActivityDayHeader,
  TransactionActivityRow,
  transactionDayGroups,
} from '@/components/haven'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import FilterBar from '@/components/transactions/FilterBar'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import { useActivityMoneyTotals } from '@/hooks/useActivityMoneyTotals'
import { useTransactionFilters } from '@/hooks/useTransactionFilters'
import { browserTimeZone, transactionFilterParams, useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import { api } from '@/lib/api'
import { hasActiveTransactionFilters, parseTransactionFilters } from '@/lib/transaction-filters'
import {
  buildCsvFilename,
  downloadCsv,
  exportFailureNotice,
  hasCsvRecords,
  type ExportNotice,
} from '@/lib/transaction-csv'
import {
  transactionFiat,
  transactionMovement,
  transactionStatus,
  transactionTitle,
} from '@/lib/transaction-presentation'
import { timeAgo } from '@/lib/format'
import type { AggregatedTransaction, TransactionFilterState } from '@/types/transactions'

interface AccountActivityTabProps {
  /** The account whose ledger this is — fixed by the page, never a filter. */
  accountId: string
  /** The user's display currency — the one the feed's fiat figures strike. */
  currency: AmountCurrency
  /** Contact resolution for the panel's counterparty names. */
  resolveAddress: (address: string) => string | null
  /** The user's own accounts by address, for "to your <name>" movement lines. */
  accountNamesByAddress: Map<string, string>
  /** Opens the page's Receive dialog — the empty account's way forward. */
  onReceive: () => void
  /**
   * Bumped by the page after a send or receive lands, so the ledger and its
   * totals re-read the feed instead of waiting for the next poll.
   */
  refreshKey?: number
}

/** One feed row in the ledger — #4096's ledger mode, the page's own copy. */
function ActivityLedgerRow({
  tx,
  resolveAddress,
  accountNamesByAddress,
  onOpen,
}: {
  tx: AggregatedTransaction
  resolveAddress: (address: string) => string | null
  accountNamesByAddress: Map<string, string>
  onOpen: () => void
}) {
  const badge = transactionStatus(tx) ?? tx.statusBadge
  const fiat = transactionFiat(tx)
  return (
    <TransactionActivityRow
      title={transactionTitle(tx)}
      description={transactionMovement(tx, resolveAddress, accountNamesByAddress, { noAddress: true })}
      value={tx.valueFormatted}
      asset={tx.tokenSymbol}
      failed={tx.isError}
      status={badge?.label}
      statusTone={badge?.tone}
      timestamp={timeAgo(tx.timestamp * 1000)}
      direction={tx.direction}
      fiat={{ amount: fiat.amount, currency: fiat.currency, approx: fiat.approx }}
      density="compact"
      onOpen={onOpen}
    />
  )
}

export default function AccountActivityTab({
  accountId,
  currency,
  resolveAddress,
  accountNamesByAddress,
  onReceive,
  refreshKey = 0,
}: AccountActivityTabProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [selectedTx, setSelectedTx] = useState<AggregatedTransaction | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null)
  const [filters, setFilters] = useState<TransactionFilterState>(() => {
    // The page fixes the account, so a stray `accountId` query param is not
    // a filter here — dropped rather than honoured, the same way the hidden
    // Account chip refuses to present it as one.
    const seeded = parseTransactionFilters(searchParams)
    return { ...seeded, accountId: undefined }
  })

  // The feed and its totals read the account's ledger with every FilterBar
  // dimension applied — server-side since #4095 — so the rows, the count
  // line, the in/out totals and the CSV export all describe ONE set.
  const feedFilters = useMemo<TransactionFilterState>(
    () => ({ ...filters, accountId }),
    [filters, accountId],
  )
  const {
    transactions,
    total,
    loadingInitial,
    loadingMore,
    hasMore,
    error,
    partialFailure,
    truncated,
    loadMore,
    refresh: refreshFeed,
  } = useTransactionsFeed(feedFilters, 25)
  const moneyTotals = useActivityMoneyTotals(feedFilters, currency)
  const {
    accounts: filterAccounts,
    agents,
    tokens,
    loading: filtersLoading,
    error: filtersError,
  } = useTransactionFilters()

  const hasActiveFilters = hasActiveTransactionFilters(filters)

  const handleFilterChange = (nextFilters: TransactionFilterState) => {
    // The account is fixed by the page; no filter change may move it.
    const normalized = { ...nextFilters, accountId: undefined }
    setFilters(normalized)
    setExportNotice(null)
    // #4095/#4098: every filter dimension lives in the URL next to the tab —
    // a shared link (or a refresh) lands on the same filtered ledger the
    // sender saw. Activity is the default tab (#4097), so it carries no
    // `tab` parameter of its own.
    const query = transactionFilterParams(normalized).toString()
    router.replace(
      query ? `/accounts/${encodeURIComponent(accountId)}?${query}` : `/accounts/${encodeURIComponent(accountId)}`,
      { scroll: false },
    )
  }

  const handleClearFilters = () => {
    handleFilterChange({})
  }

  // The backend generates the file (#2871): it sees the whole filtered
  // result set, where the browser only ever had the pages it had loaded.
  // Every filter the bar applies goes on the query — the same param
  // spelling the page URL and the list request use (#4095) — plus the
  // fixed account and the `tz` the server cuts a custom range's calendar
  // days in, so the file and the on-screen rows agree.
  const handleExportCsv = async () => {
    const params = transactionFilterParams(feedFilters)
    if (filters.from && filters.to) params.set('tz', browserTimeZone())

    setExporting(true)
    setExportNotice(null)
    try {
      const csv = await api.getText(`/transactions/export.csv?${params.toString()}`)
      if (!hasCsvRecords(csv)) {
        // An empty body has two causes and they need different copy: no row
        // matched, or the explorers that feed the aggregation failed.
        // Claiming "nothing matched" during an outage is a confident wrong
        // diagnosis.
        setExportNotice(
          partialFailure
            ? {
                tone: 'info',
                headline: 'Nothing to export yet.',
                detail:
                  'Some account history failed to load, so there was nothing to write. ' +
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

  // Gated on the server's total for the FETCHED filter scope. Since #4095
  // every FilterBar dimension rides the list request, so `total` counts
  // exactly the set the export will write: an enabled button cannot produce
  // a no-row file unless an explorer leg failed, and that outage has its
  // own notice below.
  const canExport = !loadingInitial && total > 0

  // The page bumps `refreshKey` after a send or receive lands; the ledger
  // and its totals re-read rather than waiting for the next poll. The guard
  // skips the initial mount and any identity churn of the refresh closures.
  const lastRefreshKeyRef = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey === lastRefreshKeyRef.current) return
    lastRefreshKeyRef.current = refreshKey
    void refreshFeed()
    void moneyTotals.refresh()
  }, [refreshKey, refreshFeed, moneyTotals])

  return (
    <div>
      <FilterBar
        filters={filters}
        accounts={filterAccounts}
        agents={agents}
        tokens={tokens}
        loading={filtersLoading}
        error={filtersError}
        onChange={handleFilterChange}
        hideAccountChip
        onExport={() => void handleExportCsv()}
        exporting={exporting}
        canExport={canExport}
      />

      {exportNotice && (
        <div
          role={exportNotice.tone === 'error' ? 'alert' : 'status'}
          className={
            exportNotice.tone === 'error'
              ? 'mt-3 rounded-lg border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]'
              : 'mt-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 text-sm text-[var(--v2-ink-2)]'
          }
        >
          <div
            className={exportNotice.tone === 'error' ? 'font-medium' : 'font-medium text-[var(--v2-ink)]'}
          >
            {exportNotice.headline}
          </div>
          {exportNotice.detail && <div className="mt-1 text-xs">{exportNotice.detail}</div>}
        </div>
      )}

      {partialFailure && (
        <div className="mt-3 rounded-lg border border-warning/20 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-warning)]">
          <div className="font-medium mb-1">Parts of this account's history failed to load.</div>
          <div className="text-xs text-[var(--v2-warning)]">
            Some network explorers returned partial data. Reload the page to try again.
          </div>
        </div>
      )}

      {/* ── The result line: the count, then the money it moved. Both come
          from the server over the filtered set — never off the loaded page. */}
      <div className="mt-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <p className="text-sm text-[var(--v2-ink-3)]">
          {!loadingInitial && total === 0 ? null : loadingInitial ? (
            'Loading activity…'
          ) : hasActiveFilters ? (
            // A filter narrows the set: the server's filtered count is the
            // result, not a page position in it.
            <>
              <span className="v2-tabular">{total.toLocaleString('en-US')}</span> matching
              {truncated ? ' (of what Haven could load)' : ''}
            </>
          ) : (
            // Unfiltered: paging position against the account's whole feed.
            hasMore ? (
              <>
                Showing{' '}
                <span className="v2-tabular">{transactions.length.toLocaleString('en-US')}</span> of{' '}
                <span className="v2-tabular">{total.toLocaleString('en-US')}</span>
              </>
            ) : (
              <>
                <span className="v2-tabular">{total.toLocaleString('en-US')}</span>{' '}
                transaction{total !== 1 ? 's' : ''}
              </>
            )
          )}
          {/* #2882: `total` counts what the explorers returned, not what the
              wallet holds — each source is read only up to a fixed page
              budget. This qualifies the count, hedged on purpose: the feed
              stops at the budget when a source has more, and a failed leg is
              unknown rather than capped, so "may not be" is true in every
              state at no cost. */}
          {!loadingInitial && truncated && (
            <span className="block text-xs">
              Counts and totals cover the history Haven could load, which may not be your full history.
            </span>
          )}
        </p>
        {/* In/out for the filtered set, from the same server-side walk the
            count describes. Hidden while loading and after a failed read —
            no figure is better than a wrong one; the feed's own error state
            carries the retry story. */}
        {!loadingInitial && !moneyTotals.loading && !moneyTotals.error && total > 0 && (
          <p className="text-sm text-[var(--v2-ink-2)]">
            Money in{' '}
            <Amount amount={moneyTotals.moneyIn} currency={currency} approx={moneyTotals.approx} />{' '}
            · Money out{' '}
            <Amount amount={moneyTotals.moneyOut} currency={currency} approx={moneyTotals.approx} />
          </p>
        )}
      </div>

      <Card hover={false} className="mt-3">
        {loadingInitial ? (
          <div className="divide-y divide-[var(--v2-border)]" role="status" aria-busy="true" aria-label="Loading activity">
            {[0, 1, 2].map((item) => (
              <div key={item} className="flex items-center gap-3 px-5 py-3.5">
                <div className="h-9 w-9 rounded-[10px] bg-[var(--v2-surface-2)] animate-pulse" />
                <div className="min-w-0 flex-1">
                  <div className="h-3.5 w-40 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                  <div className="mt-1.5 h-2.5 w-48 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-6">
            <EmptyState
              title="Activity could not load"
              body={error}
              className="py-8"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void refreshFeed()
                    void moneyTotals.refresh()
                  }}
                >
                  Try again
                </Button>
              }
            />
          </div>
        ) : transactions.length === 0 ? (
          <div className="p-6">
            {/* Two empty states, deliberately distinct: a filter that
                matches nothing is one chip away from everything, while an
                account with no history has a next action of its own. */}
            {hasActiveFilters ? (
              <EmptyState
                title="Nothing matches these filters"
                body="No transactions in this account match the filters above."
                className="py-8"
                action={
                  <Button variant="ghost" size="sm" onClick={handleClearFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No activity yet"
                body="Inbound and outbound payments for this Haven wallet will appear here."
                className="py-8"
                action={
                  <Button variant="ghost" size="sm" onClick={onReceive}>
                    Receive
                  </Button>
                }
              />
            )}
          </div>
        ) : (
          <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
            {transactionDayGroups(transactions, (tx) => new Date(tx.timestamp * 1000).toISOString()).map((day) => (
              <div key={day.dayKey}>
                <TransactionActivityDayHeader label={day.label} />
                {day.items.map((tx, index) => (
                  <ActivityLedgerRow
                    key={`${tx.accountId}:${tx.hash}:${tx.type}:${index}`}
                    tx={tx}
                    resolveAddress={resolveAddress}
                    accountNamesByAddress={accountNamesByAddress}
                    onOpen={() => setSelectedTx(tx)}
                  />
                ))}
              </div>
            ))}
            {hasMore ? (
              <div className="flex justify-center px-5 py-4">
                <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <TransactionDetailPanel
        transaction={selectedTx}
        open={selectedTx !== null}
        onClose={() => setSelectedTx(null)}
        resolveAddress={resolveAddress}
        accountNamesByAddress={accountNamesByAddress}
      />
    </div>
  )
}

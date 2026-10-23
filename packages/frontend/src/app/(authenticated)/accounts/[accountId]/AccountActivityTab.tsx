'use client'

/**
 * The account page's Activity tab (#4098, epic #4093): the account's FULL
 * transaction ledger, replacing the 10-row transactions-table preview the
 * page used to carry (the table itself was deleted with #4266).
 *
 * What the tab owns, top to bottom:
 * - the standard list toolbar (#4130, epic #4108) — `ListToolbar` with the
 *   Transactions page's facets WITHOUT Account (the page fixes the account,
 *   so there is nothing to choose; the Network facet lists this account's
 *   one chain and hides itself by the one-option rule), `PeriodPicker` with
 *   the custom range, and Export CSV in the actions slot. The interim
 *   `FilterBar` this tab shipped with is gone from the codebase;
 * - filters that live in the URL through the list-controls codec, NEXT TO
 *   the page's own `?tab=` (the codec leaves `tab` alone) — a filtered link
 *   is `/accounts/<id>?q=…` and reproduces the view on any machine;
 * - a count that never lies about scope — the standard count from the
 *   SERVER over the filtered set (and, filtered, the account's unfiltered
 *   total as the denominator), never summed off whatever page happens to
 *   be loaded — with the #2882 qualifier when the feed is capped at the
 *   explorer window;
 * - rows grouped by day in #4096's ledger mode (`TransactionActivityRow`
 *   with `onOpen`, `TransactionActivityDayHeader`), merchant-first row
 *   titles with the agent as the subtitle (#4166), the shared
 *   `TransactionDetailPanel` on row open — click or Enter/Space, the row is
 *   a whole-row button — and "Show N more" below the card for the next page
 *   (#4196, `ListShowMore`);
 * - two distinct empty states: the standard no-match state when a filter
 *   matches nothing, and "No activity yet" with a Receive button for an
 *   account with no history.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { Amount, type AmountCurrency } from '@/components/haven/Amount'
import {
  TransactionActivityDayHeader,
  TransactionActivityRow,
  transactionDayGroups,
} from '@/components/haven'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ListNoMatch, ListShowMore, ListToolbar } from '@/components/ui/ListToolbar'
import type { ListFacet } from '@/components/ui/FacetMenu'
import type { ListCount, ListNoun } from '@/components/ui/list-controls-copy'
import {
  clearedListState,
  isAllTime,
  type ListState,
  type ListUrlSchema,
} from '@/components/ui/list-url-codec'
import { useListUrlState } from '@/components/ui/useListUrlState'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import { UNPRICED_TOTALS_NOTE } from '@/lib/money-flow-tally'
import { useActivityMoneyTotals } from '@/hooks/useActivityMoneyTotals'
import { useUnfilteredTransactionTotal } from '@/hooks/useUnfilteredTransactionTotal'
import { useTransactionFilters } from '@/hooks/useTransactionFilters'
import { browserTimeZone, transactionFilterParams, useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import { api } from '@/lib/api'
import { agentStatusPresentation } from '@/lib/payment-status'
import {
  transactionChainName,
  transactionTokenLabel,
} from '@/lib/transaction-filters'
import {
  buildCsvFilename,
  downloadCsv,
  exportFailureNotice,
  hasCsvRecords,
  type ExportNotice,
} from '@/lib/transaction-csv'
import {
  counterpartyLabel,
  transactionFiat,
  transactionRowBadge,
} from '@/lib/transaction-presentation'
import { timeAgo } from '@/lib/format'
import type { AggregatedTransaction, TransactionFilterState } from '@/types/transactions'

interface AccountActivityTabProps {
  /** The account whose ledger this is — fixed by the page, never a filter. */
  accountId: string
  /**
   * The account's chain (#4130): the Network facet's one option. A facet
   * with a single possible value hides itself — there is nothing to choose
   * — and its URL `values` keep a foreign `chainId` out of the feed.
   */
  chainId: number
  /** The user's display currency — the one the feed's fiat figures strike. */
  currency: AmountCurrency
  /** Contact resolution for the panel's counterparty names. */
  resolveAddress: (address: string) => string | null
  /**
   * The user's own accounts by address — `counterpartyLabel`'s own-account
   * map, naming a transfer between accounts (#4099).
   */
  accountNamesByAddress: Map<string, string>
  /** Opens the page's Receive dialog — the empty account's way forward. */
  onReceive: () => void
  /**
   * Bumped by the page after a send or receive lands, so the ledger and its
   * totals re-read the feed instead of waiting for the next poll.
   */
  refreshKey?: number
}

const transactionNoun: ListNoun = { one: 'transaction', other: 'transactions' }

/** One page of the feed, and what "Show N more" adds (#4196). */
const ACTIVITY_PAGE_SIZE = 25

/**
 * The tab's URL keys (#4130, the list-controls codec), alongside the page's
 * own `tab` — the codec never touches keys it does not own. Every key keeps
 * the name it had under `FilterBar`, except search: it is written as `q`
 * now, and the old `search` key is still READ, so a link from before the
 * move keeps its search. `accountId` is deliberately absent — the page
 * fixes the account, so the parameter is not a filter here and a stray one
 * is dropped on arrival.
 */
function activityUrlSchema(chainId: number): ListUrlSchema {
  return {
    search: { aliases: ['search'] },
    facets: [
      { id: 'agentId' },
      { id: 'tokenKey' },
      { id: 'direction', values: ['in', 'out'] },
      // The account's one chain: the only value the feed may be narrowed
      // by, so a stale link's anything else reads as no filter.
      { id: 'chainId', values: [String(chainId)] },
    ],
    period: { allowCustom: true },
  }
}

/**
 * The toolbar's state as the filters the feed and the export send. There is
 * no `accountId` here: the page fixes the account, and the feed filters get
 * it merged in — the fixed account can never masquerade as a user-applied
 * filter (#4098's rule, unchanged).
 */
function listStateToFilters(state: ListState): TransactionFilterState {
  const first = (id: string): string | undefined => state.facets[id]?.[0]
  const direction = first('direction')
  const chainId = Number(first('chainId'))
  const search = state.q.trim()
  const period = state.period ?? {}
  return {
    agentId: first('agentId'),
    tokenKey: first('tokenKey'),
    direction: direction === 'in' || direction === 'out' ? direction : undefined,
    chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : undefined,
    search: search || undefined,
    period: period.preset,
    from: period.from && period.to ? period.from : undefined,
    to: period.from && period.to ? period.to : undefined,
  }
}

/**
 * One figure on the list summary line: the short visible label ("In") so the
 * line fits a phone beside the count (#4108 follow-up to #4196), and the full
 * name ("Money in") for screen readers, read before the amount — the naming
 * the account summary card uses (#4197).
 */
function TotalFigure({ short, name, children }: { short: string; name: string; children: ReactNode }) {
  return (
    <span data-testid="activity-total">
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{name}</span> {children}
    </span>
  )
}

/**
 * One feed row in the ledger — #4096's ledger mode, the account page's own
 * copy (#4166): the title is WHO WAS PAID — `counterpartyLabel` in the
 * dashboard's no-address mode, the merchant or counterparty first — with the
 * agent as the subtitle, exactly the dashboard row's anatomy — the same
 * title `/transactions` and the detail panel use (#4266, #4267).
 *
 * The movement line is gone with it: the page fixes the account, so its
 * "From <this account> →" half repeated the page on every row (#4166 — done
 * here in the row's props, not in the shared helper). What the movement line
 * used to say is carried by the row itself — the counterparty is the title,
 * the fixed account is the page — and the agent moves into the subtitle.
 */
function ActivityLedgerRow({
  tx,
  resolveAddress,
  accountNamesByAddress,
  onOpen,
  insetDivider,
}: {
  tx: AggregatedTransaction
  resolveAddress: (address: string) => string | null
  accountNamesByAddress: Map<string, string>
  onOpen: () => void
  /** #4165: the same-day inset hairline, on every row after a day's first. */
  insetDivider: boolean
}) {
  const badge = transactionRowBadge(tx)
  const fiat = transactionFiat(tx, 'row')
  return (
    <TransactionActivityRow
      title={counterpartyLabel(tx, resolveAddress, accountNamesByAddress, { noAddress: true })}
      description={tx.agentName ?? undefined}
      value={tx.valueFormatted}
      asset={tx.tokenSymbol}
      failed={tx.isError}
      status={badge?.label}
      statusTone={badge?.tone}
      timestamp={timeAgo(tx.timestamp * 1000)}
      direction={tx.direction}
      fiat={fiat}
      density="compact"
      onOpen={onOpen}
      insetDivider={insetDivider}
    />
  )
}

export default function AccountActivityTab({
  accountId,
  chainId,
  currency,
  resolveAddress,
  accountNamesByAddress,
  onReceive,
  refreshKey = 0,
}: AccountActivityTabProps) {
  const searchParams = useSearchParams()
  const [selectedTx, setSelectedTx] = useState<AggregatedTransaction | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null)

  // #4130: every filter dimension lives in the URL through the list-controls
  // codec — a shared link (or a refresh) lands on the same filtered ledger
  // the sender saw (#4095/#4098), and back/forward re-seeds it. The codec
  // writes only its own keys, so the page's `tab` rides along untouched.
  // Memoised on the one dynamic input: the schema must be referentially
  // stable or a pending search commit would be re-parsed away on re-render.
  const urlSchema = useMemo(() => activityUrlSchema(chainId), [chainId])
  const [listState, setListState] = useListUrlState(urlSchema, { filtering: 'server' })

  // One repair, on arrival: a stray `accountId` query param is not a filter
  // here — the page fixes the account, so the parameter is dropped rather
  // than honoured, the same way the tab's facet set refuses to present one.
  // (The codec only sets or deletes its OWN keys, so this is done by hand.)
  const hasStrayAccountKey = searchParams?.has('accountId') ?? false
  useEffect(() => {
    if (!hasStrayAccountKey || typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    params.delete('accountId')
    const next = params.toString()
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${next ? `?${next}` : ''}`)
    } catch {
      // A URL that stays in step is a convenience, never worth a thrown render.
    }
  }, [hasStrayAccountKey])

  const filters = useMemo(() => listStateToFilters(listState), [listState])

  // The feed and its totals read the account's ledger with every toolbar
  // dimension applied — server-side since #4095 — so the rows, the count,
  // the in/out totals and the CSV export all describe ONE set.
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
  } = useTransactionsFeed(feedFilters, ACTIVITY_PAGE_SIZE)
  const moneyTotals = useActivityMoneyTotals(feedFilters, currency)
  const { agents, tokens, error: filtersError } = useTransactionFilters()

  // Active means "differs from the page default" (#4110): no search, every
  // facet All, All time — the same rule the toolbar applies to its chips.
  const hasActiveFilters =
    listState.q.trim() !== '' ||
    Object.values(listState.facets).some((values) => values.length > 0) ||
    !isAllTime(listState.period)

  const unfilteredTotal = useUnfilteredTransactionTotal({
    filtered: hasActiveFilters,
    feedTotal: total,
    feedLoading: loadingInitial,
    accountId,
  })

  // Agents in the order the bar has listed them since #4095: active, paused,
  // the rest; a status other than Active is named, since a revoked agent's
  // history still lives here.
  const agentRank = (status: string) => (status === 'active' ? 0 : status === 'paused' ? 1 : 2)
  const sortedAgents = [...agents].sort(
    (a, b) => agentRank(a.status) - agentRank(b.status) || a.name.localeCompare(b.name),
  )

  // The Transactions page's facets (#4111) WITHOUT Account: the page fixes
  // the account, so there is no Account facet to hide — a filter that could
  // not be chosen has no trigger, no chip and no URL key here. Network
  // carries this account's single chain and hides itself (one option).
  const facets: ListFacet[] = [
    {
      id: 'agentId',
      label: 'Initiator',
      options: [
        { value: 'user', label: 'User (manual)' },
        ...sortedAgents.map((agent) => ({
          value: agent.id,
          label:
            agent.status === 'active'
              ? agent.name
              : `${agent.name} (${agentStatusPresentation(agent.status).label})`,
        })),
      ],
    },
    {
      id: 'tokenKey',
      label: 'Token',
      options: tokens.map((token) => ({ value: token.key, label: transactionTokenLabel(token) })),
    },
    {
      id: 'direction',
      label: 'Direction',
      options: [
        { value: 'in', label: 'Incoming' },
        { value: 'out', label: 'Outgoing' },
      ],
    },
    {
      id: 'chainId',
      label: 'Network',
      options: [{ value: String(chainId), label: transactionChainName(chainId) }],
    },
  ]

  const handleListChange = (next: ListState) => {
    setListState(next)
    // Both notices name the filters as the thing to change; leaving one up
    // once the user has makes it assert something no longer true.
    setExportNotice(null)
  }

  // Clear filters returns to the page default, the same state the toolbar's
  // own Clear filters reaches.
  const handleClearFilters = () => {
    handleListChange(clearedListState(listState, urlSchema))
  }

  // The backend generates the file (#2871): it sees the whole filtered
  // result set, where the browser only ever had the pages it had loaded.
  // Every filter the toolbar applies goes on the query — in the API's
  // parameter spelling (`transactionFilterParams`, the same builder the list
  // request uses — the URL writes search as `q` since #4130) — plus the
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
  // every filter dimension rides the list request, so `total` counts
  // exactly the set the export will write: an enabled button cannot produce
  // a no-row file unless an explorer leg failed, and that outage has its
  // own notice below.
  const canExport = !loadingInitial && total > 0

  // #4130: the standard count, both numbers from the server. Unfiltered it
  // is the feed's total; filtered, "{shown} of {total}" against the
  // ACCOUNT's unfiltered total — never loaded rows against a server figure.
  const count: ListCount | null = loadingInitial
    ? null
    : !hasActiveFilters
      ? { shown: total, total }
      : // Unknown, or for a moment behind the polled feed: no figure rather
        // than "26 of 25".
        unfilteredTotal === null || unfilteredTotal < total
        ? null
        : { shown: total, total: unfilteredTotal }
  const showNoMatch = hasActiveFilters && !loadingInitial && !error && transactions.length === 0
  const showTotals = !loadingInitial && !moneyTotals.loading && !moneyTotals.error && total > 0

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
      <ListToolbar
        noun={transactionNoun}
        state={listState}
        onChange={handleListChange}
        filtering="server"
        facets={facets}
        period={{ allowCustom: true }}
        searchDescription="by name, agent or address"
        count={count}
        summary={showTotals ? (
          // The money the filtered set moved, from the same server-side walk
          // the count describes. Hidden while loading and after a failed read
          // — no figure is better than a wrong one; the feed's own error
          // state carries the retry story.
          <span data-testid="activity-totals">
            <TotalFigure short="In" name="Money in">
              <Amount amount={moneyTotals.moneyIn} currency={currency} approx={moneyTotals.approxIn} />
            </TotalFigure>{' '}
            ·{' '}
            <TotalFigure short="Out" name="Money out">
              <Amount amount={moneyTotals.moneyOut} currency={currency} approx={moneyTotals.approxOut} />
            </TotalFigure>
          </span>
        ) : undefined}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleExportCsv()}
            disabled={!canExport || exporting}
            aria-busy={exporting}
            className="min-h-11 w-full sm:min-h-0 sm:w-auto"
          >
            {exporting ? 'Preparing…' : 'Export CSV'}
          </Button>
        }
      />

      {/* The hedges that qualify the summary line sit directly under it
          (#4196), before any callout. */}
      {/* #4165: rows the totals could not value are said in words, never
          folded into a "≈" — the mark means converted, nothing else. */}
      {showTotals && moneyTotals.unpriced ? (
        <p className="mt-1 px-0.5 text-xs text-[var(--v2-ink-3)]">{UNPRICED_TOTALS_NOTE}</p>
      ) : null}
      {/* #2882: `total` counts what the explorers returned, not what the
          wallet holds — each source is read only up to a fixed page budget.
          This qualifies the count, hedged on purpose: the feed stops at the
          budget when a source has more, and a failed leg is unknown rather
          than capped, so "may not be" is true in every state at no cost. */}
      {!loadingInitial && truncated && (
        <p className="mt-1 px-0.5 text-xs text-[var(--v2-ink-3)]">
          Counts and totals cover the history Haven could load, which may not be your full history.
        </p>
      )}

      {filtersError && (
        <p role="alert" className="mt-2 text-xs text-[var(--v2-danger)]">
          {filtersError}
        </p>
      )}

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


      {showNoMatch ? (
        // The standard no-match state (#4110): it sits where the rows were —
        // in place of the list card, not inside it (an EmptyState is its own
        // surface) — and leaves the toolbar in place, so the cause stays
        // editable.
        <div className="mt-3" data-testid="activity-no-match">
          <ListNoMatch noun={transactionNoun} onClear={handleClearFilters} />
        </div>
      ) : (
        <Card hover={false} className="mt-3 overflow-hidden">
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
              {/* An account with no history has a next action of its own;
                  a filter that matches nothing is the no-match state above
                  and never reaches here. */}
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
                      insetDivider={index > 0}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {!showNoMatch && !loadingInitial && !error && (
        <ListShowMore
          loaded={transactions.length}
          total={total}
          pageSize={ACTIVITY_PAGE_SIZE}
          hasMore={hasMore}
          loading={loadingMore}
          onShowMore={() => void loadMore()}
        />
      )}

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

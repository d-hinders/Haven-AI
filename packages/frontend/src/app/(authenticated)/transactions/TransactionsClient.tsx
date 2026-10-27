'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useContacts } from '@/hooks/useContacts'
import { agentFacetOptions } from '@/lib/agent-facet'
import { useActivityMoneyTotals } from '@/hooks/useActivityMoneyTotals'
import { useTransactionFilters } from '@/hooks/useTransactionFilters'
import {
  browserTimeZone,
  transactionFilterParams,
  useTransactionsFeed,
} from '@/hooks/useTransactionsFeed'
import { useUnfilteredTransactionTotal } from '@/hooks/useUnfilteredTransactionTotal'
import { buildTransactionScopeSubtitle } from '@/lib/transaction-scope'
import {
  transactionChainName,
  transactionChainLabel,
  transactionTokenLabel,
} from '@/lib/transaction-filters'
import type {
  AggregatedTransaction,
  TransactionFilterState,
} from '@/types/transactions'
import { UNPRICED_TOTALS_NOTE } from '@/lib/money-flow-tally'
import { Amount, type AmountCurrency } from '@/components/haven/Amount'
import {
  TransactionActivityDayHeader,
  transactionDayGroups,
} from '@/components/haven'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import TransactionsLedgerRow from '@/components/transactions/TransactionsLedgerRow'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { ListExportAction, ListExportNotice, useListExport, type ListExportRequest } from '@/components/ui/ListExportAction'
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

const transactionNoun: ListNoun = { one: 'transaction', other: 'transactions' }

/** One page of the feed, and what "Show N more" adds (#4196). */
const TRANSACTIONS_PAGE_SIZE = 25

/**
 * The page URL's keys (#4111, the list-controls codec). Every key keeps the
 * name and value format it had under `FilterBar`, except search: it is
 * written as `q` now, and the old `search` key is still READ, so a link
 * from before the move keeps its search. No facet lists its `values`: the
 * account, agent and token options load asynchronously, and a value read
 * before they arrive must survive. Direction's two values are fixed.
 */
const transactionsUrlSchema: ListUrlSchema = {
  search: { aliases: ['search'] },
  facets: [
    { id: 'accountId' },
    { id: 'agentId' },
    { id: 'tokenKey' },
    { id: 'direction', values: ['in', 'out'] },
    { id: 'chainId' },
  ],
  period: { allowCustom: true },
}

/**
 * The toolbar's state as the filters the feed, its totals and the export
 * send. A network that is not a positive integer is dropped here, as the URL
 * reader before #4111 dropped it. `foldOwnTransfers` is this page's own
 * projection (#4266): a move between the user's accounts is one row, and the
 * shared serializer carries it onto every request.
 */
function listStateToFilters(state: ListState): TransactionFilterState {
  const first = (id: string): string | undefined => state.facets[id]?.[0]
  const direction = first('direction')
  const chainId = Number(first('chainId'))
  const search = state.q.trim()
  const period = state.period ?? {}
  return {
    accountId: first('accountId'),
    agentId: first('agentId'),
    tokenKey: first('tokenKey'),
    direction: direction === 'in' || direction === 'out' ? direction : undefined,
    chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : undefined,
    search: search || undefined,
    period: period.preset,
    from: period.from && period.to ? period.from : undefined,
    to: period.from && period.to ? period.to : undefined,
    foldOwnTransfers: true,
  }
}

/**
 * One figure on the summary line — the account Activity tab's anatomy
 * (#4098): the short visible label ("In") so the line fits a phone beside
 * the count, and the full name ("Money in") for screen readers.
 */
function TotalFigure({ short, name, children }: { short: string; name: string; children: ReactNode }) {
  return (
    <span data-testid="transactions-total">
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{name}</span> {children}
    </span>
  )
}

export default function TransactionsClient() {
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const { resolveAddress } = useContacts()
  const { currency } = usePreferences()
  const [selectedTx, setSelectedTx] = useState<AggregatedTransaction | null>(null)
  // #4111: every filter dimension lives in the URL through the list-controls
  // codec — a shared link (or a refresh) lands on the same filtered feed the
  // sender saw (#4095), and back/forward re-seeds it.
  const [listState, setListState, { searchEpoch, bumpSearchEpoch }] = useListUrlState(transactionsUrlSchema, { filtering: 'server' })
  const filters = useMemo(() => listStateToFilters(listState), [listState])

  // Two links are repaired once, on arrival. One from before #4111 names the
  // search `search`: it is read as `q` already, and rewriting the address
  // makes the URL converge on one name. One whose `chainId` is not a positive
  // integer was ignored by the reader before #4111; the codec keeps unknown
  // values for facets whose options load late, so it is dropped here rather
  // than raising a "Network" chip over an unfiltered feed.
  const hasLegacySearchKey = searchParams?.has('search') ?? false
  const invalidChainId =
    listState.facets.chainId?.length === 1 && listStateToFilters(listState).chainId === undefined
  useEffect(() => {
    if (!hasLegacySearchKey && !invalidChainId) return
    setListState(invalidChainId ? { ...listState, facets: { ...listState.facets, chainId: [] } } : listState)
    // Once per bad link: the rewrite removes what it keys on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLegacySearchKey, invalidChainId])

  const {
    accounts,
    agents,
    tokens,
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
  } = useTransactionsFeed(filters, TRANSACTIONS_PAGE_SIZE)
  // In and Out over the whole filtered set (#4266), from the same
  // server-filtered, folded feed the list pages through — so a move between
  // the user's accounts counts as neither, and the figures follow every
  // toolbar dimension the count does.
  const displayCurrency: AmountCurrency = currency
  const moneyTotals = useActivityMoneyTotals(filters, displayCurrency)

  const userAccounts = user?.accounts ?? []
  const hasAccounts = userAccounts.length > 0
  // Active means "differs from the page default" (#4110), and this page's
  // default is unfiltered: no search, every facet All, All time — the same
  // rule the toolbar applies to its chips and count.
  const hasActiveFilters =
    listState.q.trim() !== '' ||
    Object.values(listState.facets).some((values) => values.length > 0) ||
    !isAllTime(listState.period)
  const unfilteredTotal = useUnfilteredTransactionTotal({
    filtered: hasActiveFilters,
    feedTotal: total,
    feedLoading: loadingInitial,
    foldOwnTransfers: true,
  })

  // Every network by default; the Network facet narrows to one (#620). There
  // is no active chain to follow since #3719. With one network the facet
  // has one option, and the toolbar hides it.
  const chainIds = Array.from(new Set(userAccounts.map((s) => s.chain_id))).sort((a, b) => a - b)
  const accountChainCount = new Set(accounts.map((account) => account.chainId)).size

  // Agents in the order `FilterBar` listed them: active, paused, needs setup,
  // the rest; a status other than Active rides in the option's `meta` slot
  // (#4150), since a revoked agent's history still lives here. The order, the
  // status suffix and the inactive group are one shared decision (#4453).
  const agentOptions = agentFacetOptions(agents, [{ value: 'user', label: 'User (manual)' }])
  const facets: ListFacet[] = [
    {
      id: 'accountId',
      label: 'Account',
      options: accounts.map((account) => ({
        value: account.id,
        // Two accounts can share a name across networks; the network tells
        // them apart, as the token options already do.
        label: accountChainCount > 1 ? `${account.name} (${transactionChainLabel(account.chainId)})` : account.name,
      })),
    },
    {
      id: 'agentId',
      label: 'Initiator',
      options: agentOptions,
    },
    {
      id: 'tokenKey',
      label: 'Token',
      options: tokens.map((token) => ({ value: token.key, label: transactionTokenLabel(token) })),
    },
    {
      id: 'direction',
      label: 'Direction',
      values: ['in', 'out'],
      options: [
        { value: 'in', label: 'Incoming' },
        { value: 'out', label: 'Outgoing' },
      ],
    },
    {
      id: 'chainId',
      label: 'Network',
      options: chainIds.map((id) => ({ value: String(id), label: transactionChainName(id) })),
    },
  ]

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

  const handleListChange = (next: ListState) => {
    setListState(next)
    // Both notices name the filters as the thing to change; leaving one up
    // once the user has makes it assert something no longer true. The
    // export's clears itself: the request below moves with the filters.
  }

  // Clear filters returns to the page default, the same state the toolbar's
  // own Clear filters reaches.
  const handleClearFilters = () => {
    // Bump the clear generation (#4150): a draft typed less than 300 ms ago
    // must not commit after the clear when q was already empty.
    bumpSearchEpoch()
    handleListChange(clearedListState(listState, transactionsUrlSchema))
  }

  // The backend generates the file (#2871): it sees the whole filtered result
  // set, where the browser only ever had the pages it had loaded. Every
  // filter the toolbar applies goes on the query, in the API's parameter
  // names (`transactionFilterParams`, the list request's own serializer,
  // separate from the URL codec since #4111 — the fold rides it too, #4266),
  // plus the `tz` the server cuts a custom range's calendar days in — so the
  // file and the on-screen rows agree.
  const exportRequest = useMemo<ListExportRequest>(() => {
    const params = transactionFilterParams(filters)
    if (filters.from && filters.to) params.set('tz', browserTimeZone())
    return { path: '/transactions/export.csv', params }
  }, [filters])

  // The export is gated on the server's total for the FETCHED filter scope.
  // Since #4095 every filter dimension — direction, network, search and
  // Period included — rides the list request, so `total` counts exactly the
  // set the export will write: an enabled button cannot produce a no-row
  // file unless an explorer leg failed, and that outage has its own notice.
  const listExport = useListExport({
    request: exportRequest,
    exportable: !loadingInitial && total > 0,
    filenamePrefix: 'haven-transactions',
    emptyNotice: () =>
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
  })

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

  // #4111: the standard count, both numbers from the server. Unfiltered it
  // is the feed's total; filtered, "{shown} of {total}" against the
  // server's unfiltered total — never loaded rows against a server figure.
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
  // With one account, naming it on every row would repeat the page (#4266).
  const showAccountOnRows = userAccounts.length > 1

  return (
    <div className="max-w-6xl">
      <PageHeader title="Transaction history" subtitle={subtitle} />

      <ListExportNotice notice={listExport.notice} className="mb-4" />

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
          // In and Out over the filtered set (#4266), the account Activity
          // tab's line. Hidden while loading and after a failed read — no
          // figure is better than a wrong one. A Direction filter already
          // fixes one half, so only the other is shown — never "In 0" under
          // Direction: Outgoing.
          <span data-testid="transactions-totals">
            {[
              filters.direction !== 'out' ? (
                <TotalFigure key="in" short="In" name="Money in">
                  <Amount amount={moneyTotals.moneyIn} currency={displayCurrency} approx={moneyTotals.approxIn} />
                </TotalFigure>
              ) : null,
              filters.direction !== 'in' ? (
                <TotalFigure key="out" short="Out" name="Money out">
                  <Amount amount={moneyTotals.moneyOut} currency={displayCurrency} approx={moneyTotals.approxOut} />
                </TotalFigure>
              ) : null,
            ]
              .filter((part) => part !== null)
              .flatMap((part, i) => (i === 0 ? [part] : [' · ', part]))}
          </span>
        ) : undefined}
        searchEpoch={searchEpoch}
        actions={<ListExportAction state={listExport} />}
      />

      {/*
        #2882/#2884: `total` counts what the explorers returned, not what
        the account holds — each source is read only up to a fixed page
        budget. This line qualifies the count, so it sits directly beneath
        the summary line (#4196) rather than floating above the table.

        Hedged on purpose. The feed stops at the budget when a source has
        more, and a failed leg is unknown rather than capped, so "may not
        be" is true in every state at no cost. It corrects the SCREEN; the
        downloaded CSV carries no such note, which is recorded on the PR.
      */}
      {/* #4165: rows the totals could not value are said in words, never
          folded into a "≈" — the mark means converted, nothing else. */}
      {showTotals && moneyTotals.unpriced ? (
        <p className="mt-1 px-0.5 text-xs text-[var(--v2-ink-3)]">{UNPRICED_TOTALS_NOTE}</p>
      ) : null}
      {!loadingInitial && truncated && (
        <p className="mt-1 px-0.5 text-xs text-[var(--v2-ink-3)]">
          Counts, totals and exports cover the transactions loaded here, which
          may not be your full history.
        </p>
      )}

      {/* After the hedge, so the hedge stays under the count it
          qualifies (#4196). */}
      {filtersError && (
        <p role="alert" className="mt-2 text-xs text-[var(--v2-danger)]">
          {filtersError}
        </p>
      )}

      {showNoMatch ? (
        // The standard no-match state (#4110): it sits where the rows were —
        // in place of the list card, not inside it (an EmptyState is its own
        // surface) — and leaves the toolbar in place, so the cause stays
        // editable.
        <div className="mt-3" data-testid="transactions-no-match">
          <ListNoMatch noun={transactionNoun} onClear={handleClearFilters} />
        </div>
      ) : (
        <Card hover={false} className="mt-3 overflow-hidden">
          {loadingInitial ? (
            <div className="divide-y divide-[var(--v2-border)]" role="status" aria-busy="true" aria-label="Loading transactions">
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
                title="Transactions could not load"
                body={error}
                className="py-8"
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void refresh()
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
              {/* A filter that matches nothing is the no-match state above
                  and never reaches here. */}
              <EmptyState
                title="No activity yet"
                body="Payments and account funding activity will appear here."
                className="py-8"
                action={
                  <Button href="/dashboard" variant="ghost" size="sm">
                    Open dashboard
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in" data-testid="transactions-ledger">
              {transactionDayGroups(transactions, (tx) => new Date(tx.timestamp * 1000).toISOString()).map((day) => (
                <div key={day.dayKey}>
                  <TransactionActivityDayHeader label={day.label} />
                  {day.items.map((tx, index) => (
                    <TransactionsLedgerRow
                      key={`${tx.accountId}:${tx.hash}:${tx.type}:${index}`}
                      tx={tx}
                      resolveAddress={resolveAddress}
                      accountNamesByAddress={accountNamesByAddress}
                      showAccount={showAccountOnRows}
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

      <TransactionDetailPanel
        transaction={selectedTx}
        open={selectedTx !== null}
        onClose={() => setSelectedTx(null)}
        resolveAddress={resolveAddress}
        accountNamesByAddress={accountNamesByAddress}
      />

      {!showNoMatch && !loadingInitial && !error && (
        <ListShowMore
          loaded={transactions.length}
          total={total}
          pageSize={TRANSACTIONS_PAGE_SIZE}
          hasMore={hasMore}
          loading={loadingMore}
          onShowMore={() => void loadMore()}
        />
      )}
    </div>
  )
}

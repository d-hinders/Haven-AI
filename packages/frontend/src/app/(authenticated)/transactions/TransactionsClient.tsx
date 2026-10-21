'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { useContacts } from '@/hooks/useContacts'
import { agentStatusPresentation } from '@/lib/payment-status'
import { useTransactionFilters } from '@/hooks/useTransactionFilters'
import { browserTimeZone, useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import { useUnfilteredTransactionTotal } from '@/hooks/useUnfilteredTransactionTotal'
import {
  buildTransactionScopeSubtitle,
  buildTransactionSummary,
} from '@/lib/transaction-scope'
import {
  transactionChainName,
  transactionChainLabel,
  transactionTokenLabel,
} from '@/lib/transaction-filters'
import type {
  AggregatedTransaction,
  TransactionFilterState,
} from '@/types/transactions'
import { buildCsvFilename, downloadCsv } from '@/lib/transaction-csv'
import { api, ApiRequestError } from '@/lib/api'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
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
 * The export applies the same filters the list applies — server-side, since
 * #4095 — so the file and the table agree by construction; what this still
 * catches is the empty result set, which is read back off the body and
 * reported rather than silently handed to the user as a header-only file.
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
 * The toolbar's state as the filters the feed and the export send. A
 * network that is not a positive integer is dropped here, as the URL
 * reader before #4111 dropped it.
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
  }
}

/**
 * The export request's query: the API's own parameter names, which are NOT
 * the page URL's (#4111). The URL writes search as `q`; the backend reads
 * `search`, and this builder is the one place that says so, so renaming a
 * URL key can never drop a filter from the file. The list request has its
 * twin in `useTransactionsFeed`'s `toQueryString`.
 */
function filtersToApiParams(filters: TransactionFilterState): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.accountId) params.set('accountId', filters.accountId)
  if (filters.agentId) params.set('agentId', filters.agentId)
  if (filters.tokenKey) params.set('tokenKey', filters.tokenKey)
  if (filters.direction) params.set('direction', filters.direction)
  if (filters.chainId !== undefined) params.set('chainId', String(filters.chainId))
  const search = filters.search?.trim()
  if (search) params.set('search', search)
  if (filters.period) {
    params.set('period', filters.period)
  } else if (filters.from && filters.to) {
    params.set('from', filters.from)
    params.set('to', filters.to)
  }
  return params
}

export default function TransactionsClient() {
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const { resolveAddress } = useContacts()
  const [selectedTx, setSelectedTx] = useState<AggregatedTransaction | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null)
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
  })

  // Every network by default; the Network facet narrows to one (#620). There
  // is no active chain to follow since #3719. With one network the facet
  // has one option, and the toolbar hides it.
  const chainIds = Array.from(new Set(userAccounts.map((s) => s.chain_id))).sort((a, b) => a - b)
  const accountChainCount = new Set(accounts.map((account) => account.chainId)).size

  // Agents in the order `FilterBar` listed them: active, paused, the rest;
  // a status other than Active is named, since a revoked agent's history
  // still lives here.
  const agentRank = (status: string) => (status === 'active' ? 0 : status === 'paused' ? 1 : 2)
  const sortedAgents = [...agents].sort(
    (a, b) => agentRank(a.status) - agentRank(b.status) || a.name.localeCompare(b.name),
  )
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
      options: [
        { value: 'user', label: 'User (manual)' },
        ...sortedAgents.map((agent) => ({
          value: agent.id,
          label: agent.name,
          // The status is the option's `meta` slot (#4150), not part of the
          // label: the menu row, phone-sheet row and chip always show it,
          // even where the name alone loses its tail to truncation.
          ...(agent.status === 'active' ? {} : { meta: agentStatusPresentation(agent.status).label }),
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

  // Cheap summary stats — count by direction over the filtered rows the
  // server returned. See `buildTransactionSummary` for the mutually-exclusive
  // bucket rule.
  const summary = useMemo(() => buildTransactionSummary(transactions), [transactions])
  const showSummary = hasActiveFilters && transactions.length > 0
  const handleListChange = (next: ListState) => {
    setListState(next)
    // Both notices name the filters as the thing to change; leaving one up
    // once the user has makes it assert something no longer true.
    setExportNotice(null)
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
  // names (`filtersToApiParams`, separate from the URL codec since #4111),
  // plus the `tz` the server cuts a custom range's calendar days in — so the
  // file and the on-screen rows agree.
  const handleExportCsv = async () => {
    const params = filtersToApiParams(filters)
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
  // every filter dimension — direction, network, search and Period
  // included — rides the list request, so `total` counts exactly the set the
  // export will write: an enabled button cannot produce a no-row file unless
  // an explorer leg failed, and that outage has its own notice below.
  const canExport = !loadingInitial && total > 0

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

      <ListToolbar
        noun={transactionNoun}
        state={listState}
        onChange={handleListChange}
        filtering="server"
        facets={facets}
        period={{ allowCustom: true }}
        searchDescription="by name, agent or address"
        count={count}
        summary={showSummary ? (
          // A Direction filter already fixes one half, so only the other
          // is shown — never "0 received" under Direction: Outgoing.
          <span data-testid="transactions-totals" className="inline-flex flex-wrap items-baseline gap-x-1.5">
            {[
              filters.direction !== 'out' ? (
                <span key="received">
                  <span className="v2-tabular font-medium text-[var(--v2-success)]">{summary.received}</span> received
                </span>
              ) : null,
              filters.direction !== 'in' ? (
                <span key="sent">
                  <span className="v2-tabular font-medium text-[var(--v2-debit)]">{summary.sent}</span> sent
                </span>
              ) : null,
              summary.failed > 0 ? (
                <span key="failed">
                  <span className="v2-tabular font-medium text-[var(--v2-danger)]">{summary.failed}</span> failed
                </span>
              ) : null,
            ]
              .filter((part) => part !== null)
              .flatMap((part, i) => (i === 0 ? [part] : [<span key={`sep-${i}`} aria-hidden="true">·</span>, part]))}
            {hasMore ? <span className="text-[var(--v2-ink-3)]">(loaded results)</span> : null}
          </span>
        ) : undefined}
        searchEpoch={searchEpoch}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleExportCsv()}
            disabled={!canExport || exporting}
            aria-busy={exporting}
          >
            {exporting ? 'Preparing…' : 'Export CSV'}
          </Button>
        }
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
      {!loadingInitial && truncated && (
        <p className="mt-1 px-0.5 text-xs text-[var(--v2-ink-3)]">
          Counts and exports cover the transactions loaded here, which may
          not be your full history.
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
        <Card hover={false} className="mt-3">
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

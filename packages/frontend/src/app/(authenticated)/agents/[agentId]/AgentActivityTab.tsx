'use client'

/**
 * The agent page's Activity tab (#4226, epic #4224): the agent's OWN payment
 * ledger — `payment_intents`, failed and pending included — drawn with the
 * shared ledger pieces (`TransactionActivityRow` ledger mode under
 * `TransactionActivityDayHeader` bands), the standard toolbar (search, Status,
 * Token, Period), the summary line and `ListShowMore`.
 *
 * The population is deliberately NOT the wallet-scoped transactions feed:
 * `routes/transactions.ts` serves a different set and would drop payments
 * refused before they reached the chain. The rows come from #4229's kinded
 * read (`useAgentPaymentLedger`), server-filtered — the Token facet rides the
 * `token` parameter #4226 added to that read, because the agent's payments
 * are invisible to the transactions feed's `tokenKey` machinery.
 *
 * Row anatomy (#4226): the merchant is the title — `counterpartyLabel`'s
 * no-address mode, the same helper the account tab reads — and the "by
 * <agent>" title and the "From … →" movement line are GONE: the page fixes
 * the agent and the wallet, so both repeated the page on every row. What the
 * movement line used to say is carried by the row itself and the page.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
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
  rollingWindow,
  type ListState,
  type ListUrlSchema,
  type PeriodValue,
} from '@/components/ui/list-url-codec'
import { useListUrlState } from '@/components/ui/useListUrlState'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import { useAuth } from '@/context/AuthContext'
import { useContacts } from '@/hooks/useContacts'
import { useTransactionFilters } from '@/hooks/useTransactionFilters'
import {
  useAgentPaymentLedger,
  AGENT_PAYMENT_LEDGER_PAGE_SIZE,
  type AgentPaymentLedgerFilters,
  type PaymentActivityItem,
} from '@/hooks/useAgentActivity'
import { api } from '@/lib/api'
import { machinePaymentLifecyclePresentation } from '@/lib/machine-payment-lifecycle'
import {
  failedOrRejectedStatus,
  paymentStatusPresentation,
} from '@/lib/payment-status'
import {
  counterpartyLabel,
  transactionFiat,
  transactionStatus,
} from '@/lib/transaction-presentation'
import { transactionTokenLabel } from '@/lib/transaction-filters'
import { timeAgo } from '@/lib/format'
import type { AggregatedTransaction, TransactionFilterTokenOption } from '@/types/transactions'

interface AgentActivityTabProps {
  /** The agent whose payments this is — fixed by the page, never a filter. */
  agentId: string
  /** The agent's name — the detail panel's attribution, as the old rows had. */
  agentName: string
  /**
   * The wallet the payments leave — the row fallback when a historical row
   * carries no account name (#3811's rule, unchanged from the table days).
   */
  walletName: string
  /**
   * The agent is still in setup (pending_approval): the empty state points at
   * the budget instead of just reporting an empty list.
   */
  needsSetup: boolean
  /**
   * The chain the agent's account lives on, when the page KNOWS it (#4249) —
   * every one of the agent's payments is on that chain, so the Token facet
   * offers only that chain's tokens. Undefined when unknown: the facet then
   * offers every chain's ERC-20s rather than guessing a chain.
   */
  chainId?: number
}

const paymentNoun: ListNoun = { one: 'payment', other: 'payments' }

/**
 * The tab's URL keys, alongside the page's own `?tab=` — the codec never
 * touches keys it does not own, so a filtered link is
 * `/agents/<id>?status=failed` and reproduces the view on any machine.
 */
function activityUrlSchema(): ListUrlSchema {
  return {
    search: { aliases: ['search'] },
    facets: [
      { id: 'status', values: ['sent', 'pending', 'failed', 'needs_attention'] },
      { id: 'tokenKey' },
    ],
    period: { allowCustom: true },
  }
}

/**
 * The Token facet's honest options (#4249): only tokens an agent payment can
 * be in. `payment_intents.token_address` is NOT NULL — budgets are metered
 * per ERC-20 — and the route takes a contract address, so an option without
 * one can never match a row. The registry's native entries are exactly those
 * (`address: null`); they used to map to `''`, which the reader drops, so
 * "Token: ETH" fetched EVERY payment (#4246 review B2). When the page knows
 * the agent's chain, other chains' tokens go too: none of the agent's
 * payments can be in them.
 */
export function agentPaymentTokenOptions(
  tokens: readonly TransactionFilterTokenOption[],
  chainId: number | undefined,
): Array<TransactionFilterTokenOption & { address: string }> {
  return tokens.filter(
    (token): token is TransactionFilterTokenOption & { address: string } =>
      Boolean(token.address) && (chainId === undefined || token.chainId === chainId),
  )
}

/**
 * The toolbar's state as the filters the kinded read sends. `tokenKey` is the
 * shared registry's `<chainId>:<address>` key — the address half is what the
 * route takes.
 *
 * A selected key that does not resolve to an address is NEVER dropped (#4249):
 * dropping it sent an unfiltered request under a "Token: …" chip. While the
 * registry is still loading the read waits (`tokenPending`); once it has
 * loaded, the key goes out verbatim, which the route documents as matching
 * nothing — an honest empty result for a link to a token the agent cannot
 * have paid in.
 */
export function listStateToFilters(
  state: ListState,
  tokenAddressByKey: ReadonlyMap<string, string>,
  tokensLoading: boolean,
): { filters: AgentPaymentLedgerFilters; tokenPending: boolean } {
  const first = (id: string): string | undefined => state.facets[id]?.[0]
  const search = state.q.trim()
  const tokenKey = first('tokenKey')
  const resolved = tokenKey ? tokenAddressByKey.get(tokenKey) : undefined
  return {
    filters: {
      status: first('status'),
      token: tokenKey ? (resolved ?? tokenKey) : undefined,
      q: search || undefined,
      ...periodToBounds(state.period),
    },
    tokenPending: Boolean(tokenKey) && resolved === undefined && tokensLoading,
  }
}

/**
 * The Period facet as the route's ISO bounds: a preset is the rolling window
 * the codec defines, a custom range is its two calendar days BOTH included —
 * the route's `to` is exclusive, so the window ends at the day after `to`.
 * The bounds are cut in the browser's zone: a date-time without an offset
 * parses as local time, and `toISOString()` re-expresses the same instants in
 * UTC for the wire.
 */
function periodToBounds(period: PeriodValue | undefined): { from?: string; to?: string } {
  if (!period) return {}
  if (period.preset) {
    const { from, to } = rollingWindow(period.preset)
    return { from: from.toISOString(), to: to.toISOString() }
  }
  if (period.from && period.to) {
    const from = new Date(`${period.from}T00:00:00`)
    const to = new Date(`${period.to}T00:00:00`)
    to.setDate(to.getDate() + 1)
    return {
      from: Number.isNaN(from.getTime()) ? undefined : from.toISOString(),
      to: Number.isNaN(to.getTime()) ? undefined : to.toISOString(),
    }
  }
  return {}
}

/**
 * The adapter from a kinded-read payment row to the shape the shared ledger
 * and detail panel read. Carried over from the page's `TransactionsTable`
 * days (#2120, #3824, #3129 intact) — only the overrides are gone, with the
 * "by <agent>" title and the movement line they carried (#4226).
 */
function paymentToTransaction(
  item: PaymentActivityItem,
  agentName: string,
  walletName: string,
): AggregatedTransaction {
  const status = paymentStatusPresentation(item.status)
  const isError = failedOrRejectedStatus(item.status)
  const createdMs = new Date(item.created_at).getTime()
  // #3811: list rows carry no addresses — an unnamed wallet falls back to the
  // kind, not to `Haven wallet 0x1234…abcd`.
  const rowWalletName = item.account_name ?? (item.account_address ? 'Haven wallet' : walletName)
  return {
    hash: item.tx_hash ?? `activity-${item.type}-${item.id}`,
    type: 'erc20',
    from: item.account_address ?? '',
    to: item.to,
    value: item.amount_raw ?? '0',
    valueFormatted: item.amount,
    asset: item.token,
    // #3824/#3811: the activity rows' only fiat, struck in the user's
    // `currency_preference` — the shared row's currency mode reads it
    // through `transactionFiat`.
    approxAmount: item.approx_amount ?? null,
    approxCurrency: item.approx_currency ?? undefined,
    decimals: 0,
    direction: 'out',
    timestamp: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : 0,
    // #3129: `null`, not `0` — the activity record carries no block, the same
    // "unknown" the backend's x402 row reports.
    blockNumber: null,
    isError,
    tokenAddress: item.token_address ?? undefined,
    agentName,
    source: item.source as AggregatedTransaction['source'],
    x402ResourceUrl: item.x402_resource_url ?? null,
    x402MerchantAddress: item.x402_merchant_address ?? null,
    deliveryReference: item.delivery_reference ?? null,
    chainId: item.chain_id ?? 0,
    accountId: item.account_id ?? '',
    accountAddress: item.account_address ?? '',
    accountName: rowWalletName,
    agentId: item.agent_id,
    paymentId: item.id,
    paymentProofStatus: item.payment_proof_status ?? null,
    paymentFlowStatus: item.payment_flow_status ?? null,
    paymentAttentionReason: item.payment_attention_reason ?? null,
    statusBadge: { label: status.label, tone: status.tone },
    explorerUrl: item.explorer_url,
  }
}

/** The user's own accounts by address — `counterpartyLabel`'s own-account map. */
function accountNamesByAddressOf(user: ReturnType<typeof useAuth>['user']): Map<string, string> {
  const map = new Map<string, string>()
  for (const acct of user?.accounts ?? []) {
    map.set(`${acct.account_address.toLowerCase()}:${acct.chain_id}`, acct.name)
  }
  return map
}

/** One capped read of the agent's UNFILTERED payment count (#4196's rule). */
async function fetchUnfilteredTotal(agentId: string): Promise<number | null> {
  try {
    const res = await api.get<{ total?: number }>(
      `/agent-activity/${agentId}/activity?kind=payments&limit=1`,
    )
    return typeof res?.total === 'number' ? res.total : null
  } catch {
    return null
  }
}

export default function AgentActivityTab({
  agentId,
  agentName,
  walletName,
  needsSetup,
  chainId,
}: AgentActivityTabProps) {
  const { user } = useAuth()
  const { resolveAddress } = useContacts()
  const { tokens: registryTokens, loading: tokensLoading } = useTransactionFilters()
  const tokens = useMemo(
    () => agentPaymentTokenOptions(registryTokens, chainId),
    [registryTokens, chainId],
  )
  const [selectedTx, setSelectedTx] = useState<AggregatedTransaction | null>(null)
  const accountNamesByAddress = useMemo(() => accountNamesByAddressOf(user), [user])

  // The schema is static; a stable reference keeps a pending search commit
  // from being re-parsed away on re-render (#4130's note).
  const urlSchema = useMemo(() => activityUrlSchema(), [])
  const [listState, setListState] = useListUrlState(urlSchema, { filtering: 'server' })

  const tokenAddressByKey = useMemo(
    () => new Map(tokens.map((token) => [token.key, token.address])),
    [tokens],
  )
  const { filters, tokenPending } = useMemo(
    () => listStateToFilters(listState, tokenAddressByKey, Boolean(tokensLoading)),
    [listState, tokenAddressByKey, tokensLoading],
  )

  const {
    payments,
    total,
    hasMore,
    loading,
    loadingMore,
    error,
    loadMore,
    refresh,
  } = useAgentPaymentLedger(tokenPending ? null : agentId, filters)

  // Active means "differs from the tab default" (#4110): no search, every
  // facet All, All time — the same rule the toolbar applies to its chips.
  const hasActiveFilters =
    listState.q.trim() !== '' ||
    Object.values(listState.facets).some((values) => values.length > 0) ||
    !isAllTime(listState.period)

  // The filtered count's denominator (#4196's rule): when a filter is
  // applied, "{shown} of {total}" compares the FILTERED population against
  // the agent's UNFILTERED one — never the filtered total against itself,
  // which would claim every payment matches. Unknown renders no figure
  // rather than a wrong one.
  const [unfilteredTotal, setUnfilteredTotal] = useState<number | null>(null)
  useEffect(() => {
    if (!hasActiveFilters) return
    let cancelled = false
    void fetchUnfilteredTotal(agentId).then((count) => {
      if (!cancelled) setUnfilteredTotal(count)
    })
    return () => {
      cancelled = true
    }
  }, [hasActiveFilters, agentId])

  const rows = useMemo(
    () => payments.map((item) => paymentToTransaction(item, agentName, walletName)),
    [payments, agentName, walletName],
  )

  const facets: ListFacet[] = [
    {
      id: 'status',
      label: 'Status',
      options: [
        { value: 'sent', label: 'Sent' },
        { value: 'pending', label: 'Pending' },
        { value: 'failed', label: 'Failed' },
        { value: 'needs_attention', label: 'Needs attention' },
      ],
    },
    {
      id: 'tokenKey',
      label: 'Token',
      options: tokens.map((token) => ({ value: token.key, label: transactionTokenLabel(token) })),
    },
  ]

  const count: ListCount | null = loading
    ? null
    : !hasActiveFilters
      ? { shown: total, total }
      : unfilteredTotal === null || unfilteredTotal < total
        ? null
        : { shown: total, total: unfilteredTotal }
  const showNoMatch = hasActiveFilters && !loading && !error && rows.length === 0

  return (
    <div>
      <ListToolbar
        noun={paymentNoun}
        state={listState}
        onChange={setListState}
        filtering="server"
        facets={facets}
        period={{ allowCustom: true }}
        searchDescription="by merchant, recipient or contact"
        count={count}
        summary={
          loading ? undefined : (
            // The tab's one figure: every row in this population is outgoing,
            // so "Out" carries the count of the filtered set — #4229's total,
            // not a money sum the read does not serve.
            <span data-testid="activity-total">
              <span aria-hidden="true">Out</span>
              <span className="sr-only">Outgoing payments</span> {total}
            </span>
          )
        }
      />

      {showNoMatch ? (
        // The standard no-match state (#4110): in place of the list card,
        // toolbar still up, so the cause stays editable.
        <div className="mt-3" data-testid="activity-no-match">
          <ListNoMatch
            noun={paymentNoun}
            onClear={() => setListState(clearedListState(listState, urlSchema))}
          />
        </div>
      ) : (
        <Card hover={false} className="mt-3">
          {loading ? (
            <div
              className="divide-y divide-[var(--v2-border)]"
              role="status"
              aria-busy="true"
              aria-label="Loading activity"
            >
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
                  <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                    Try again
                  </Button>
                }
              />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No payments yet"
                body={
                  needsSetup
                    ? 'Once you set a budget, every payment this agent makes shows here.'
                    : 'Payments made by this agent will appear here.'
                }
                className="py-8"
              />
            </div>
          ) : (
            <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
              {transactionDayGroups(rows, (tx) => new Date(tx.timestamp * 1000).toISOString()).map(
                (day) => (
                  <div key={day.dayKey}>
                    <TransactionActivityDayHeader label={day.label} />
                    {day.items.map((tx, index) => (
                      <AgentLedgerRow
                        key={`${tx.paymentId ?? tx.hash}:${index}`}
                        tx={tx}
                        resolveAddress={resolveAddress}
                        accountNamesByAddress={accountNamesByAddress}
                        onOpen={() => setSelectedTx(tx)}
                        insetDivider={index > 0}
                      />
                    ))}
                  </div>
                ),
              )}
            </div>
          )}
        </Card>
      )}

      {!showNoMatch && !loading && !error && (
        <ListShowMore
          loaded={rows.length}
          total={total}
          pageSize={AGENT_PAYMENT_LEDGER_PAGE_SIZE}
          hasMore={hasMore}
          loading={loadingMore}
          onShowMore={() => void loadMore()}
        />
      )}

      {/* #4226: "See in Transactions" replaces the header's "View in
          Transactions" — under the list now, and without the `--v2-divider`
          underline (the variable is undefined, so it always painted
          currentColor; the plain underline is the same pixels). */}
      <div className="mt-3">
        <Link
          href={`/transactions?agentId=${agentId}`}
          className="text-sm font-medium text-[var(--v2-ink)] underline underline-offset-4 hover:text-[var(--v2-ink-strong)]"
        >
          See in Transactions
        </Link>
      </div>

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

/**
 * One ledger row — merchant-first, no subtitle: the page fixes the agent, so
 * the row's title is WHO WAS PAID and nothing repeats the page.
 */
function AgentLedgerRow({
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
  // The same precedence the wallet feed's rows read (`TransactionsTable`):
  // the machine-payment lifecycle outranks the intent's own status, because a
  // stranded payment's intent is `confirmed` — its funding settled — and
  // only the lifecycle says it needs attention (#2196, #4249).
  const badge = transactionStatus(tx) ?? machinePaymentLifecyclePresentation(tx) ?? tx.statusBadge
  const fiat = transactionFiat(tx, 'row')
  return (
    <TransactionActivityRow
      title={counterpartyLabel(tx, resolveAddress, accountNamesByAddress, { noAddress: true })}
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

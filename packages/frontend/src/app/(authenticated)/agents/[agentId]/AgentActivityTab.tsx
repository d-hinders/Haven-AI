'use client'

/**
 * The agent page's Activity tab (#4226, epic #4224): the agent's OWN payment
 * ledger — `payment_intents`, failed and pending included — drawn with the
 * shared ledger pieces (`TransactionActivityRow` ledger mode under
 * `TransactionActivityDayHeader` bands), the standard toolbar (search, Status,
 * Token, Period) and `ListShowMore`.
 *
 * The population is deliberately NOT the wallet-scoped transactions feed:
 * `routes/transactions.ts` serves a different set, and would drop both the
 * attempts that never became payments and the failed/pending states this tab
 * exists to show. The rows come from #4229's kinded read
 * (`useAgentPaymentLedger`), server-filtered — the Token facet rides the
 * `token` parameter #4226 added to that read, because the agent's payments
 * are invisible to the transactions feed's `tokenKey` machinery.
 *
 * Refused attempts (#4323) are the tab's third population: the Status
 * facet's **Refused** value switches the read to `kind=refusals` — the
 * agent's `payment_refusals` rows, rendered with the same ledger row, a
 * neutral "Refused" badge, the reason in words and an UNSIGNED amount (no
 * money moved). The Token facet hides while Refused is selected: a refusal
 * carries no token address to facet on. Refusal rows are not interactive —
 * ledger rows hold no controls, and there is no refused shape in the detail
 * panel; everything a refusal says is in the row.
 *
 * Row anatomy (#4226): the merchant is the title — `counterpartyLabel`'s
 * no-address mode, the same helper the account tab reads — and the "by
 * <agent>" title and the "From … →" movement line are GONE: the page fixes
 * the agent and the wallet, so both repeated the page on every row. What the
 * movement line used to say is carried by the row itself and the page.
 *
 * The tab is a full ledger, so it carries no "see elsewhere" link (#4327):
 * like the account Activity tab and `/transactions`, it offers Export CSV in
 * the toolbar's actions slot — the agent ledger as shown, through the agent's
 * own export route and the shared list export action.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  TransactionActivityDayHeader,
  TransactionActivityRow,
  transactionDayGroups,
} from '@/components/haven'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ListNoMatch, ListShowMore, ListToolbar } from '@/components/ui/ListToolbar'
import { ListExportAction, ListExportNotice, useListExport, type ListExportRequest } from '@/components/ui/ListExportAction'
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
  isPaymentActivityItem,
  type ActivityItem,
  useAgentPaymentLedger,
  useAgentRefusalLedger,
  AGENT_PAYMENT_LEDGER_PAGE_SIZE,
  type AgentPaymentLedgerFilters,
  type AgentRefusalLedgerFilters,
  type PaymentActivityItem,
} from '@/hooks/useAgentActivity'
import { refusalRowSubline, type RefusalActivityItem } from '@/lib/refusal-reasons'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { api } from '@/lib/api'
import {
  failedOrRejectedStatus,
  paymentStatusPresentation,
} from '@/lib/payment-status'
import {
  counterpartyLabel,
  transactionFiat,
  transactionRowBadge,
} from '@/lib/transaction-presentation'
import { transactionTokenLabel } from '@/lib/transaction-filters'
import { parseX402Hostname } from '@/lib/transaction-labels'
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
  /**
   * #4227: a payment the Tool calls tab asked to open. The tab links to
   * `?tab=activity&paymentId=…`; the page reads the parameter and hands it
   * here. The tab fetches that ONE payment through #4229's `paymentId`
   * filter, adapts it with `activityToTransaction` and opens the shared
   * detail panel — the list does not need to contain it.
   */
  openPaymentId?: string | null
  /**
   * #4227: called once the payment panel is open (or the read failed) so the
   * page can strip `paymentId` from the URL — consumed, not re-opened on the
   * next mount or filter write.
   */
  onPaymentOpened?: () => void
}

const paymentNoun: ListNoun = { one: 'payment', other: 'payments' }
const refusalNoun: ListNoun = { one: 'refused attempt', other: 'refused attempts' }

/**
 * The tab's URL keys, alongside the page's own `?tab=` — the codec never
 * touches keys it does not own, so a filtered link is
 * `/agents/<id>?status=failed` and reproduces the view on any machine.
 * `refused` (#4323) is the deep link's value: `/agents/<id>?tab=activity&
 * status=refused` opens the tab on the refusal population.
 */
function activityUrlSchema(): ListUrlSchema {
  return {
    search: { aliases: ['search'] },
    facets: [
      { id: 'status', values: ['sent', 'pending', 'failed', 'needs_attention', 'refused'] },
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
 *
 * Exported (#4227): the Tool calls tab sends the SAME bounds for the SAME
 * period — one rule, both tabs, or the two tabs' "Last 7 days" would silently
 * cover different windows.
 */
export function periodToBounds(period: PeriodValue | undefined): { from?: string; to?: string } {
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
 * The adapter from a kinded-read activity row to the shape the shared ledger
 * and detail panel read. Carried over from the page's transactions-table
 * days (#2120, #3824, #3129 intact; the table was deleted with #4266) —
 * only the overrides are gone, with the "by <agent>" title and the movement
 * line they carried (#4226).
 *
 * Exported (#4227): the Tool calls tab's payment link lands here and the
 * fetched payment row goes through this same adapter into the detail panel,
 * so a payment renders identically from both tabs.
 */
export function activityToTransaction(
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
    // The eip3009 legs, named (#3763), so the detail panel can link the
    // funding leg and list the settlement beside it (#4267).
    settlementScheme:
      item.settlement_scheme === 'eip3009' || item.settlement_scheme === 'erc7710'
        ? item.settlement_scheme
        : null,
    settlementTxHash: item.settlement_tx_hash ?? null,
    fundingTxHash: item.funding_tx_hash ?? null,
    // #4320: the settlement state rides to the panel under its camelCase
    // wire names — the activity read is snake_case, mapped here.
    settlementTracking: item.settlement_tracking ?? null,
    settlementProof: item.settlement_proof ?? null,
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

/** One capped read of the agent's UNFILTERED count (#4196's rule), per population. */
async function fetchUnfilteredTotal(
  agentId: string,
  kind: 'payments' | 'refusals',
): Promise<number | null> {
  try {
    const res = await api.get<{ total?: number }>(
      `/agent-activity/${agentId}/activity?kind=${kind}&limit=1`,
    )
    return typeof res?.total === 'number' ? res.total : null
  } catch {
    return null
  }
}

/**
 * What one refusal row renders. The ledger row primitive stays shared — a
 * refused attempt is an existing row with a status badge and no signed
 * amount (#4323) — so the adapter keeps the row's five inputs together:
 * the merchant-first title (through `counterpartyLabel`, the payments' own
 * helper), the reason subline (the one map), the unsigned human amount
 * (registry decimals, the refusal's only humanizer), the day-group instant
 * and the item itself.
 */
export interface RefusalRowView {
  item: RefusalActivityItem
  title: string
  subline: string
  value: string
  /** Seconds — `transactionDayGroups`' instant. */
  timestamp: number
}

export function refusalRowView(
  item: RefusalActivityItem,
  resolveAddress: (address: string) => string | null,
  accountNamesByAddress: Map<string, string>,
): RefusalRowView {
  const createdMs = new Date(item.created_at).getTime()
  return {
    item,
    // Merchant-first, same helper the payment rows read: a resource-scoped
    // attempt titles its merchant host, an addressed one its resolved name.
    title: counterpartyLabel(
      {
        activityType: undefined,
        agentName: undefined,
        // Route through the machine-payment branch ONLY when a hostname
        // parses out — otherwise the title would fall to "Agent payment"
        // instead of the merchant address.
        source: parseX402Hostname(item.resource_url) ? 'x402' : undefined,
        x402ResourceUrl: item.resource_url ?? null,
        direction: 'out',
        to: item.merchant_to ?? '',
        from: '',
        chainId: item.chain_id ?? 0,
      },
      resolveAddress,
      accountNamesByAddress,
      { noAddress: true },
    ),
    subline: refusalRowSubline(item.reason),
    // Unsigned by construction: `formatAllowanceForToken` has no sign, and
    // the row's direction stays neutral — no money moved.
    value: formatAllowanceForToken(item.amount, item.chain_id, item.token_symbol),
    timestamp: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : 0,
  }
}

export default function AgentActivityTab({
  agentId,
  agentName,
  walletName,
  needsSetup,
  chainId,
  openPaymentId,
  onPaymentOpened,
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

  // #4323: the Status facet's Refused value switches the POPULATION — the
  // refusal reader takes over and the payment reader is held (a null agent
  // retires its in-flight requests, #4249's rule).
  const refusedSelected = (listState.facets.status ?? []).includes('refused')
  const refusalFilters: AgentRefusalLedgerFilters = useMemo(
    () => ({ q: filters.q, from: filters.from, to: filters.to }),
    [filters],
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
  } = useAgentPaymentLedger(!refusedSelected && !tokenPending ? agentId : null, filters)

  const {
    refusals,
    total: refusalTotal,
    hasMore: refusalHasMore,
    loading: refusalLoading,
    loadingMore: refusalLoadingMore,
    error: refusalError,
    loadMore: refusalLoadMore,
    refresh: refusalRefresh,
  } = useAgentRefusalLedger(refusedSelected ? agentId : null, refusalFilters)

  const activeTotal = refusedSelected ? refusalTotal : total
  const activeHasMore = refusedSelected ? refusalHasMore : hasMore
  const activeLoading = refusedSelected ? refusalLoading : loading
  const activeLoadingMore = refusedSelected ? refusalLoadingMore : loadingMore
  const activeError = refusedSelected ? refusalError : error
  const activeLoadMore = refusedSelected ? refusalLoadMore : loadMore
  const activeRefresh = refusedSelected ? refusalRefresh : refresh
  const activeNoun = refusedSelected ? refusalNoun : paymentNoun

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
  // rather than a wrong one. Per population (#4323): on Refused the
  // denominator is the agent's UNFILTERED REFUSAL total — reusing the
  // payments count here would claim every refusal matched.
  const [unfilteredTotal, setUnfilteredTotal] = useState<number | null>(null)
  useEffect(() => {
    if (!hasActiveFilters) return
    let cancelled = false
    void fetchUnfilteredTotal(agentId, refusedSelected ? 'refusals' : 'payments').then((count) => {
      if (!cancelled) setUnfilteredTotal(count)
    })
    return () => {
      cancelled = true
    }
  }, [hasActiveFilters, agentId, refusedSelected])

  const rows = useMemo(
    () => payments.map((item) => activityToTransaction(item, agentName, walletName)),
    [payments, agentName, walletName],
  )

  const refusalRows = useMemo(
    () => refusals.map((item) => refusalRowView(item, resolveAddress, accountNamesByAddress)),
    [refusals, resolveAddress, accountNamesByAddress],
  )

  // #4227: a Tool-calls payment link landed on this tab. Fetch the ONE
  // payment through #4229's `paymentId` filter (the read exists for exactly
  // this), adapt it with the shared adapter and open the same detail panel a
  // ledger row opens — then report it consumed so the page strips the
  // parameter. A failed read still consumes: a link that retries a fetch
  // forever is worse than one that quietly doesn't open.
  useEffect(() => {
    if (!openPaymentId || !agentId) return
    let cancelled = false
    api
      .get<{ activity: ActivityItem[] }>(
        `/agent-activity/${agentId}/activity?kind=payments&paymentId=${encodeURIComponent(openPaymentId)}&limit=1`,
      )
      .then((res) => {
        if (cancelled) return
        const row = (res?.activity ?? []).filter(isPaymentActivityItem)[0]
        if (row) {
          setSelectedTx(activityToTransaction(row, agentName, walletName))
        }
        onPaymentOpened?.()
      })
      .catch(() => {
        if (!cancelled) onPaymentOpened?.()
      })
    return () => {
      cancelled = true
    }
  }, [openPaymentId, agentId, agentName, walletName, onPaymentOpened])

  // #4327: Export CSV writes the ledger AS SHOWN (owner decision, option
  // (a)) — the agent's own export route, with the tab's own filters, so the
  // file and the on-screen rows agree. On Refused the population switches to
  // the refused attempts, exactly as the list does, and the Token facet (hidden
  // there) is not sent. The shared action (#4328) owns the busy state, the
  // fetch, the empty check, the download and the failure notice — including
  // the server's 413 sentence, which names this tab's filters.
  const exportRequest = useMemo<ListExportRequest>(() => {
    const params = new URLSearchParams()
    if (refusedSelected) {
      params.set('status', 'refused')
    } else {
      if (filters.status) params.set('status', filters.status)
      if (filters.token) params.set('token', filters.token)
    }
    if (filters.q) params.set('q', filters.q)
    if (filters.from) params.set('from', filters.from)
    if (filters.to) params.set('to', filters.to)
    return { path: `/agent-activity/${agentId}/activity/export.csv`, params }
  }, [agentId, filters, refusedSelected])

  // The agent ledger is plain Postgres — there is no explorer outage behind an
  // empty file, so one "Nothing to export." and no outage arm.
  const listExport = useListExport({
    request: exportRequest,
    exportable: !activeLoading && !tokenPending && activeTotal > 0,
    filenamePrefix: 'haven-agent-payments',
    emptyNotice: {
      tone: 'info',
      headline: 'Nothing to export.',
      detail: refusedSelected
        ? 'No refused attempts match these filters. Widen them and try again.'
        : 'No payments match these filters. Widen them and try again.',
    },
  })

  const facets: ListFacet[] = [
    {
      id: 'status',
      label: 'Status',
      options: [
        { value: 'sent', label: 'Sent' },
        { value: 'pending', label: 'Pending' },
        { value: 'failed', label: 'Failed' },
        { value: 'needs_attention', label: 'Needs attention' },
        { value: 'refused', label: 'Refused' },
      ],
    },
    // #4323: hidden while Refused is selected — a refusal carries no token
    // address to facet on (the wire has `token_symbol` only), so offering
    // the facet would promise a filter that can never match.
    ...(refusedSelected
      ? []
      : [
          {
            id: 'tokenKey',
            label: 'Token',
            options: tokens.map((token) => ({ value: token.key, label: transactionTokenLabel(token) })),
          },
        ]),
  ]

  const count: ListCount | null = activeLoading
    ? null
    : !hasActiveFilters
      ? { shown: activeTotal, total: activeTotal }
      : unfilteredTotal === null || unfilteredTotal < activeTotal
        ? null
        : { shown: activeTotal, total: unfilteredTotal }
  // #4323: on Refused, an empty population reads "No refused attempts" —
  // but only when Refused is the ONLY selection. Any other active filter
  // (search, another facet, a period) keeps the standard no-match state, so
  // the cause stays editable there.
  const refusedOtherFiltersActive =
    listState.q.trim() !== '' ||
    Object.entries(listState.facets).some(([id, values]) => id !== 'status' && values.length > 0) ||
    !isAllTime(listState.period)
  const refusedEmptyState = refusedSelected && refusalRows.length === 0 && !refusedOtherFiltersActive
  const showNoMatch =
    hasActiveFilters &&
    !activeLoading &&
    !activeError &&
    (refusedSelected ? refusalRows.length === 0 && !refusedEmptyState : rows.length === 0)

  return (
    <div>
      <ListToolbar
        noun={activeNoun}
        state={listState}
        onChange={setListState}
        filtering="server"
        facets={facets}
        period={{ allowCustom: true }}
        searchDescription={refusedSelected ? 'by merchant or resource' : 'by merchant, recipient or contact'}
        count={count}
        // #4274 (owner decision, option (a)): no summary figure. "Out 4"
        // beside the count read as an amount (the account tab's In/Out are
        // money figures), and it repeated the count the toolbar already
        // shows. The count alone is the List controls default for a page
        // with no totals (#4196); there is no money total and no backend
        // change — #4229's count read is unchanged.
        actions={<ListExportAction state={listExport} />}
      />

      <ListExportNotice notice={listExport.notice} className="mt-3" />

      {showNoMatch ? (
        // The standard no-match state (#4110): in place of the list card,
        // toolbar still up, so the cause stays editable.
        <div className="mt-3" data-testid="activity-no-match">
          <ListNoMatch
            noun={activeNoun}
            onClear={() => setListState(clearedListState(listState, urlSchema))}
          />
        </div>
      ) : (
        <Card hover={false} className="mt-3">
          {activeLoading ? (
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
          ) : activeError ? (
            <div className="p-6">
              <EmptyState
                title="Activity could not load"
                body={activeError}
                className="py-8"
                action={
                  <Button variant="ghost" size="sm" onClick={() => void activeRefresh()}>
                    Try again
                  </Button>
                }
              />
            </div>
          ) : refusedSelected ? (
            refusalRows.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="No refused attempts"
                  body="When a guardrail or budget stops one of this agent's payments, the attempt shows here."
                  className="py-8"
                />
              </div>
            ) : (
              <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
                {transactionDayGroups(refusalRows, (row) =>
                  new Date(row.timestamp * 1000).toISOString(),
                ).map((day) => (
                  <div key={day.dayKey}>
                    <TransactionActivityDayHeader label={day.label} />
                    {day.items.map((row, index) => (
                      <AgentRefusalRow
                        key={`${row.item.id}:${index}`}
                        view={row}
                        insetDivider={index > 0}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )
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

      {!showNoMatch && !activeLoading && !activeError && (
        <ListShowMore
          loaded={refusedSelected ? refusalRows.length : rows.length}
          total={activeTotal}
          pageSize={AGENT_PAYMENT_LEDGER_PAGE_SIZE}
          hasMore={activeHasMore}
          loading={activeLoadingMore}
          onShowMore={() => void activeLoadMore()}
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

/**
 * One refusal row (#4323) — the shared ledger row, non-interactive: ledger
 * rows hold no controls, and there is no refused shape in the detail panel,
 * so everything the refusal says lives in the row. The badge is a NEUTRAL
 * "Refused" and the direction is neutral, so `Amount` neither signs nor
 * danger-tints the amount — no money moved.
 */
function AgentRefusalRow({ view, insetDivider }: { view: RefusalRowView; insetDivider: boolean }) {
  return (
    <TransactionActivityRow
      title={view.title}
      description={view.subline}
      value={view.value}
      asset={view.item.token_symbol}
      status="Refused"
      statusTone="neutral"
      timestamp={timeAgo(view.timestamp * 1000)}
      direction="neutral"
      density="compact"
      insetDivider={insetDivider}
    />
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
  // The one row-badge precedence (`transactionRowBadge`, #4266): the
  // machine-payment lifecycle outranks the intent's own status, because a
  // stranded payment's intent is `confirmed` — its funding settled — and
  // only the lifecycle says it needs attention (#2196, #4249).
  const badge = transactionRowBadge(tx)
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

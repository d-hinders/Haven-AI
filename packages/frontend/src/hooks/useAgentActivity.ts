'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import { browserTimeZone } from '@/lib/analytics-range'
import type { PaymentStatus } from '@/lib/payment-status'

/**
 * #2120: was `ApprovalStatus | PaymentStatus`. The approval half is gone with
 * the queue — see the decision note in `lib/payment-status.ts`.
 */
type ActivityStatus = PaymentStatus

/**
 * Payment rows — money-movement events that fit the transactions table.
 *
 * #2120: `type` was `'payment' | 'approval'`. Since #2055 the activity routes
 * build their list from `payment_intents` + MCP tool invocations only; the
 * `approval_requests` entries went with the table (migration 070), so no
 * backend can emit an `'approval'` row. Narrowed so a fixture cannot mint one
 * either — `screenshot-fixture.test.ts` reads this discriminator.
 */
export interface PaymentActivityItem {
  type: 'payment'
  id: string
  agent_id?: string
  agent_name?: string
  token: string
  token_address?: string | null
  amount_raw?: string | null
  amount: string
  to: string
  reason?: string | null
  status: ActivityStatus
  /**
   * #3763: the FUNDING transaction on the eip3009 bridge — Haven's sponsored
   * UserOp (account → delegate). The merchant's settlement travels beside it
   * as `settlement_tx_hash`.
   */
  tx_hash: string | null
  /**
   * #3763: the funding leg, named — same value as `tx_hash`.
   */
  funding_tx_hash?: string | null
  /**
   * #3763: the merchant's settlement transaction (delegate → merchant) when
   * an agent reported one and it verified on-chain (#3475). Null is "not
   * recorded", never "failed" — `explorer_url` already headlines the
   * settlement for the same reason the drawer does.
   */
  settlement_tx_hash?: string | null
  /** #3763: which settlement branch moved the money (`eip3009` | `erc7710`); null when none was recorded. */
  settlement_scheme?: string | null
  source?: string
  x402_resource_url?: string | null
  x402_merchant_address?: string | null
  /**
   * #3824: the token amount at today's rate in `approx_currency` (the user's
   * `currency_preference`) — the activity rows' only fiat. Null when the
   * token has no usable quote; never 0.
   */
  approx_amount?: string | null
  /** #3824: the currency `approx_amount` is denominated in. */
  approx_currency?: 'SEK' | 'USD' | 'EUR'
  /** #3778: the non-secret delivery pointer reported with the x402 outcome. */
  delivery_reference?: string | null
  chain_id?: number | null
  account_id?: string | null
  account_address?: string | null
  account_name?: string | null
  explorer_url: string | null
  confirmed_at?: string | null
  payment_proof_status?: string | null
  payment_flow_status?: 'paid' | 'confirming_merchant' | 'needs_attention' | null
  payment_attention_reason?: 'merchant_retry_rejected_after_payment' | null
  created_at: string
}

/**
 * MCP tool invocation rows — audit-log entries produced by the
 * `X-Haven-MCP-Tool` header on the backend. Surfaced separately from the
 * transactions table because most of them never move money (status reads,
 * quote inspections). See backend migration 015_agent_tool_invocations.
 */
export interface McpToolCallActivityItem {
  type: 'mcp_tool_call'
  id: string
  agent_id?: string
  agent_name?: string
  tool_name: string
  payment_id: string | null
  result_status: 'ok' | 'error' | 'denied' | string
  next_action: string | null
  error_code: string | null
  status_code: number | null
  created_at: string
}

export type ActivityItem = PaymentActivityItem | McpToolCallActivityItem

export function isPaymentActivityItem(item: ActivityItem): item is PaymentActivityItem {
  return item.type === 'payment'
}

export function isMcpToolCallActivityItem(item: ActivityItem): item is McpToolCallActivityItem {
  return item.type === 'mcp_tool_call'
}

export interface AgentStats {
  all_time: { token: string; total_spent: string; tx_count: number }[]
  today: { token: string; total_spent: string; tx_count: number }[]
  pending_approvals: number
}

export function useAgentActivity(agentId: string | null) {
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [stats, setStats] = useState<AgentStats | null>(null)
  const [loading, setLoading] = useState(true)
  // #2732: one in-flight request per hook — a silent poll racing a mount or
  // refetch must not interleave late responses over newer data.
  const requestIdRef = useRef(0)

  // #3977: the stats response's "today" is the USER's local day, so the
  // request names the browser's IANA zone — exactly as `/dashboard/overview`
  // receives its `tz` (same validation server-side, and the same
  // `browserTimeZone` rule: an unresolvable zone is omitted and the
  // documented UTC default takes over, never a guess). Memoized so a
  // re-render that changes nothing cannot re-issue the request.
  const statsPath = useMemo(() => {
    const params = new URLSearchParams()
    const zone = browserTimeZone()
    if (zone !== undefined) params.set('tz', zone)
    const query = params.toString()
    return query
      ? `/agent-activity/${agentId}/stats?${query}`
      : `/agent-activity/${agentId}/stats`
  }, [agentId])

  const fetchData = useCallback(
    async (silent = false) => {
      if (!agentId) return
      const requestId = ++requestIdRef.current
      try {
        const [activityRes, statsRes] = await Promise.all([
          api.get<{ activity: ActivityItem[] }>(`/agent-activity/${agentId}/activity`),
          api.get<AgentStats>(statsPath),
        ])
        if (requestIdRef.current !== requestId) return
        // A 200 whose body omits `activity` must not void the array the page
        // filters over — that crashed /agents/[agentId] outright (#1075).
        setActivity(activityRes?.activity ?? [])
        setStats(statsRes ?? null)
      } catch {
        // Silently fail — including silent ticks, which by #2732 must change
        // no visible state on a failed fetch anyway.
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false)
        }
      }
    },
    [agentId, statsPath],
  )

  useEffect(() => {
    if (agentId) {
      setLoading(true)
      fetchData()
    }
  }, [agentId, fetchData])

  useVisiblePolling(() => {
    void fetchData(true)
  })

  return { activity, stats, loading, refetch: fetchData }
}

// ── The Activity tab's paged, filtered payments reader (#4226) ───────────────
//
// The agent page's Activity tab renders the shared ledger over ONE pageable,
// filterable population: the agent's own payments, failed and pending ones
// included. That population lives behind #4229's kinded read
// (`GET /agent-activity/:id/activity?kind=payments&…`), NOT behind the
// wallet-scoped transactions feed — `routes/transactions.ts` is a different
// population and would drop payments refused before they reached the chain.
// The merged `useAgentActivity` above stays for everything else the page
// reads (the banners' attention filter, ReplaceSigningKeyModal's recent
// payments, the Tool-calls tab).

/** The Activity tab's toolbar state as the reader's server filters. */
export interface AgentPaymentLedgerFilters {
  /** `sent | pending | failed | needs_attention` — the Status facet. */
  status?: string
  /** The ERC-20 token contract address — the Token facet. */
  token?: string
  /** Inclusive ISO lower bound (the Period facet, presets and custom alike). */
  from?: string
  /** Exclusive ISO upper bound. */
  to?: string
  /** The search term. */
  q?: string
}

/**
 * One page of the ledger, and what "Show N more" adds — the same page size
 * the account Activity tab uses.
 */
export const AGENT_PAYMENT_LEDGER_PAGE_SIZE = 25

export function useAgentPaymentLedger(
  agentId: string | null,
  filters: AgentPaymentLedgerFilters,
  pageSize: number = AGENT_PAYMENT_LEDGER_PAGE_SIZE,
) {
  const [payments, setPayments] = useState<PaymentActivityItem[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  // The filters object is rebuilt every render by the tab's `useMemo`-less
  // consumers, so the refetch key is the serialized filter SET, not the
  // identity: an equal rebuild must not restart the list, a changed value
  // must. (The fields are all strings, so JSON is exact.)
  const filterKey = JSON.stringify(filters)

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      if (!agentId) return
      const requestId = ++requestIdRef.current
      if (append) setLoadingMore(true)
      try {
        const params = new URLSearchParams({ kind: 'payments', limit: String(pageSize), offset: String(offset) })
        const parsed: AgentPaymentLedgerFilters = JSON.parse(filterKey)
        if (parsed.status) params.set('status', parsed.status)
        if (parsed.token) params.set('token', parsed.token)
        if (parsed.q) params.set('q', parsed.q)
        if (parsed.from) params.set('from', parsed.from)
        if (parsed.to) params.set('to', parsed.to)
        const res = await api.get<{ activity: ActivityItem[]; total?: number; hasMore?: boolean }>(
          `/agent-activity/${agentId}/activity?${params.toString()}`,
        )
        if (requestIdRef.current !== requestId) return
        // #4229's own rule, kept: filter by `type` defensively until both
        // sides of the kinded read are deployed — an old backend answers the
        // merged window and a fixture may answer loosely.
        const rows = (res?.activity ?? []).filter(isPaymentActivityItem)
        setPayments((current) => (append ? [...current, ...rows] : rows))
        setTotal(res?.total ?? rows.length)
        setHasMore(Boolean(res?.hasMore))
        setError(null)
      } catch (err) {
        if (requestIdRef.current !== requestId) return
        // A failed page keeps the rows already on screen (an append failing
        // must not blank the list the user is reading) and says so.
        if (!append) setPayments([])
        setHasMore(false)
        setError(err instanceof Error ? err.message : 'Activity could not load')
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [agentId, filterKey, pageSize],
  )

  // A filter or agent change restarts the list; `loadMore` appends.
  useEffect(() => {
    setLoading(true)
    void fetchPage(0, false)
  }, [fetchPage])

  const loadMore = useCallback(() => {
    if (loadingMore) return
    void fetchPage(payments.length, true)
  }, [fetchPage, loadingMore, payments.length])

  return {
    payments,
    total,
    hasMore,
    loading,
    loadingMore,
    error,
    loadMore,
    refresh: () => fetchPage(0, false),
  }
}

// ── The Tool calls tab's paged, filtered reader (#4227) ─────────────────────
//
// Same shape as the payment ledger above, over #4229's `kind=tool_calls`
// population: the agent's MCP tool invocations, filtered server-side by the
// Result facet / Period / search. The summary line's error count rides
// #4229's `counts.error` — counted WITHOUT the status filter, so it stays
// stable while the caller flips the Result facet.

/** The Tool calls tab's toolbar state as the reader's server filters. */
export interface AgentToolCallLogFilters {
  /** `ok | error | denied` — the Result facet. */
  result?: string
  /** Inclusive ISO lower bound (the Period facet). */
  from?: string
  /** Exclusive ISO upper bound. */
  to?: string
  /** The search term. */
  q?: string
}

/** The page size the Tool calls tab pages by — the account tab's page size. */
export const AGENT_TOOL_CALL_PAGE_SIZE = 25

export function useAgentToolCallLog(
  agentId: string | null,
  filters: AgentToolCallLogFilters,
  pageSize: number = AGENT_TOOL_CALL_PAGE_SIZE,
) {
  const [items, setItems] = useState<McpToolCallActivityItem[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  /** #4229's `counts.error`: errors in the population WITHOUT the status filter. */
  const [errorCount, setErrorCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  // Same rule as the payment ledger: the refetch key is the serialized filter
  // SET, so an equal rebuild must not restart the list, a change must.
  const filterKey = JSON.stringify(filters)

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      if (!agentId) return
      const requestId = ++requestIdRef.current
      if (append) setLoadingMore(true)
      try {
        const params = new URLSearchParams({ kind: 'tool_calls', limit: String(pageSize), offset: String(offset) })
        const parsed: AgentToolCallLogFilters = JSON.parse(filterKey)
        if (parsed.result) params.set('status', parsed.result)
        if (parsed.q) params.set('q', parsed.q)
        if (parsed.from) params.set('from', parsed.from)
        if (parsed.to) params.set('to', parsed.to)
        const res = await api.get<{
          activity: ActivityItem[]
          total?: number
          hasMore?: boolean
          counts?: { error?: number }
        }>(`/agent-activity/${agentId}/activity?${params.toString()}`)
        if (requestIdRef.current !== requestId) return
        // #4229's own rule, kept: filter by `type` defensively — an old
        // backend answers the merged window and a fixture may answer loosely.
        const rows = (res?.activity ?? []).filter(isMcpToolCallActivityItem)
        setItems((current) => (append ? [...current, ...rows] : rows))
        setTotal(res?.total ?? rows.length)
        setHasMore(Boolean(res?.hasMore))
        setErrorCount(res?.counts?.error ?? 0)
        setError(null)
      } catch (err) {
        if (requestIdRef.current !== requestId) return
        // A failed page keeps the rows already on screen (an append failing
        // must not blank the list the user is reading) and says so.
        if (!append) setItems([])
        setHasMore(false)
        setError(err instanceof Error ? err.message : 'Tool calls could not load')
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [agentId, filterKey, pageSize],
  )

  // A filter or agent change restarts the list; `loadMore` appends.
  useEffect(() => {
    setLoading(true)
    void fetchPage(0, false)
  }, [fetchPage])

  const loadMore = useCallback(() => {
    if (loadingMore) return
    void fetchPage(items.length, true)
  }, [fetchPage, loadingMore, items.length])

  return {
    items,
    total,
    hasMore,
    errorCount,
    loading,
    loadingMore,
    error,
    loadMore,
    refresh: () => fetchPage(0, false),
  }
}

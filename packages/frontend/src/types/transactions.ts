import type { ApiSchema } from '@haven_ai/core'
import type { StatusTone } from '@/components/ui/StatusBadge'

/**
 * Wire shapes come from `@haven_ai/core`'s generated API types (#984) — the
 * OpenAPI spec is the single source; nothing here restates a response field.
 * This module keeps the frontend's established names as aliases, plus the
 * frontend-ONLY derived types (presentation state, client-side filter
 * state) that extend the wire shapes rather than replacing them.
 */

/**
 * Who initiated a transaction (#2097). `'agent'` = agent-initiated (always
 * carries `agentName` too); `'human'` = an owner send from the dashboard,
 * recorded at submit (#4099; earlier owner sends stay `'unknown'`);
 * `'unknown'` = outbound raw transfer with no agent attribution or owner
 * record. Direction `'in'` rows carry no `initiatedBy`, bar an agent's
 * delegate sweep (`'agent'`).
 *
 * Declared here as a frontend-only extension because the OpenAPI field lands
 * in the same PR (#2097): the generated wire type in `@haven_ai/core`
 * (`packages/core/src/api-types.ts`, regenerated from the backend spec via
 * `npm run generate:api-types`) gains the same optional field. This keeps the
 * UI compiling before that regeneration lands, and stays consistent after it.
 * Rendering contract: "You" / "Payment sent by you" is RESERVED for `'human'`;
 * a missing value renders as explicit "Unknown" — never "You".
 */
type TransactionInitiator = 'agent' | 'human' | 'unknown'

/** Per-account page item (`GET /transactions/{accountAddress}`) — no account scope. */
export type Transaction = ApiSchema<'TransactionBase'> & {
  initiatedBy?: TransactionInitiator
}

/**
 * Aggregated-feed item plus the frontend-only presentation overrides used by
 * the activity ledger when rendering non-transaction activity through the
 * same primitive. Wire fields come from the generated `Transaction` schema.
 */
export interface AggregatedTransaction extends ApiSchema<'Transaction'> {
  /**
   * Who initiated the payment (#2097). `'agent'` → agent-initiated (always
   * accompanied by `agentName`); `'human'` → an owner send from the
   * dashboard, recorded at submit (#4099); `'unknown'` → outbound raw
   * transfer with no agent attribution or owner record. Direction `'in'`
   * rows carry no `initiatedBy`, bar an agent's delegate sweep.
   * Rendering contract: "You" / "Payment sent by you" is RESERVED for
   * `'human'`; a missing value renders as explicit "Unknown" — never "You".
   * Frontend-only extension of the wire schema (see `Transaction`) — the
   * backend spec adds the field in the same PR (#2097).
   */
  initiatedBy?: TransactionInitiator
  /**
   * Optional status pill rendered inline beside the activity title. When set
   * it takes precedence over the default `isError` → "Failed" badge. Used by
   * callers that render non-transaction activity (e.g. agent approval items)
   * through the activity ledger so it stays a single primitive.
   */
  statusBadge?: { label: string; tone: StatusTone }
  /**
   * Optional override for the external-link cell. `null` hides the link
   * entirely (e.g. approval items without a tx hash). Undefined falls back
   * to the chain-default explorer URL for the row's hash.
   */
  explorerUrl?: string | null
}

export type TransactionsResponse = ApiSchema<'TransactionsPageResponse'>

/** Feed response with the feed items widened to the presentation type. */
export type TransactionsFeedResponse = Omit<ApiSchema<'TransactionsResponse'>, 'transactions'> & {
  transactions: AggregatedTransaction[]
}

/**
 * The Period presets the Transactions filters offer (#4095). Server-side rolling
 * windows `[now − N×24h, now)` — the owner rule from epic #3801 (rolling
 * days, no calendar month). `'7d'`/`'30d'`/`'90d'` mirror the API's
 * `period` enum; "All time" is the ABSENT parameter, not a fourth value.
 */
export type TransactionPeriodPreset = '7d' | '30d' | '90d'

/**
 * Client-side only — not a wire shape. Every dimension here rides the
 * `GET /transactions` request since #4095, so the loaded rows, the count,
 * the totals and the CSV export are the same set by construction.
 */
export interface TransactionFilterState {
  accountId?: string
  agentId?: string
  tokenKey?: string
  /**
   * Direction filter — incoming or outgoing only. Server-side since #4095:
   * the browser filtered the loaded page in memory, which could disagree
   * with the export over the whole result set.
   */
  direction?: 'in' | 'out'
  /**
   * Network filter — one chain id, or every chain (absent). Server-side
   * since #4095 (`chainId` on the list request), same motivation as
   * `direction`.
   */
  chainId?: number
  /**
   * Free-text search over what a row shows — the counterparty's resolved
   * name (contact, receipt merchant, or another of the user's own
   * accounts), the agent name, and the counterparty address. Resolved and
   * matched on the SERVER (#4095); the browser never had the whole result
   * set, so it could never search it honestly.
   */
  search?: string
  /** Rolling Period preset; exclusive with a custom `from`/`to` range. */
  period?: TransactionPeriodPreset
  /**
   * Custom-range start, `YYYY-MM-DD`, inclusive of the whole calendar day
   * in the user's zone. Sent together with `to`; exclusive with `period`.
   */
  from?: string
  /** Custom-range end, `YYYY-MM-DD` — inclusive of its whole zone day. */
  to?: string
  /**
   * Opt in to the all-accounts feed's own-transfer fold (#4265): a move
   * between two of the user's accounts comes back as ONE row carrying
   * `ownTransfer`. Set only by `/transactions` (#4266) — the per-account
   * ledger keeps both legs, each its own account's in or out — and
   * serialized by `transactionFilterParams`, so the list, its In/Out totals
   * and the CSV export all request the same folded set.
   */
  foldOwnTransfers?: boolean
}

export type TransactionFilterOptionsResponse = ApiSchema<'TransactionFilterOptionsResponse'>
/**
 * The filter-options envelope key is `accounts` now. It was the LAST retired
 * `safes` name on the wire: #2907 twinned the transaction query parameter
 * (`?accountId=`) but not this envelope, and #2914's contraction left it
 * because the two twinned response names were the urgent ones. Unlike those,
 * this key was never read by a published package — the dashboard is its only
 * consumer — so it was renamed outright rather than twinned.
 */
export type TransactionFilterAccountOption = TransactionFilterOptionsResponse['accounts'][number]
export type TransactionFilterAgentOption = TransactionFilterOptionsResponse['agents'][number]
export type TransactionFilterTokenOption = TransactionFilterOptionsResponse['tokens'][number]

/**
 * Wire item plus the `chainId` that `useBalances` grafts on client-side when
 * the caller passed one — the route itself never returns it (#984 finding).
 */
export type BalanceItem = ApiSchema<'BalanceItem'> & { chainId?: number }

export type BalancesResponse = ApiSchema<'BalancesResponse'>

// #4097: the receive-ledger and off-ramp wire aliases are removed here —
// #3333's off-ramp panel and its ledger hook were their last frontend user.
// The backend routes stay (#3333); the generated
// `ApiSchema<'…'>` source of truth in @haven_ai/core is unchanged, so a
// future cash-out surface re-declares an alias rather than a hand-written
// shape (the wire-type ratchet's rule, #1447).
export type PortfolioBreakdown = ApiSchema<'PortfolioBreakdown'>
export type PortfolioResponse = ApiSchema<'PortfolioResponse'>

import type { ReactNode } from 'react'
import type { ApiSchema } from '@haven_ai/core'
import type { StatusTone } from '@/components/ui/StatusBadge'

/**
 * Wire shapes come from `@haven_ai/core`'s generated API types (#984) — the
 * OpenAPI spec is the single source; nothing here restates a response field.
 * This module keeps the frontend's established names as aliases, plus the
 * frontend-ONLY derived types (presentation overrides, client-side filter
 * state) that extend the wire shapes rather than replacing them.
 */

/**
 * Who initiated a transaction (#2097). `'agent'` = agent-initiated (always
 * carries `agentName` too); `'human'` = user/dashboard-initiated (reserved —
 * nothing sets it today); `'unknown'` = outbound raw transfer with no agent
 * attribution. Direction `'in'` rows carry no `initiatedBy`.
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

/** Per-Safe page item (`GET /transactions/{safeAddress}`) — no Safe scope. */
export type Transaction = ApiSchema<'TransactionBase'> & {
  initiatedBy?: TransactionInitiator
}

/**
 * Aggregated-feed item plus the frontend-only presentation overrides used by
 * `TransactionsTable` when rendering non-transaction activity through the
 * same primitive. Wire fields come from the generated `Transaction` schema.
 */
export interface AggregatedTransaction extends ApiSchema<'Transaction'> {
  /**
   * Who initiated the payment (#2097). `'agent'` → agent-initiated (always
   * accompanied by `agentName`); `'human'` → user/dashboard-initiated
   * (reserved — nothing sets it today); `'unknown'` → outbound raw transfer
   * with no agent attribution. Direction `'in'` rows carry no `initiatedBy`.
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
   * through `TransactionsTable` so the table stays a single primitive.
   */
  statusBadge?: { label: string; tone: StatusTone }
  /**
   * Optional title override. When provided, replaces the rule-based title
   * the table would otherwise compute from direction / source / agentName.
   */
  titleOverride?: string
  /**
   * Optional from → to override for the From/To cell. When provided,
   * replaces the address-resolution path. Use sparingly — only when the
   * caller already has richer context than the table can resolve (e.g.
   * x402 hostname + tooltip).
   */
  movementOverride?: ReactNode
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

/** Client-side only — not a wire shape. */
export interface TransactionFilterState {
  safeId?: string
  agentId?: string
  tokenKey?: string
  /**
   * Direction filter — incoming or outgoing only. Applied client-side over
   * the fetched transactions; the API doesn't yet support this dimension.
   */
  direction?: 'in' | 'out'
}

export type TransactionFilterOptionsResponse = ApiSchema<'TransactionFilterOptionsResponse'>
export type TransactionFilterSafeOption = TransactionFilterOptionsResponse['safes'][number]
export type TransactionFilterAgentOption = TransactionFilterOptionsResponse['agents'][number]
export type TransactionFilterTokenOption = TransactionFilterOptionsResponse['tokens'][number]

/**
 * Wire item plus the `chainId` that `useBalances` grafts on client-side when
 * the caller passed one — the route itself never returns it (#984 finding).
 */
export type BalanceItem = ApiSchema<'BalanceItem'> & { chainId?: number }

export type BalancesResponse = ApiSchema<'BalancesResponse'>
export type PortfolioBreakdown = ApiSchema<'PortfolioBreakdown'>
export type PortfolioResponse = ApiSchema<'PortfolioResponse'>
export type SafeDetails = ApiSchema<'SafeDetails'>

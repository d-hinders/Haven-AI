/**
 * Shared shapes for the transactions module (#992). `routes/transactions.ts`
 * imports these (and only these + the functions in `index.ts`) — see the
 * module-entry-point dependency-cruiser rule.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { TransactionSafeRow } from '../../infra/repositories/transaction-history.js'

export interface Transaction {
  hash: string
  type: 'native' | 'erc20' | 'internal'
  from: string
  to: string
  value: string
  valueFormatted: string
  asset: string
  decimals: number
  direction: 'in' | 'out'
  timestamp: number
  blockNumber: number
  isError: boolean
  tokenAddress?: string
  tokenSymbol?: string
  source?: string
  x402ResourceUrl?: string | null
  x402MerchantAddress?: string | null
  paymentId?: string
  paymentProofStatus?: string | null
  paymentFlowStatus?: string | null
  paymentAttentionReason?: string | null
  activityType?: 'delegate_sweep'
  /** Book-time SEK value (P0 #463); null for non-machine / unpriced transactions. */
  amountSek?: string | null
}

export interface EnrichedTransaction extends Transaction {
  chainId: number
  safeId: string
  safeAddress: string
  safeName: string
  agentId?: string
  agentName?: string
  /**
   * Which settlement branch moved the money — `'eip3009' | 'erc7710'` — read
   * from the intent's `machine_metadata` JSONB (#1705, epic #1704).
   *
   * NOT `source` (the payment protocol) and NOT the account's
   * `execution_rail` (account architecture); the three axes stay unmerged.
   *
   * Null/absent whenever nothing was recorded: non-machine rows, and every
   * legacy-rail row — that rail is structurally EIP-3009 and never stamps the
   * key, so null-in-null-out leaves it blank rather than inferring a value.
   * Typed as the open `string | null` the wire carries; the spec's enum is the
   * contract. Populated by #1706.
   *
   * Note for #1706: this file's `Transaction` / `EnrichedTransaction` split
   * does NOT mirror the spec's `TransactionBase` / `Transaction` split
   * field-for-field. The field sits here, on the enriched shape, because that
   * is what enrichment maps over — the same placement `agentName` already
   * uses despite also living on the spec's `TransactionBase`.
   */
  settlementScheme?: string | null
}

/** Re-exported so route/module callers share one name for the Safe projection. */
export type UserSafeRow = TransactionSafeRow

export interface FetchSafeTransactionsParams {
  safeId: string
  safeAddress: string
  chainId: number
  log: FastifyBaseLogger
  fresh?: boolean
}

export interface FetchSafeTransactionsResult {
  transactions: Transaction[]
  hadFailures: boolean
}

export interface ParsedTokenFilter {
  chainId: number
  address: string | null
}

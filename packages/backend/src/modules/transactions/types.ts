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

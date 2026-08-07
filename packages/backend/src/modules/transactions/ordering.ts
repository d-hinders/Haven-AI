/**
 * Sort and dedup-key helpers, extracted verbatim from `routes/transactions.ts`
 * (#992). Shared by `aggregate.ts`, `enrichment.ts` and `orchestration.ts`.
 */
import type { EnrichedTransaction, Transaction } from './types.js'

export function compareTransactions(a: Transaction, b: Transaction): number {
  return (
    b.timestamp - a.timestamp ||
    b.blockNumber - a.blockNumber ||
    a.hash.localeCompare(b.hash) ||
    a.type.localeCompare(b.type) ||
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to)
  )
}

export function compareEnrichedTransactions(
  a: EnrichedTransaction,
  b: EnrichedTransaction,
): number {
  return compareTransactions(a, b) || a.safeAddress.localeCompare(b.safeAddress)
}

export function transactionDedupKey(tx: Transaction): string {
  return [
    tx.hash,
    tx.type,
    tx.from.toLowerCase(),
    tx.to.toLowerCase(),
    tx.value,
    tx.tokenAddress?.toLowerCase() ?? 'native',
  ].join(':')
}

export function enrichedTransactionIdentityKey(tx: EnrichedTransaction): string {
  return [tx.chainId, tx.safeId, transactionDedupKey(tx)].join(':')
}

export function paymentAgentIdentityKey(
  txHash: string,
  safeId: string,
  chainId: number,
): string {
  return `${txHash.toLowerCase()}:${safeId}:${chainId}`
}

/** `Date.parse` an ISO timestamp to epoch seconds; `0` on a bad string. */
export function parseIsoTimestamp(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}

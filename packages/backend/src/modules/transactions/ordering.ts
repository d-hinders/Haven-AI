/**
 * Sort and dedup-key helpers, extracted verbatim from `routes/transactions.ts`
 * (#992). Shared by `aggregate.ts`, `enrichment.ts` and `orchestration.ts`.
 */
import type { EnrichedTransaction, Transaction } from './types.js'

export function compareTransactions(a: Transaction, b: Transaction): number {
  return (
    b.timestamp - a.timestamp ||
    // #3129: `blockNumber` is nullable (an x402-synthesized row has none).
    // `?? 0` keeps this comparator's behaviour EXACTLY as it was, because the
    // value it replaces was literally `0` — the ordering of those rows is
    // unchanged, they just no longer claim to be in block zero.
    (b.blockNumber ?? 0) - (a.blockNumber ?? 0) ||
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
  return compareTransactions(a, b) || a.accountAddress.localeCompare(b.accountAddress)
}

export function transactionDedupKey(tx: Transaction): string {
  return [
    // #3129: lowercased, like every other component here and like
    // `paymentAgentIdentityKey` below. It was the one raw component, so the
    // two identity keys disagreed about whether hash casing matters — the
    // same "same value, two forms" trap the addresses carried. Transaction
    // hashes have no checksum, so lowercase IS their canonical form, and both
    // providers already emit it; this makes the agreement structural instead
    // of incidental.
    tx.hash.toLowerCase(),
    tx.type,
    tx.from.toLowerCase(),
    tx.to.toLowerCase(),
    tx.value,
    tx.tokenAddress?.toLowerCase() ?? 'native',
  ].join(':')
}

export function enrichedTransactionIdentityKey(tx: EnrichedTransaction): string {
  return [tx.chainId, tx.accountId, transactionDedupKey(tx)].join(':')
}

export function paymentAgentIdentityKey(
  txHash: string,
  accountId: string,
  chainId: number,
): string {
  return `${txHash.toLowerCase()}:${accountId}:${chainId}`
}

/** `Date.parse` an ISO timestamp to epoch seconds; `0` on a bad string. */
export function parseIsoTimestamp(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}

/**
 * Exported so characterization tests can pin the exact cache key format
 * (#992) — a silently changed key is a production cache-miss storm, not a
 * test failure. Moved verbatim from `routes/transactions.ts` where it was
 * extracted from the inline template literal that built `cacheKey` in
 * `fetchAccountTransactions`; no behavior change since that extraction.
 */
export function buildTransactionCacheKey(chainId: number, accountAddress: string): string {
  return `tx:${chainId}:${accountAddress.toLowerCase()}`
}

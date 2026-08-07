/**
 * Exported so characterization tests can pin the exact cache key format
 * (#992) — a silently changed key is a production cache-miss storm, not a
 * test failure. Moved verbatim from `routes/transactions.ts` where it was
 * extracted from the inline template literal that built `cacheKey` in
 * `fetchSafeTransactions`; no behavior change since that extraction.
 */
export function buildTransactionCacheKey(chainId: number, safeAddress: string): string {
  return `tx:${chainId}:${safeAddress.toLowerCase()}`
}

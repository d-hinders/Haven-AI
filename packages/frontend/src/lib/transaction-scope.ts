import type { AggregatedTransaction, TransactionFilterState } from '@/types/transactions'

export interface TransactionDirectionSummary {
  received: number
  sent: number
  failed: number
}

/**
 * Count loaded transactions by direction.
 *
 * Buckets are **mutually exclusive**: a failed outgoing transaction
 * counts in `failed`, not in both `failed` and `sent`. So
 * `received + sent + failed = transactions.length`.
 *
 * Used by the `/transactions` summary row when filters are active.
 * Amount aggregation is intentionally not surfaced — summing across
 * mixed-token transactions either lies (single number) or gets noisy
 * (per-token breakdown). Counts answer "is this view mostly incoming
 * or outgoing?" without overpromising on aggregates.
 */
export function buildTransactionSummary(
  transactions: ReadonlyArray<AggregatedTransaction>,
): TransactionDirectionSummary {
  let received = 0
  let sent = 0
  let failed = 0
  for (const tx of transactions) {
    if (tx.isError) {
      failed += 1
    } else if (tx.direction === 'in') {
      received += 1
    } else {
      sent += 1
    }
  }
  return { received, sent, failed }
}

/**
 * Render the `/transactions` page subtitle for a given filter state.
 *
 * Goals:
 * - When the user arrived at the page from `/accounts/[safeId]` → /transactions?safeId=…
 *   (the "View all →" link), the subtitle reads "Transactions for {accountName}"
 *   so the page feels intentional rather than as if the user landed on the
 *   global feed and the filter happened by accident.
 * - Account + agent scope combine.
 * - Token narrowing appears as a trailing " · {symbol}" so the user can read
 *   it left-to-right.
 * - Direction (in/out) is communicated by the visible filter chip; we don't
 *   duplicate it in the subtitle.
 *
 * Pure helper — accepts pre-resolved name maps so it's trivially testable.
 */
export function buildTransactionScopeSubtitle(
  filters: TransactionFilterState,
  lookups: {
    accountNamesById: Map<string, string>
    agentNamesById: Map<string, string>
    tokenSymbolsByKey: Map<string, string>
  },
  defaultSubtitle = 'All activity across your accounts.',
): string {
  const accountName = filters.safeId
    ? lookups.accountNamesById.get(filters.safeId)
    : undefined
  const agentName = filters.agentId
    ? lookups.agentNamesById.get(filters.agentId)
    : undefined
  const tokenSymbol = filters.tokenKey
    ? lookups.tokenSymbolsByKey.get(filters.tokenKey)
    : undefined

  let body: string
  if (accountName && agentName) {
    body = `Payments by ${agentName} from ${accountName}`
  } else if (accountName) {
    body = `Transactions for ${accountName}`
  } else if (agentName) {
    body = `Payments by ${agentName}`
  } else {
    return tokenSymbol
      ? `${defaultSubtitle.replace(/\.\s*$/, '')} · ${tokenSymbol}`
      : defaultSubtitle
  }

  return tokenSymbol ? `${body} · ${tokenSymbol}` : body
}

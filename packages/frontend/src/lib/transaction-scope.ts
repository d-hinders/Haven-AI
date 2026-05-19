import type { TransactionFilterState } from '@/types/transactions'

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

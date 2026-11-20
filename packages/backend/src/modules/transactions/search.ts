/**
 * Server-side search over the transaction feed and export (#4095).
 *
 * The rule: search matches WHAT THE ROW SHOWS — the counterparty's resolved
 * names (another of the user's own accounts, an address-book contact, the
 * catalog merchant, the receipt seller — #4882's naming sources), the agent
 * name, the product label of a recorded sale (#5000: the row reads
 * "Sale · <product>"), and the counterparty address itself. Name
 * resolution therefore happens BEFORE filtering, on the server, for both
 * endpoints: the browser used to resolve names for display only, so a search
 * for a contact's name could never find the row in memory.
 *
 * Folding (the builder's call): case-insensitive AND accent-insensitive —
 * `Café` finds `cafe` — via NFD decomposition stripping the combining marks.
 * Addresses match as case-insensitive SUBSTRINGS, so a pasted partial
 * address finds its row.
 */
import type { EnrichedTransaction } from './types.js'
import {
  EMPTY_RECIPIENT_NAME_INDEX,
  allRecipientNames,
  recipientAddressOf,
  type RecipientNameIndex,
} from './counterparty-name.js'

/**
 * #4882: the search index IS the recipient-naming index — one read of each
 * name source (`loadRecipientNameIndex`), so a row is found by exactly the
 * names the naming order can show for it.
 */
export interface TransactionSearchIndex {
  names: RecipientNameIndex
}

export const EMPTY_SEARCH_INDEX: TransactionSearchIndex = { names: EMPTY_RECIPIENT_NAME_INDEX }

export function foldForSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

/** The address a row NAMES as the other side — the naming module's one lookup key. */
export function counterpartyAddressOf(tx: EnrichedTransaction): string {
  return recipientAddressOf(tx)
}

/**
 * Every name the row can show for its counterparty, in the naming order:
 * own account, contact, catalog merchant (#4882), receipt seller — every
 * source with a name, not only the winner, so an internal transfer stays
 * findable by the far account's name and a merchant by its catalog name.
 */
export function resolvedCounterpartyNames(
  tx: EnrichedTransaction,
  index: TransactionSearchIndex,
): string[] {
  return allRecipientNames(index.names, {
    address: counterpartyAddressOf(tx),
    chainId: tx.chainId,
    x402ResourceUrl: null,
  })
}

export function transactionMatchesSearch(
  tx: EnrichedTransaction,
  index: TransactionSearchIndex,
  foldedTerm: string,
): boolean {
  if (foldedTerm === '') return true
  const haystacks = resolvedCounterpartyNames(tx, index).map(foldForSearch)
  if (tx.agentName) haystacks.push(foldForSearch(tx.agentName))
  if (tx.sale?.productName) haystacks.push(foldForSearch(tx.sale.productName))
  haystacks.push(counterpartyAddressOf(tx).toLowerCase())
  return haystacks.some((haystack) => haystack.includes(foldedTerm))
}

/** Distinct counterparty addresses of a feed — the receipt-name read's input. */
export function counterpartyAddressesOf(transactions: EnrichedTransaction[]): string[] {
  return Array.from(new Set(transactions.map((tx) => counterpartyAddressOf(tx))))
}

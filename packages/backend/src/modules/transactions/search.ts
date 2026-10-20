/**
 * Server-side search over the transaction feed and export (#4095).
 *
 * The rule: search matches WHAT THE ROW SHOWS — the counterparty's resolved
 * name (address-book contact, receipt merchant, or another of the user's own
 * accounts), the agent name, and the counterparty address itself. Name
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

export interface TransactionSearchIndex {
  /** Address-book contacts, keyed by lowercased address (chain-agnostic). */
  contactNames: Map<string, string>
  /** Receipt merchant names, keyed by lowercased address (analytics' label order: contacts win). */
  receiptNames: Map<string, string>
  /** The user's own account names, keyed `addrLower:chainId` — internal transfers. */
  accountNames: Map<string, string>
}

export const EMPTY_SEARCH_INDEX: TransactionSearchIndex = {
  contactNames: new Map(),
  receiptNames: new Map(),
  accountNames: new Map(),
}

export function foldForSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

/**
 * The address a row NAMES as the other side: where the money went on an
 * outgoing row (the merchant address for an x402 payment), where it came
 * from on an incoming one.
 */
export function counterpartyAddressOf(tx: EnrichedTransaction): string {
  if (tx.direction === 'in') return tx.from
  return tx.x402MerchantAddress ?? tx.to
}

/**
 * Every name the row can show for its counterparty, in the dashboard's label
 * order: contact, then receipt merchant, then the user's own account (an
 * internal transfer between two of the user's accounts must be findable by
 * the far account's name).
 */
export function resolvedCounterpartyNames(
  tx: EnrichedTransaction,
  index: TransactionSearchIndex,
): string[] {
  const key = counterpartyAddressOf(tx).toLowerCase()
  const names: string[] = []
  const contact = index.contactNames.get(key)
  if (contact !== undefined) names.push(contact)
  const receipt = index.receiptNames.get(key)
  if (receipt !== undefined) names.push(receipt)
  const account = index.accountNames.get(`${key}:${tx.chainId}`)
  if (account !== undefined) names.push(account)
  return names
}

export function transactionMatchesSearch(
  tx: EnrichedTransaction,
  index: TransactionSearchIndex,
  foldedTerm: string,
): boolean {
  if (foldedTerm === '') return true
  const haystacks = resolvedCounterpartyNames(tx, index).map(foldForSearch)
  if (tx.agentName) haystacks.push(foldForSearch(tx.agentName))
  haystacks.push(counterpartyAddressOf(tx).toLowerCase())
  return haystacks.some((haystack) => haystack.includes(foldedTerm))
}

/** Distinct counterparty addresses of a feed — the receipt-name read's input. */
export function counterpartyAddressesOf(transactions: EnrichedTransaction[]): string[] {
  return Array.from(new Set(transactions.map((tx) => counterpartyAddressOf(tx))))
}

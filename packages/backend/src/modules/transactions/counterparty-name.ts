/**
 * The recipient-naming module (#4882, epic #4879; first written for
 * analytics in #4332).
 *
 * ONE definition of how the other side of a payment is NAMED, on every
 * surface: the analytics merchants table, the dashboard's top merchant, last
 * payments, activity feed and first-payment card, the transactions list, its
 * search and CSV export, and the agent ledger with its CSV. The order is the
 * owner's (epic #4879, *Owner decisions*, 2026-11-16 — "Yes, that order"):
 *
 *   1. one of the user's own accounts → that account's name (the account on
 *      the payment's chain first, else the OLDEST account at that address on
 *      any chain);
 *   2. an address-book contact → the contact name;
 *   3. the catalog's merchant name — when the address is the receiving
 *      address of exactly one Haven-curated catalog merchant on that chain
 *      (`CATALOG_RECIPIENT_NAMES_SQL`, owner decision 1 of 2026-11-17 on
 *      #4882: `operator` rows only);
 *   4. the receipt's seller name (`RECEIPT_MERCHANT_NAMES_SQL`, #4881) —
 *      unless it BORROWS a catalog merchant's name: a seller name equal
 *      (normalised) to a catalog merchant's name, at an address that is not
 *      one of that merchant's, is not used;
 *   5. the x402 resource host;
 *   6. otherwise `null` — the client renders its own fallback ("Unknown
 *      recipient" / "New recipient").
 *
 * It replaces two earlier orders: analytics put the resource host FIRST
 * (#4332) and the activity feed put own accounts after contacts and receipts
 * (#4099). The module owns the LOOKUP KEY as well (`recipientAddressOf`), so
 * no consumer can name a row by a different address than another.
 *
 * The loader (`recipient-name-index.ts`) fetches the candidates once per
 * request; this module is pure, so the order is testable without a database.
 */
import { parseX402Hostname } from '@haven_ai/core'

/** Which naming step produced a name. */
export type RecipientNameSource = 'own_account' | 'contact' | 'catalog' | 'receipt' | 'x402'
/** The wire `kind`: a source, or `unknown` when nothing named the recipient. */
export type CounterpartyKind = RecipientNameSource | 'unknown'

export interface CounterpartyName {
  /** `null` when nothing resolved — the client renders its own fallback. */
  label: string | null
  kind: CounterpartyKind
}

/** The candidates for one request, keyed for lookup. Built by `loadRecipientNameIndex`. */
export interface RecipientNameIndex {
  /** The user's own accounts, in `created_at ASC` order (oldest first), across all chains. */
  accounts: ReadonlyArray<{ account_address: string; chain_id: number; name: string }>
  /** Address-book contacts, keyed by lowercased address (chain-agnostic). */
  contacts: ReadonlyMap<string, string>
  /** Catalog merchant names, keyed by lowercased address: one entry per chain the address is named on. */
  catalog: ReadonlyMap<string, ReadonlyArray<{ chainId: number; name: string }>>
  /** Receipt seller names, keyed by lowercased address. */
  receipts: ReadonlyMap<string, string>
  /**
   * Keyed by `recipientNameKey`: for every catalog merchant (any source) whose
   * name key equals a receipt name's, the receiving addresses (lowercased)
   * its CURATED rows record — the input of the borrowing rule. A key absent
   * from the map is no catalog merchant's name.
   */
  catalogNameAddresses: ReadonlyMap<string, ReadonlySet<string>>
}

export const EMPTY_RECIPIENT_NAME_INDEX: RecipientNameIndex = {
  accounts: [],
  contacts: new Map(),
  catalog: new Map(),
  receipts: new Map(),
  catalogNameAddresses: new Map(),
}

/** What one row offers the order: its counterparty address, chain and resource URL. */
export interface RecipientTarget {
  address: string | null
  /** The payment's chain; `null` when the row aggregates across chains (see the catalog step). */
  chainId: number | null
  x402ResourceUrl: string | null
}

/**
 * The key the receipt-borrowing rule compares names by: the compatibility
 * decomposition (NFKD), lower-cased, with everything but ASCII letters and
 * digits removed — so spacing, punctuation, zero-width characters and
 * accents cannot separate a borrowed name from the original. The SQL side
 * (`NAME_KEY_SQL`, `infra/repositories/merchants.ts`) computes the same key.
 * A name with no ASCII letter or digit has an empty key and is not compared
 * (a residual: non-Latin names and look-alike letters from another script).
 */
export function recipientNameKey(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The address a transaction row NAMES as its other side — the one lookup key
 * every consumer uses: where the money came from on an incoming row; on an
 * outgoing one the x402 merchant address when recorded (the payee behind a
 * delegate funding leg), else where it went.
 */
export function recipientAddressOf(tx: {
  direction: 'in' | 'out'
  from: string
  to: string
  x402MerchantAddress?: string | null
}): string {
  if (tx.direction === 'in') return tx.from
  return tx.x402MerchantAddress ?? tx.to
}

function ownAccountName(index: RecipientNameIndex, key: string, chainId: number | null): string | null {
  const atAddress = index.accounts.filter((a) => a.account_address.toLowerCase() === key)
  if (atAddress.length === 0) return null
  const onChain = chainId === null ? undefined : atAddress.find((a) => a.chain_id === chainId)
  return (onChain ?? atAddress[0]).name
}

/**
 * The catalog name for an address. On a known chain: the entry for that
 * chain. On a row that aggregates across chains (`chainId: null`): the name
 * only when every chain the address is named on names the same merchant.
 */
function catalogName(index: RecipientNameIndex, key: string, chainId: number | null): string | null {
  const entries = index.catalog.get(key)
  if (!entries || entries.length === 0) return null
  if (chainId !== null) return entries.find((e) => e.chainId === chainId)?.name ?? null
  const names = new Set(entries.map((e) => e.name))
  return names.size === 1 ? entries[0].name : null
}

/** The receipt name, unless it borrows a catalog merchant's name at an address that is not that merchant's. */
function receiptName(index: RecipientNameIndex, key: string): string | null {
  const name = index.receipts.get(key)
  if (!name) return null
  const key2 = recipientNameKey(name)
  const catalogAddresses = key2 === '' ? undefined : index.catalogNameAddresses.get(key2)
  if (catalogAddresses && !catalogAddresses.has(key)) return null
  return name
}

/** The one naming order. */
export function resolveRecipientName(index: RecipientNameIndex, target: RecipientTarget): CounterpartyName {
  if (target.address) {
    const key = target.address.toLowerCase()
    const own = ownAccountName(index, key, target.chainId)
    if (own) return { label: own, kind: 'own_account' }
    const contact = index.contacts.get(key)
    if (contact) return { label: contact, kind: 'contact' }
    const catalog = catalogName(index, key, target.chainId)
    if (catalog) return { label: catalog, kind: 'catalog' }
    const receipt = receiptName(index, key)
    if (receipt) return { label: receipt, kind: 'receipt' }
  }
  // An unparseable URL yields no hostname, so it does not claim the step.
  const host = parseX402Hostname(target.x402ResourceUrl)
  if (host) return { label: host, kind: 'x402' }
  return { label: null, kind: 'unknown' }
}

/**
 * The name from the order's NAME sources only (steps 1–4), without the
 * resource-host step: for the wire fields that carry the host beside the name
 * (`merchantName` next to `x402ResourceUrl`) and let the client fall back to
 * it, so a client that ignores the new fields behaves as before.
 */
export function recipientNameWithoutHost(index: RecipientNameIndex, target: RecipientTarget): string | null {
  const named = resolveRecipientName(index, { ...target, x402ResourceUrl: null })
  return named.label
}

/**
 * Every name a row can be FOUND by in search (#4095: search matches what the
 * row shows): each name source that has a name for the address, in the
 * order's order — not only the winner, so an internal transfer stays findable
 * by the far account's name and a contact by the catalog name.
 */
export function allRecipientNames(index: RecipientNameIndex, target: RecipientTarget): string[] {
  if (!target.address) return []
  const key = target.address.toLowerCase()
  return [
    ownAccountName(index, key, target.chainId),
    index.contacts.get(key) ?? null,
    catalogName(index, key, target.chainId),
    receiptName(index, key),
  ].filter((n): n is string => n !== null)
}

/**
 * The snake_case wire pair for one resolved name, on the hand-mapped agent
 * ledger reads (`counterparty_name` / `counterparty_name_source`).
 */
export function recipientNameSnakeWire(name: CounterpartyName): {
  counterparty_name: string | null
  counterparty_name_source: CounterpartyKind | null
} {
  return { counterparty_name: name.label, counterparty_name_source: name.label === null ? null : name.kind }
}

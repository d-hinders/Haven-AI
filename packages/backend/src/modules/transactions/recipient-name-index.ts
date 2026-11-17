/**
 * The loader for the recipient-naming order (#4882): one read of each name
 * source per request, over the addresses the request will name. The order
 * itself is `counterparty-name.ts`.
 *
 * Fail-soft by source: the names are display garnish, so a contacts, catalog
 * or receipt read that fails degrades to "no names from that source" instead
 * of failing the request — the posture every consumer had before (#3824,
 * #4095). The own-accounts list is the caller's to pass when it already holds
 * it, so a route never reads it twice.
 */
import { listContactsForUser } from '../../infra/repositories/contacts.js'
import { listReceiptMerchantNamesForUser } from '../../infra/repositories/analytics.js'
import { listCatalogMerchantNameAddresses, listCatalogRecipientNames } from '../../infra/repositories/merchants.js'
import { listAccountsForUser } from '../../infra/repositories/smart-accounts.js'
import { normaliseRecipientName, type RecipientNameIndex } from './counterparty-name.js'

export interface LoadRecipientNameIndexOptions {
  /** The user's accounts, `created_at ASC`, when the caller already read them. */
  accounts?: ReadonlyArray<{ account_address: string; chain_id: number; name: string | null }>
  /** The user's contacts, when the caller already read them. */
  contacts?: ReadonlyArray<{ address: string; name: string }>
}

export async function loadRecipientNameIndex(
  userId: string,
  addresses: ReadonlyArray<string | null | undefined>,
  options: LoadRecipientNameIndexOptions = {},
): Promise<RecipientNameIndex> {
  const keys = [...new Set(addresses.filter((a): a is string => !!a).map((a) => a.toLowerCase()))]
  const [accounts, contacts, catalogRows, receipts] = await Promise.all([
    options.accounts ?? listAccountsForUser(userId).catch(() => []),
    options.contacts ?? listContactsForUser(userId).catch(() => []),
    keys.length > 0 ? listCatalogRecipientNames(keys).catch(() => []) : Promise.resolve([]),
    keys.length > 0
      ? listReceiptMerchantNamesForUser(userId, keys).catch(() => new Map<string, string>())
      : Promise.resolve(new Map<string, string>()),
  ])

  const catalog = new Map<string, Array<{ chainId: number; name: string }>>()
  for (const row of catalogRows) {
    const key = row.pay_to.toLowerCase()
    const entries = catalog.get(key) ?? []
    entries.push({ chainId: Number(row.chain_id), name: row.name })
    catalog.set(key, entries)
  }

  const receiptNormNames = [...new Set([...receipts.values()].map(normaliseRecipientName))]
  // Fail-CLOSED for the borrowing rule: without it a receipt could borrow a
  // catalog name, so when the read fails no receipt name is used at all.
  const nameRows = await listCatalogMerchantNameAddresses(receiptNormNames).catch(() => null)
  const usableReceipts = nameRows === null ? new Map<string, string>() : receipts
  const catalogNameAddresses = new Map<string, Set<string>>()
  for (const row of nameRows ?? []) {
    const set = catalogNameAddresses.get(row.norm_name) ?? new Set<string>()
    if (row.pay_to) set.add(row.pay_to.toLowerCase())
    catalogNameAddresses.set(row.norm_name, set)
  }

  return {
    accounts: accounts.flatMap((a) =>
      a.name ? [{ account_address: a.account_address, chain_id: a.chain_id, name: a.name }] : [],
    ),
    contacts: new Map(contacts.map((c) => [c.address.toLowerCase(), c.name])),
    catalog,
    receipts: usableReceipts,
    catalogNameAddresses,
  }
}

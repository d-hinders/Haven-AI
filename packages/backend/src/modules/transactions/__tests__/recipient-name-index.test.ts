import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #4882: the loader's failure posture. Each name source is fail-soft (a
 * failed read means "no names from that source"), except the lookup behind
 * the receipt-borrowing rule, which fails CLOSED: without it a receipt could
 * borrow a catalog merchant's name, so no receipt name is used at all.
 */

const { repos } = vi.hoisted(() => ({
  repos: {
    listContactsForUser: vi.fn(),
    listReceiptMerchantNamesForUser: vi.fn(),
    listCatalogRecipientNames: vi.fn(),
    listCatalogMerchantNameAddresses: vi.fn(),
    listAccountsForUser: vi.fn(),
  },
}))

vi.mock('../../../infra/repositories/contacts.js', () => ({ listContactsForUser: repos.listContactsForUser }))
vi.mock('../../../infra/repositories/analytics.js', () => ({
  listReceiptMerchantNamesForUser: repos.listReceiptMerchantNamesForUser,
}))
vi.mock('../../../infra/repositories/merchants.js', () => ({
  listCatalogRecipientNames: repos.listCatalogRecipientNames,
  listCatalogMerchantNameAddresses: repos.listCatalogMerchantNameAddresses,
}))
vi.mock('../../../infra/repositories/smart-accounts.js', () => ({ listAccountsForUser: repos.listAccountsForUser }))

const { loadRecipientNameIndex } = await import('../recipient-name-index.js')

const ADDR = `0x${'ab'.repeat(20)}`

describe('loadRecipientNameIndex failure posture (#4882)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    repos.listContactsForUser.mockResolvedValue([{ address: ADDR, name: 'Acme AB' }])
    repos.listAccountsForUser.mockResolvedValue([])
    repos.listCatalogRecipientNames.mockResolvedValue([])
    repos.listReceiptMerchantNamesForUser.mockResolvedValue(new Map([[ADDR, 'Klara Data AB']]))
    repos.listCatalogMerchantNameAddresses.mockResolvedValue([])
  })

  it('keeps every source when every read succeeds', async () => {
    const index = await loadRecipientNameIndex('u1', [ADDR])
    expect(index.contacts.get(ADDR)).toBe('Acme AB')
    expect(index.receipts.get(ADDR)).toBe('Klara Data AB')
  })

  it('a failed contacts, catalog or receipt read degrades to no names from that source', async () => {
    repos.listContactsForUser.mockRejectedValue(new Error('down'))
    repos.listCatalogRecipientNames.mockRejectedValue(new Error('down'))
    const index = await loadRecipientNameIndex('u1', [ADDR])
    expect(index.contacts.size).toBe(0)
    expect(index.catalog.size).toBe(0)
    expect(index.receipts.get(ADDR)).toBe('Klara Data AB')
  })

  it('fails CLOSED when the borrowing-rule read fails: no receipt name is used', async () => {
    repos.listCatalogMerchantNameAddresses.mockRejectedValue(new Error('down'))
    const index = await loadRecipientNameIndex('u1', [ADDR])
    expect(index.receipts.size).toBe(0)
    expect(index.contacts.get(ADDR)).toBe('Acme AB')
  })
})

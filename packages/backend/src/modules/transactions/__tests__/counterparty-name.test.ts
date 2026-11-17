import { describe, expect, it } from 'vitest'
import {
  EMPTY_RECIPIENT_NAME_INDEX,
  allRecipientNames,
  recipientNameKey,
  recipientAddressOf,
  recipientNameWithoutHost,
  resolveRecipientName,
  type RecipientNameIndex,
} from '../counterparty-name.js'

/**
 * Per-step proof of the ONE recipient-naming order (#4882; the owner's order,
 * epic #4879, 2026-11-16): own account → contact → catalog merchant →
 * receipt seller → x402 resource host → none. Pure: the loader fetches the
 * candidates, this module owns the ORDER. Rewritten from #4332's host-first
 * order, which this replaces.
 */

const ADDR = `0x${'ab'.repeat(20)}`
const OTHER = `0x${'cd'.repeat(20)}`
const HOST_URL = 'https://api.nordshield.example/v1'

function index(over: Partial<RecipientNameIndex> = {}): RecipientNameIndex {
  return { ...EMPTY_RECIPIENT_NAME_INDEX, ...over }
}

const FULL = index({
  accounts: [{ account_address: ADDR, chain_id: 8453, name: 'Old Vault' }],
  contacts: new Map([[ADDR, 'Acme AB']]),
  catalog: new Map([[ADDR, [{ chainId: 8453, name: 'NordShield VPN' }]]]),
  receipts: new Map([[ADDR, 'Klara Data AB']]),
})
const target = (over: Partial<{ address: string | null; chainId: number | null; x402ResourceUrl: string | null }> = {}) => ({
  address: ADDR,
  chainId: 8453,
  x402ResourceUrl: HOST_URL,
  ...over,
})

describe('resolveRecipientName — the one order', () => {
  it('step 1 — an own account wins over every later candidate, the host included', () => {
    expect(resolveRecipientName(FULL, target())).toEqual({ label: 'Old Vault', kind: 'own_account' })
  })

  it('step 1 — the account on the payment chain wins; else the OLDEST account at the address', () => {
    const accounts = [
      { account_address: ADDR, chain_id: 1, name: 'Oldest' },
      { account_address: ADDR, chain_id: 8453, name: 'Base Vault' },
    ]
    expect(resolveRecipientName(index({ accounts }), target()).label).toBe('Base Vault')
    expect(resolveRecipientName(index({ accounts }), target({ chainId: 10 })).label).toBe('Oldest')
    expect(resolveRecipientName(index({ accounts }), target({ chainId: null })).label).toBe('Oldest')
  })

  it('step 2 — a contact names before the catalog, the receipt and the host', () => {
    expect(resolveRecipientName({ ...FULL, accounts: [] }, target())).toEqual({ label: 'Acme AB', kind: 'contact' })
  })

  it('step 3 — the catalog merchant names before the receipt and the host', () => {
    expect(resolveRecipientName({ ...FULL, accounts: [], contacts: new Map() }, target())).toEqual({
      label: 'NordShield VPN',
      kind: 'catalog',
    })
  })

  it('step 3 — the catalog step is chain-keyed: another chain does not match', () => {
    const named = resolveRecipientName(index({ catalog: FULL.catalog }), target({ chainId: 84532, x402ResourceUrl: null }))
    expect(named).toEqual({ label: null, kind: 'unknown' })
  })

  it('step 3 — across chains (chainId null) only when every chain names the same merchant', () => {
    const same = index({ catalog: new Map([[ADDR, [{ chainId: 1, name: 'A' }, { chainId: 8453, name: 'A' }]]]) })
    const split = index({ catalog: new Map([[ADDR, [{ chainId: 1, name: 'A' }, { chainId: 8453, name: 'B' }]]]) })
    expect(resolveRecipientName(same, target({ chainId: null })).label).toBe('A')
    expect(resolveRecipientName(split, target({ chainId: null, x402ResourceUrl: null })).label).toBeNull()
  })

  it('step 4 — the receipt seller names before the host', () => {
    expect(resolveRecipientName(index({ receipts: FULL.receipts }), target())).toEqual({
      label: 'Klara Data AB',
      kind: 'receipt',
    })
  })

  it('step 4 — a receipt cannot borrow a catalog merchant name at an address that is not that merchant’s', () => {
    const borrowing = index({
      receipts: new Map([[ADDR, '  nordshield   VPN ']]),
      catalogNameAddresses: new Map([['nordshieldvpn', new Set([OTHER])]]),
    })
    expect(resolveRecipientName(borrowing, target())).toEqual({ label: 'api.nordshield.example', kind: 'x402' })
    // At the merchant's own address the same receipt name is used.
    const own = index({
      receipts: new Map([[ADDR, 'NordShield VPN']]),
      catalogNameAddresses: new Map([['nordshieldvpn', new Set([ADDR])]]),
    })
    expect(resolveRecipientName(own, target()).label).toBe('NordShield VPN')
    // A catalog merchant with no recorded address: the name is never borrowable.
    const noAddress = index({
      receipts: new Map([[ADDR, 'NordShield VPN']]),
      catalogNameAddresses: new Map([['nordshieldvpn', new Set<string>()]]),
    })
    expect(resolveRecipientName(noAddress, target({ x402ResourceUrl: null })).label).toBeNull()
  })

  it('step 5 — the resource host names when no name source does', () => {
    expect(resolveRecipientName(index(), target())).toEqual({ label: 'api.nordshield.example', kind: 'x402' })
  })

  it('step 5 — an UNPARSEABLE resource URL does not claim the step', () => {
    expect(resolveRecipientName(index(), target({ x402ResourceUrl: 'not a url' }))).toEqual({ label: null, kind: 'unknown' })
  })

  it('step 6 — nothing resolves: label null, kind unknown; a missing address still reaches the host', () => {
    expect(resolveRecipientName(index(), target({ x402ResourceUrl: null }))).toEqual({ label: null, kind: 'unknown' })
    expect(resolveRecipientName(FULL, target({ address: null })).kind).toBe('x402')
  })

  it('matches addresses case-insensitively', () => {
    expect(resolveRecipientName(FULL, target({ address: ADDR.toUpperCase().replace('0X', '0x') })).label).toBe('Old Vault')
  })
})

describe('the helpers', () => {
  it('recipientNameWithoutHost drops only the host step', () => {
    expect(recipientNameWithoutHost(index(), target())).toBeNull()
    expect(recipientNameWithoutHost(index({ receipts: FULL.receipts }), target())).toBe('Klara Data AB')
  })

  it('allRecipientNames lists every name source with a name, in order (search)', () => {
    expect(allRecipientNames(FULL, target())).toEqual(['Old Vault', 'Acme AB', 'NordShield VPN', 'Klara Data AB'])
    expect(allRecipientNames(FULL, target({ address: null }))).toEqual([])
  })

  it('recipientAddressOf is the one lookup key: the sender in, the x402 merchant (else to) out', () => {
    const row = { direction: 'out' as const, from: '0xfrom', to: '0xto', x402MerchantAddress: '0xmerchant' }
    expect(recipientAddressOf(row)).toBe('0xmerchant')
    expect(recipientAddressOf({ ...row, x402MerchantAddress: null })).toBe('0xto')
    expect(recipientAddressOf({ ...row, direction: 'in' })).toBe('0xfrom')
  })

  it('recipientNameKey folds case, spacing, punctuation, zero-width characters and accents away', () => {
    expect(recipientNameKey('  Klara\t Data   AB ')).toBe('klaradataab')
    expect(recipientNameKey('Nord\u200bShield-VPN')).toBe('nordshieldvpn')
    expect(recipientNameKey('Café\u00a0Brasil')).toBe('cafebrasil')
    expect(recipientNameKey('日本')).toBe('')
  })
})

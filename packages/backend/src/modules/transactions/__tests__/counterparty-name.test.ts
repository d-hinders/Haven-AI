import { describe, expect, it } from 'vitest'
import { ownAccountNameForAddress, resolveCounterpartyName } from '../counterparty-name.js'

/**
 * Per-step proof of the settled naming order (#4332 Scope §2):
 * x402 host → own account → contact → receipt → none. Pure — the route
 * fetches the candidates; this module owns the ORDER.
 */

describe('resolveCounterpartyName', () => {
  it('step 1 — the x402 resource host wins over every later candidate', () => {
    expect(
      resolveCounterpartyName({
        x402ResourceUrl: 'https://api.nordshield.example/v1',
        ownAccountName: 'Old Vault',
        contactName: 'NordShield GmbH',
        receiptName: 'Klara Data AB',
      }),
    ).toEqual({ label: 'api.nordshield.example', kind: 'x402' })
  })

  it('step 1 — an UNPARSEABLE resource URL does not claim the step', () => {
    expect(
      resolveCounterpartyName({
        x402ResourceUrl: 'not a url',
        ownAccountName: null,
        contactName: 'Acme AB',
        receiptName: null,
      }),
    ).toEqual({ label: 'Acme AB', kind: 'contact' })
  })

  it('step 2 — an own account names before a contact', () => {
    expect(
      resolveCounterpartyName({
        x402ResourceUrl: null,
        ownAccountName: 'Old Vault',
        contactName: 'Acme AB',
        receiptName: 'Klara Data AB',
      }),
    ).toEqual({ label: 'Old Vault', kind: 'own_account' })
  })

  it('step 3 — a contact names before the receipt', () => {
    expect(
      resolveCounterpartyName({
        x402ResourceUrl: null,
        ownAccountName: null,
        contactName: 'Acme AB',
        receiptName: 'Klara Data AB',
      }),
    ).toEqual({ label: 'Acme AB', kind: 'contact' })
  })

  it('step 4 — the receipt merchant_name is the last resolvable step (the analytics-only extension)', () => {
    expect(
      resolveCounterpartyName({
        x402ResourceUrl: null,
        ownAccountName: null,
        contactName: null,
        receiptName: 'Klara Data AB',
      }),
    ).toEqual({ label: 'Klara Data AB', kind: 'receipt' })
  })

  it('step 5 — nothing resolves: label null, kind unknown', () => {
    expect(
      resolveCounterpartyName({
        x402ResourceUrl: null,
        ownAccountName: null,
        contactName: null,
        receiptName: null,
      }),
    ).toEqual({ label: null, kind: 'unknown' })
  })
})

describe('ownAccountNameForAddress — the address-only rule', () => {
  const accounts = [
    { account_address: `0x${'33'.repeat(20)}`, name: 'Old Vault' }, // chain 1 — oldest
    { account_address: `0x${'33'.repeat(20)}`, name: 'New Vault' }, // chain 84532
    { account_address: `0x${'77'.repeat(20)}`, name: 'Main' },
  ]

  it('names from the OLDEST account when several share the address, on any chain', () => {
    expect(ownAccountNameForAddress(accounts, `0x${'33'.repeat(20)}`)).toBe('Old Vault')
  })

  it('matches case-insensitively and misses cleanly', () => {
    expect(ownAccountNameForAddress(accounts, `0x${'33'.repeat(20).toUpperCase()}`)).toBe('Old Vault')
    expect(ownAccountNameForAddress(accounts, `0x${'99'.repeat(20)}`)).toBeNull()
  })
})

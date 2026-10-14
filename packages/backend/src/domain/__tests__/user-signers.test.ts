import { describe, expect, it } from 'vitest'
import { aggregateUserSigners, type AccountSignerSet } from '../user-signers.js'

function acct(id: string, chain: number, address: string, name: string | null = null) {
  return { account_id: id, account_address: address, account_name: name, chain_id: chain }
}

describe('aggregateUserSigners (#3825)', () => {
  it('lists one passkey once across two chains, case-insensitively, with both accounts', () => {
    const sets: AccountSignerSet[] = [
      { account: acct('a2', 84532, '0xbb'), ownerAddress: null, passkeys: [{ keyId: '0xABC', createdAt: '2026-02-01T00:00:00.000Z' }] },
      { account: acct('a1', 8453, '0xaa', 'Main'), ownerAddress: null, passkeys: [{ keyId: '0xabc', createdAt: '2026-01-01T00:00:00.000Z' }] },
    ]
    const out = aggregateUserSigners(sets)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'passkey', key_id: '0xabc', created_at: '2026-01-01T00:00:00.000Z' })
    expect(out[0].accounts.map((a) => a.chain_id)).toEqual([84532, 8453].sort((a, b) => a - b))
  })

  it('keeps created_at null when no account knows a date, and uses a known one over null', () => {
    const out = aggregateUserSigners([
      { account: acct('a1', 8453, '0xaa'), ownerAddress: null, passkeys: [{ keyId: '0x1', createdAt: null }, { keyId: '0x2', createdAt: null }] },
      { account: acct('a2', 84532, '0xbb'), ownerAddress: null, passkeys: [{ keyId: '0x2', createdAt: '2026-03-01T00:00:00.000Z' }] },
    ])
    const byKey = Object.fromEntries(out.map((s) => [s.kind === 'passkey' ? s.key_id : '', s]))
    expect(byKey['0x1']).toMatchObject({ created_at: null })
    expect(byKey['0x2']).toMatchObject({ created_at: '2026-03-01T00:00:00.000Z' })
  })

  it('orders passkeys by created_at asc (nulls last, key_id tie-break), then wallets by address', () => {
    const out = aggregateUserSigners([
      {
        account: acct('a1', 8453, '0xaa'),
        ownerAddress: '0xBBBB000000000000000000000000000000000002',
        passkeys: [
          { keyId: '0xf', createdAt: null },
          { keyId: '0xd', createdAt: '2026-01-01T00:00:00.000Z' },
          { keyId: '0xc', createdAt: '2026-01-01T00:00:00.000Z' },
          { keyId: '0xe', createdAt: '2025-12-01T00:00:00.000Z' },
        ],
      },
      { account: acct('a2', 84532, '0xbb'), ownerAddress: '0xaaaa000000000000000000000000000000000001', passkeys: [] },
    ])
    expect(out.map((s) => (s.kind === 'passkey' ? s.key_id : s.address))).toEqual([
      '0xe',
      '0xc',
      '0xd',
      '0xf',
      '0xaaaa000000000000000000000000000000000001',
      '0xbbbb000000000000000000000000000000000002',
    ])
  })

  it('dedupes a wallet owner by address case-insensitively and returns it lowercase', () => {
    const out = aggregateUserSigners([
      { account: acct('a1', 8453, '0xaa'), ownerAddress: '0xAbCd000000000000000000000000000000000001', passkeys: [] },
      { account: acct('a2', 84532, '0xbb'), ownerAddress: '0xabcd000000000000000000000000000000000001', passkeys: [] },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'wallet', address: '0xabcd000000000000000000000000000000000001' })
    expect(out[0].accounts).toHaveLength(2)
  })

  it('returns an empty list for no accounts', () => {
    expect(aggregateUserSigners([])).toEqual([])
  })
})

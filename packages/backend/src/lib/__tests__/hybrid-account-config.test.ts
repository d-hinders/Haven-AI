import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

const { loadHybridOwnerConfig, isPasskeyOnly } = await import('../hybrid-account-config.js')

const USER = 'user-1'
const SAFE = '0x' + 'ab'.repeat(20)

function mock(safe: { id: string; owner_address: string | null } | null, passkeys: Array<{ key_id: string; public_key_x: string; public_key_y: string }> = []) {
  mockQuery.mockImplementation((sql: string) => {
    if (/SELECT id, owner_address FROM user_safes/.test(String(sql))) {
      return Promise.resolve({ rows: safe ? [safe] : [] })
    }
    if (/FROM hybrid_account_passkeys/.test(String(sql))) {
      return Promise.resolve({ rows: passkeys })
    }
    return Promise.resolve({ rows: [] })
  })
}

beforeEach(() => mockQuery.mockReset())

describe('loadHybridOwnerConfig (#885)', () => {
  it('returns the EOA owner config when owner_address is set', async () => {
    mock({ id: 's1', owner_address: '0x' + 'ee'.repeat(20) })
    const res = await loadHybridOwnerConfig(USER, SAFE)
    expect(res?.config).toEqual({ ownerAddress: '0x' + 'ee'.repeat(20), passkeys: undefined })
    expect(res && isPasskeyOnly(res.config)).toBe(false)
  })

  it('rebuilds the passkey set (bigint coords) for a pure-passkey account', async () => {
    mock({ id: 's1', owner_address: null }, [
      { key_id: 'k1', public_key_x: '0x11', public_key_y: '0x22' },
      { key_id: 'k2', public_key_x: '0x33', public_key_y: '0x44' },
    ])
    const res = await loadHybridOwnerConfig(USER, SAFE)
    expect(res?.config.ownerAddress).toBeUndefined()
    expect(res?.config.passkeys).toEqual([
      { keyId: 'k1', x: 0x11n, y: 0x22n },
      { keyId: 'k2', x: 0x33n, y: 0x44n },
    ])
    expect(res && isPasskeyOnly(res.config)).toBe(true)
  })

  it('carries both an EOA owner and passkeys when present', async () => {
    mock({ id: 's1', owner_address: '0x' + 'ee'.repeat(20) }, [{ key_id: 'k1', public_key_x: '0x11', public_key_y: '0x22' }])
    const res = await loadHybridOwnerConfig(USER, SAFE)
    expect(res?.config.ownerAddress).toBe('0x' + 'ee'.repeat(20))
    expect(res?.config.passkeys).toHaveLength(1)
    expect(res && isPasskeyOnly(res.config)).toBe(false) // has an EOA owner
  })

  it('returns null for an unknown account', async () => {
    mock(null)
    expect(await loadHybridOwnerConfig(USER, SAFE)).toBeNull()
  })

  it('returns null when the account has NO signer at all (neither owner nor passkey)', async () => {
    mock({ id: 's1', owner_address: null }, [])
    expect(await loadHybridOwnerConfig(USER, SAFE)).toBeNull()
  })
})

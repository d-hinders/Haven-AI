import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

const { loadHybridOwnerConfig, isPasskeyOnly } = await import('../hybrid-account-config.js')

const USER = 'user-1'
const SAFE = '0x' + 'ab'.repeat(20)

function mock(
  safe: { id: string; owner_address: string | null; deploy_salt?: string } | null,
  passkeys: Array<{ key_id: string; public_key_x: string; public_key_y: string }> = [],
) {
  mockQuery.mockImplementation((sql: string) => {
    if (/SELECT id, owner_address, single_signer_waiver_at.*FROM smart_accounts/.test(String(sql))) {
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
    mock({ id: 's1', owner_address: '0x' + 'ee'.repeat(20), deploy_salt: '0x' })
    const res = await loadHybridOwnerConfig(USER, SAFE, 84532)
    // #4023: the config is salted; the row CARRIES the salt. A pre-#4023
    // account's stored salt IS the literal '0x' — the carrier never rewrites
    // an absent column into it (see the missing-column test below).
    expect(res?.config).toEqual({ ownerAddress: '0x' + 'ee'.repeat(20), passkeys: undefined, deploySalt: '0x' })
    expect(res && isPasskeyOnly(res.config)).toBe(false)
  })

  it('rebuilds the passkey set (bigint coords) for a pure-passkey account', async () => {
    mock({ id: 's1', owner_address: null, deploy_salt: '0x' }, [
      { key_id: 'k1', public_key_x: '0x11', public_key_y: '0x22' },
      { key_id: 'k2', public_key_x: '0x33', public_key_y: '0x44' },
    ])
    const res = await loadHybridOwnerConfig(USER, SAFE, 84532)
    expect(res?.config.ownerAddress).toBeUndefined()
    expect(res?.config.deploySalt).toBe('0x')
    expect(res?.config.passkeys).toEqual([
      { keyId: 'k1', x: 0x11n, y: 0x22n },
      { keyId: 'k2', x: 0x33n, y: 0x44n },
    ])
    expect(res && isPasskeyOnly(res.config)).toBe(true)
  })

  it('carries both an EOA owner and passkeys when present', async () => {
    mock({ id: 's1', owner_address: '0x' + 'ee'.repeat(20) }, [{ key_id: 'k1', public_key_x: '0x11', public_key_y: '0x22' }])
    const res = await loadHybridOwnerConfig(USER, SAFE, 84532)
    expect(res?.config.ownerAddress).toBe('0x' + 'ee'.repeat(20))
    expect(res?.config.passkeys).toHaveLength(1)
    expect(res && isPasskeyOnly(res.config)).toBe(false) // has an EOA owner
  })

  it('returns null for an unknown account', async () => {
    mock(null)
    expect(await loadHybridOwnerConfig(USER, SAFE, 84532)).toBeNull()
  })

  it('returns null when the account has NO signer at all (neither owner nor passkey)', async () => {
    mock({ id: 's1', owner_address: null, deploy_salt: '0x' }, [])
    expect(await loadHybridOwnerConfig(USER, SAFE, 84532)).toBeNull()
  })

  it('NEVER answers the salt-0 default for a row missing deploy_salt (drifted SELECT / lying row type)', async () => {
    // #4023 design rule: "Never `salt ?? '0x'`". The carrier must not rewrite
    // an absent column into '0x': a drifted SELECT or a lying row type would
    // otherwise SILENTLY derive the salt-0 account — the relayer-spend-on-
    // wrong-account bug #4023 closes. The absent salt must surface as
    // undefined and fail loudly at the derivation consumer instead.
    mock({ id: 's1', owner_address: '0x' + 'ee'.repeat(20) } as never)
    const res = await loadHybridOwnerConfig(USER, SAFE, 84532)
    expect(res?.config.deploySalt).toBeUndefined()
    // normalizeDeploySalt (viem `pad`) throws on the missing salt — a loud
    // failure, never a silent salt-0 derivation.
    const { normalizeDeploySalt } = await import('../hybrid-provisioning.js')
    expect(() => normalizeDeploySalt(res?.config.deploySalt as never)).toThrow()
  })
})

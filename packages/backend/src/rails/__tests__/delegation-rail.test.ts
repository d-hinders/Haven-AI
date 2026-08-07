import { afterEach, describe, expect, it } from 'vitest'
import { watchOnlyDelegateOwner, delegationRailBundlerUrl } from '../delegation-rail.js'

const DELEGATE = ('0x' + '11'.repeat(20)) as `0x${string}`

afterEach(() => {
  delete process.env.DELEGATION_RAIL_BUNDLER_URL
  delete process.env.SESSION_RAIL_BUNDLER_URL
})

describe('watchOnlyDelegateOwner — non-custody (#824 invariant 5)', () => {
  it('refuses every signing operation, loudly', async () => {
    const owner = watchOnlyDelegateOwner(DELEGATE)
    await expect(owner.signMessage({ message: 'x' })).rejects.toThrow(/non-custody/)
    await expect(
      owner.signTypedData({ domain: {}, types: {}, primaryType: 'X', message: {} } as never),
    ).rejects.toThrow(/non-custody/)
    expect(owner.address).toBe(DELEGATE)
  })
})

describe('delegationRailBundlerUrl — one credential choke point (#824 invariant 9)', () => {
  it('fails closed when no credential is configured', () => {
    expect(() => delegationRailBundlerUrl(84532)).toThrow(/not configured/)
  })

  it('reads the dedicated var only — the session-rail fallback is retired (#882)', () => {
    // The legacy var is no longer consulted, even if present.
    process.env.SESSION_RAIL_BUNDLER_URL = 'https://bundler.example/session?apikey=s'
    expect(() => delegationRailBundlerUrl(84532)).toThrow(/not configured/)
    process.env.DELEGATION_RAIL_BUNDLER_URL = 'https://bundler.example/delegation?apikey=d'
    expect(delegationRailBundlerUrl(84532)).toContain('delegation')
  })

  it('fails closed on a chain without pinned contracts', () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL = 'https://bundler.example/x?apikey=d'
    expect(() => delegationRailBundlerUrl(1)).toThrow(/not enabled/)
  })
})

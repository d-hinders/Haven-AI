import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  watchOnlyDelegateOwner,
  delegationRailBundlerUrl,
  readDisabledDelegationHashes,
} from '../delegation-rail.js'

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

describe('readDisabledDelegationHashes — double-confirmed heals (#1423)', () => {
  // A positive read leads to marking a row revoked WITHOUT an owner
  // signature; these pin the confirmation semantics that guard the kill
  // switch against a single wrong answer.
  const H1 = ('0x' + 'ab'.repeat(32)) as `0x${string}`
  const H2 = ('0x' + 'cd'.repeat(32)) as `0x${string}`

  it('a hash counts as disabled only when TWO consecutive reads agree', async () => {
    const answers = new Map<string, boolean[]>([
      [H1, [true, true]], // genuinely disabled
      [H2, [true, false]], // transient glitch: first read lies, second corrects
    ])
    const readFlag = vi.fn(async (hash: `0x${string}`) => answers.get(hash)!.shift()!)
    const disabled = await readDisabledDelegationHashes(84532, 'http://unused', [H1, H2], readFlag)
    expect([...disabled]).toEqual([H1])
    // H2's flip-flop cost a confirmation read but confirmed nothing.
    expect(readFlag).toHaveBeenCalledTimes(4)
  })

  it('all-negative first pass never issues a confirmation round', async () => {
    const readFlag = vi.fn(async () => false)
    const disabled = await readDisabledDelegationHashes(84532, 'http://unused', [H1, H2], readFlag)
    expect(disabled.size).toBe(0)
    expect(readFlag).toHaveBeenCalledTimes(2)
  })

  it('an empty hash list reads nothing', async () => {
    const readFlag = vi.fn()
    expect((await readDisabledDelegationHashes(84532, 'http://unused', [], readFlag)).size).toBe(0)
    expect(readFlag).not.toHaveBeenCalled()
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

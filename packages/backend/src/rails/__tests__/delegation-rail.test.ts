import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  watchOnlyDelegateOwner,
  delegationRailBundlerUrl,
  readDisabledDelegationHashes,
  DelegationRailChainUnavailableError,
  railUnavailableRefusalBody,
} from '../delegation-rail.js'

const DELEGATE = ('0x' + '11'.repeat(20)) as `0x${string}`

afterEach(() => {
  delete process.env.DELEGATION_RAIL_BUNDLER_URL
  delete process.env.DELEGATION_RAIL_BUNDLER_URL_84532
  delete process.env.DELEGATION_RAIL_BUNDLER_URL_8453
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
    const disabled = await readDisabledDelegationHashes(84532, [H1, H2], readFlag)
    expect([...disabled]).toEqual([H1])
    // H2's flip-flop cost a confirmation read but confirmed nothing.
    expect(readFlag).toHaveBeenCalledTimes(4)
  })

  it('all-negative first pass never issues a confirmation round', async () => {
    const readFlag = vi.fn(async () => false)
    const disabled = await readDisabledDelegationHashes(84532, [H1, H2], readFlag)
    expect(disabled.size).toBe(0)
    expect(readFlag).toHaveBeenCalledTimes(2)
  })

  it('an empty hash list reads nothing', async () => {
    const readFlag = vi.fn()
    expect((await readDisabledDelegationHashes(84532, [], readFlag)).size).toBe(0)
    expect(readFlag).not.toHaveBeenCalled()
  })
})

describe('delegationRailBundlerUrl — one credential choke point (#824 invariant 9)', () => {
  it('fails closed when no credential is configured', () => {
    expect(() => delegationRailBundlerUrl(84532)).toThrow(/not configured/)
  })

  it('reads the dedicated var only (#882)', () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL = 'https://bundler.example/delegation?apikey=d'
    expect(delegationRailBundlerUrl(84532)).toContain('delegation')
  })

  it('fails closed on a chain without pinned contracts', () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL = 'https://bundler.example/x?apikey=d'
    expect(() => delegationRailBundlerUrl(1)).toThrow(/not enabled/)
  })
})

/**
 * #3416: both chains are enabled on every deployment, but a bundler URL is
 * chain-scoped by its path. With one unsuffixed variable, prod (mainnet key)
 * could never serve a Base Sepolia bundler leg: every EIP-3009 funding leg,
 * `/payments` and task budget there failed with a generic 502. The credential
 * now resolves per chain, with the unsuffixed variable as the fallback.
 */
describe('delegationRailBundlerUrl — a credential per chain (#3416)', () => {
  const MAINNET = 'https://api.pimlico.io/v2/8453/rpc?apikey=main-secret'
  const SEPOLIA = 'https://api.pimlico.io/v2/84532/rpc?apikey=sepolia-secret'

  it('serves the second chain from its own variable while the fallback serves the first (the prod shape)', () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL = MAINNET
    process.env.DELEGATION_RAIL_BUNDLER_URL_84532 = SEPOLIA
    expect(delegationRailBundlerUrl(8453)).toBe(MAINNET)
    expect(delegationRailBundlerUrl(84532)).toBe(SEPOLIA)
  })

  it('prefers the per-chain variable over the fallback for the same chain', () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL = 'https://api.pimlico.io/v2/84532/rpc?apikey=old'
    process.env.DELEGATION_RAIL_BUNDLER_URL_84532 = SEPOLIA
    expect(delegationRailBundlerUrl(84532)).toBe(SEPOLIA)
  })

  it('without a per-chain variable, the fallback still serves its own chain (every environment today)', () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL = SEPOLIA
    expect(delegationRailBundlerUrl(84532)).toBe(SEPOLIA)
  })

  it('the fallback naming another chain is a typed chain-unavailable error that names the variable to set', () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL = MAINNET
    let err: unknown
    try {
      delegationRailBundlerUrl(84532)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DelegationRailChainUnavailableError)
    expect((err as DelegationRailChainUnavailableError).chainId).toBe(84532)
    expect((err as Error).message).toMatch(/DELEGATION_RAIL_BUNDLER_URL_84532/)
    expect((err as Error).message).not.toContain('main-secret')
  })

  it('a per-chain variable holding another chain\'s URL is refused, not used', () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL_8453 = SEPOLIA
    expect(() => delegationRailBundlerUrl(8453)).toThrow(DelegationRailChainUnavailableError)
    expect(() => delegationRailBundlerUrl(8453)).toThrow(/DELEGATION_RAIL_BUNDLER_URL_8453 targets a different chain/)
  })

  it('no credential at all is the same typed error (a configuration state, not a transient failure)', () => {
    expect(() => delegationRailBundlerUrl(84532)).toThrow(DelegationRailChainUnavailableError)
  })

  it('the refusal body is machine-readable and never carries the URL', () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL = MAINNET
    let body: ReturnType<typeof railUnavailableRefusalBody> | undefined
    try {
      delegationRailBundlerUrl(84532)
    } catch (e) {
      body = railUnavailableRefusalBody(e as DelegationRailChainUnavailableError)
    }
    expect(body).toMatchObject({ error_code: 'rail_unavailable_for_chain', chain_id: 84532 })
    expect(JSON.stringify(body)).not.toContain('main-secret')
    expect(JSON.stringify(body)).not.toContain('pimlico.io')
  })
})

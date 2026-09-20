/**
 * The marketplace's three scoping questions (#3078) against a mutable
 * config: which chains a non-agent read sees, whether a mainnet is listed,
 * and who may see prospects. Every branch of the gate is pinned, and the
 * fallbacks are asserted in order — marketplace list, deploy list, every
 * chain — because "unset → zero rows" is the accident the fallbacks exist
 * to prevent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { config } from '../../../config.js'
import { isMainnetChain, marketplaceChainIds, marketplaceListsMainnet, marketplaceListsTestnetExplicitly, prospectsVisibleTo } from '../marketplace-scope.js'

const original = {
  marketplaceChainIds: config.marketplaceChainIds,
  deployChainIds: config.deployChainIds,
  marketplaceProspectsEnabled: config.marketplaceProspectsEnabled,
}

function setConfig(over: Partial<typeof original>): void {
  Object.assign(config, over)
}

function request(over: { user?: unknown; agent?: unknown } = {}): FastifyRequest {
  return { user: over.user, agent: over.agent } as unknown as FastifyRequest
}

afterEach(() => {
  setConfig(original)
  vi.restoreAllMocks()
})

describe('marketplaceChainIds', () => {
  it('prefers the marketplace list, then the deploy list, then every chain', () => {
    setConfig({ marketplaceChainIds: [8453], deployChainIds: [84532] })
    expect(marketplaceChainIds()).toEqual([8453])
    setConfig({ marketplaceChainIds: [], deployChainIds: [84532] })
    expect(marketplaceChainIds()).toEqual([84532])
    setConfig({ marketplaceChainIds: [], deployChainIds: [] })
    expect(marketplaceChainIds()).toBeNull()
  })
})

describe('isMainnetChain / marketplaceListsMainnet', () => {
  it('knows Base from Base Sepolia, and treats an unknown chain as mainnet (fail closed)', () => {
    expect(isMainnetChain(8453)).toBe(true)
    expect(isMainnetChain(84532)).toBe(false)
    expect(isMainnetChain(999999)).toBe(true)
  })

  it('lists a mainnet when any listed chain is one, or when every chain is listed', () => {
    setConfig({ marketplaceChainIds: [84532], deployChainIds: [] })
    expect(marketplaceListsMainnet()).toBe(false)
    setConfig({ marketplaceChainIds: [84532, 8453], deployChainIds: [] })
    expect(marketplaceListsMainnet()).toBe(true)
    setConfig({ marketplaceChainIds: [], deployChainIds: [] })
    expect(marketplaceListsMainnet()).toBe(true)
  })
})

describe('prospectsVisibleTo', () => {
  it('shows prospects only to a dashboard user, with the flag on, when the explicit list names a testnet', () => {
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [84532], deployChainIds: [] })
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(true)
    // Not to an agent — even one a middleware also left a `user` on (no
    // door does today; the guard is defence in depth and this fixture has
    // BOTH set so the agent check is the thing under test).
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' }, agent: { id: 'a1', chain_id: 84532 } }))).toBe(false)
    // Not to a credential-less read.
    expect(prospectsVisibleTo(request())).toBe(false)
  })

  it('hides prospects when the flag is off', () => {
    setConfig({ marketplaceProspectsEnabled: false, marketplaceChainIds: [84532], deployChainIds: [] })
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(false)
  })

  it('shows prospects BESIDE the mainnet merchants — dev lists 84532,8453 standing (decision 14)', () => {
    // Decision 11 (mainnet merchants on dev) and decision 9 (prospects on dev)
    // no longer exclude each other. Mutation: gate on "no mainnet listed"
    // again → this goes red.
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [84532, 8453], deployChainIds: [] })
    expect(marketplaceListsMainnet()).toBe(true)
    expect(marketplaceListsTestnetExplicitly()).toBe(true)
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(true)
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' }, agent: { id: 'a1', chain_id: 84532 } }))).toBe(false)
    expect(prospectsVisibleTo(request())).toBe(false)
  })

  it('hides prospects on a mainnet-only explicit list — prod lists 8453, so a copied flag cannot publish them', () => {
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [8453], deployChainIds: [] })
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(false)
    // An UNREGISTERED id is not a testnet (isMainnetChain fails closed), so it
    // cannot open the gate either. Mutation: `some((id) => id !== 8453)` → red.
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [8453, 999999], deployChainIds: [] })
    expect(marketplaceListsTestnetExplicitly()).toBe(false)
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(false)
  })

  it('the fallback list never opens the door: prod deploys 8453,84532, so an UNSET marketplace list must not count', () => {
    // Mutation: read `marketplaceChainIds()` (fallback included) instead of
    // the explicit config in `marketplaceListsTestnetExplicitly` → red.
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [], deployChainIds: [8453, 84532] })
    expect(marketplaceListsTestnetExplicitly()).toBe(false)
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(false)
    // Both unset ("every chain") is not an explicit testnet either.
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [], deployChainIds: [] })
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(false)
  })
})

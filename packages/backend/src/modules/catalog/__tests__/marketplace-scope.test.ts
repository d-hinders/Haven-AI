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
import { isMainnetChain, marketplaceChainIds, marketplaceListsMainnet, prospectsVisibleTo } from '../marketplace-scope.js'

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
  it('shows prospects only to a dashboard user, with the flag on, on a testnet-only list', () => {
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [84532], deployChainIds: [] })
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(true)
    // Not to an agent, even an authenticated one.
    expect(prospectsVisibleTo(request({ agent: { id: 'a1', chain_id: 84532 } }))).toBe(false)
    // Not to a credential-less read.
    expect(prospectsVisibleTo(request())).toBe(false)
  })

  it('hides prospects when the flag is off', () => {
    setConfig({ marketplaceProspectsEnabled: false, marketplaceChainIds: [84532], deployChainIds: [] })
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(false)
  })

  it('hides prospects when a mainnet chain is listed — a copied env cannot publish them on prod', () => {
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [8453], deployChainIds: [] })
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(false)
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [], deployChainIds: [8453, 84532] })
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(false)
    // Both unset lists every chain, mainnet included.
    setConfig({ marketplaceProspectsEnabled: true, marketplaceChainIds: [], deployChainIds: [] })
    expect(prospectsVisibleTo(request({ user: { sub: 'u1' } }))).toBe(false)
  })
})

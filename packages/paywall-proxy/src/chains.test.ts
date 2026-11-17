import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROXY_CHAINS, chainForNetwork } from './chains.js'

const coreChains = readFileSync(fileURLToPath(new URL('../../core/src/chains.ts', import.meta.url)), 'utf8')

describe('proxy chain table', () => {
  it('names exactly Base and Base Sepolia, and no default', () => {
    expect(Object.keys(PROXY_CHAINS).sort()).toEqual(['eip155:8453', 'eip155:84532'])
    expect(chainForNetwork('')).toBeUndefined()
    expect(chainForNetwork('eip155:100')).toBeUndefined()
    expect(chainForNetwork('__proto__')).toBeUndefined()
  })

  it.each(Object.values(PROXY_CHAINS))('pins $network to the facts in packages/core/src/chains.ts', (chain) => {
    // The chain's block in core's registry, from its chainId line to the next chain.
    const start = coreChains.indexOf(`chainId: ${chain.chainId},`)
    expect(start).toBeGreaterThan(-1)
    const block = coreChains.slice(start, start + 2500)
    expect(block).toContain(chain.usdcAddress)
    expect(chain.network).toBe(`eip155:${chain.chainId}`)
  })
})

/**
 * #3670 (epic #3634): chain 100 stays in the KNOWN registry (history renders)
 * but is not OFFERED. Importing the module also proves `buildFrontendChain(100)`
 * still loads from core's registry (#3671 must keep that shape loadable).
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_CHAINS,
  SUPPORTED_CHAINS,
  SUPPORTED_CHAIN_IDS,
  getExplorerUrlOrNull,
  resolveChainOrNull,
} from '@/lib/chains'

describe('known vs offered chains', () => {
  it('ALL_CHAINS includes Gnosis (100)', () => {
    expect(ALL_CHAINS.map((c) => c.chainId)).toContain(100)
  })

  it('SUPPORTED_CHAINS and SUPPORTED_CHAIN_IDS do not', () => {
    expect(SUPPORTED_CHAINS.map((c) => c.chainId)).not.toContain(100)
    expect(SUPPORTED_CHAIN_IDS).not.toContain(100)
    expect(SUPPORTED_CHAIN_IDS).toEqual([8453, 84532])
  })

  it('resolves chain 100 for history but returns null for an unknown chain', () => {
    expect(resolveChainOrNull(100)?.chainId).toBe(100)
    expect(resolveChainOrNull(999999)).toBeNull()
    expect(getExplorerUrlOrNull(100, 'tx', '0x1')).toMatch(/\/tx\/0x1$/)
    expect(getExplorerUrlOrNull(999999, 'tx', '0x1')).toBeNull()
  })
})

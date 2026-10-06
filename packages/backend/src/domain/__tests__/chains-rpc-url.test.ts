import { describe, expect, it } from 'vitest'
import { config } from '../../config.js'
import { getChain, isKnownChain, rpcUrlForChain } from '../chains.js'

/**
 * #3671 (decision (c) of #3635): the known chain shape carries no RPC URL.
 * RPC is resolvable only through `rpcUrlForChain`, and only for SUPPORTED
 * chains, so a history-only chain (Gnosis, 100) cannot open a connection.
 */
describe('rpcUrlForChain (#3671)', () => {
  it('returns the configured URL for each supported chain', () => {
    expect(rpcUrlForChain(8453)).toBe(config.rpcUrlBase)
    expect(rpcUrlForChain(84532)).toBe(config.rpcUrlBaseSepolia)
  })

  it('refuses Gnosis (known, history-only) and an unknown chain', () => {
    expect(() => rpcUrlForChain(100)).toThrow('Unsupported chain for RPC: 100')
    expect(() => rpcUrlForChain(999999)).toThrow('Unsupported chain for RPC: 999999')
  })

  it('keeps chain 100 known for history, with no rpcUrl property on any chain', () => {
    expect(isKnownChain(100)).toBe(true)
    expect(getChain(100).name).toBe('Gnosis Chain')
    for (const id of [100, 8453, 84532]) {
      expect(Object.prototype.hasOwnProperty.call(getChain(id), 'rpcUrl')).toBe(false)
    }
    // The history read keeps its explorer wiring.
    expect(getChain(100).explorerApiProvider).toBe('etherscan-v2')
  })
})

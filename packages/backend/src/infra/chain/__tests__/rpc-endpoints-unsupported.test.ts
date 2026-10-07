import { describe, expect, it } from 'vitest'
import { config } from '../../../config.js'
import { rpcEndpoints } from '../rpc-transport.js'

// #3671 — against the REAL domain/chains (rpc-transport.test.ts mocks it): a
// history-only or unknown chain has no endpoint list, and a supported one is
// unchanged.
describe('rpcEndpoints — supported chains only (#3671)', () => {
  it('refuses Gnosis (100, known but history-only) and an unknown chain', () => {
    expect(() => rpcEndpoints(100)).toThrow('Unsupported chain for RPC: 100')
    expect(() => rpcEndpoints(999999)).toThrow('Unsupported chain for RPC: 999999')
  })

  it('leads Base with its configured dedicated endpoint', () => {
    expect(rpcEndpoints(8453)[0]).toBe(config.rpcUrlBase)
    expect(rpcEndpoints(84532)[0]).toBe(config.rpcUrlBaseSepolia)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'

// Set the global relayer key before importing config (read at import time), so
// the fallback path has a deterministic value.
process.env.RELAYER_PRIVATE_KEY = '0xglobalkey'
const { relayerPrivateKeyForChain } = await import('../config.js')

describe('relayerPrivateKeyForChain (#640)', () => {
  beforeEach(() => {
    delete process.env.RELAYER_PRIVATE_KEY_84532
    delete process.env.RELAYER_PRIVATE_KEY_8453
  })

  it('falls back to the global relayer key when no per-chain override is set', () => {
    expect(relayerPrivateKeyForChain(8453)).toBe('0xglobalkey')
    expect(relayerPrivateKeyForChain(84532)).toBe('0xglobalkey')
  })

  it('uses a per-chain override and keeps other chains on the global key', () => {
    process.env.RELAYER_PRIVATE_KEY_84532 = '0xtestnetkey'
    // Base Sepolia uses its dedicated, isolated key…
    expect(relayerPrivateKeyForChain(84532)).toBe('0xtestnetkey')
    // …while Base mainnet stays on the global key — a leaked testnet key can't
    // touch the mainnet relayer.
    expect(relayerPrivateKeyForChain(8453)).toBe('0xglobalkey')
  })
})

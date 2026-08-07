import { describe, it, expect } from 'vitest'
import { Wallet } from 'ethers'

// Two distinct throwaway keys, set before importing the module (the relayer
// caches per chainId and the global key is read at config-import time).
const GLOBAL_KEY = '0x' + '11'.repeat(32)
const SEPOLIA_KEY = '0x' + '22'.repeat(32)

process.env.RELAYER_PRIVATE_KEY = GLOBAL_KEY
process.env.RELAYER_PRIVATE_KEY_84532 = SEPOLIA_KEY

const { getRelayer } = await import('../relayer.js')

describe('getRelayer — per-chain key (#640 deploy/exec path)', () => {
  it('uses the per-chain key for Base Sepolia and the global key for Base mainnet', () => {
    // Base Sepolia deploy/exec is submitted by its dedicated, isolated relayer…
    expect(getRelayer(84532).address).toBe(new Wallet(SEPOLIA_KEY).address)
    // …while Base mainnet stays on the global relayer key.
    expect(getRelayer(8453).address).toBe(new Wallet(GLOBAL_KEY).address)
    // The two are genuinely different wallets (isolation holds).
    expect(getRelayer(84532).address).not.toBe(getRelayer(8453).address)
  })
})

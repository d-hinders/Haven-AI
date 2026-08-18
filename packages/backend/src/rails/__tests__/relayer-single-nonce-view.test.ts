/**
 * #1533 — ONE nonce view per chain for the relayer EOA.
 *
 * `rails/allowance-module.ts` and `infra/relayer.ts` each kept their own
 * per-chain `Map` of providers and wallets, built from the same key. Both
 * submissions went through the shared `withRelayerSendLock`, so they never
 * raced each other's broadcast — but ethers populates a transaction's nonce
 * from the provider its signing wallet is bound to, and two providers only
 * observe their own traffic. On 2026-08-18 the wallet bound to the
 * less-trafficked provider submitted nonce 775 while the chain was at 781
 * (`x402-settle`, run 32097250393); the on-chain sequence 780→781→782 was
 * strictly sequential, proving the stale view was process-local.
 *
 * The invariant is IDENTITY, not equivalence: both modules must hand back
 * the same instances, so there is exactly one place a nonce can be read
 * from. Reintroducing either module-local Map fails these assertions.
 */
import { describe, it, expect, beforeAll } from 'vitest'

// A throwaway key (hardhat #0) — set BEFORE the modules read config. Never a
// real key: nothing here touches the network; providers are lazy until used.
beforeAll(() => {
  process.env.RELAYER_PRIVATE_KEY ??=
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
})

const CHAIN_ID = 84532

describe('#1533 — single relayer nonce view', () => {
  it('allowance-module and infra/relayer share ONE wallet instance per chain', async () => {
    const { getRelayerWallet } = await import('../allowance-module.js')
    const { getRelayer } = await import('../../infra/relayer.js')
    expect(getRelayerWallet(CHAIN_ID)).toBe(getRelayer(CHAIN_ID))
  })

  it('and ONE provider instance, which is the one the wallet is bound to', async () => {
    const { getProvider: fromAllowance } = await import('../allowance-module.js')
    const { getProvider: fromRelayer, getRelayer } = await import('../../infra/relayer.js')
    expect(fromAllowance(CHAIN_ID)).toBe(fromRelayer(CHAIN_ID))
    // The binding is the point: the nonce is read from wallet.provider.
    expect(getRelayer(CHAIN_ID).provider).toBe(fromRelayer(CHAIN_ID))
  })

  it('per-chain isolation survives the delegation (#640)', async () => {
    const { getProvider } = await import('../allowance-module.js')
    expect(getProvider(84532)).not.toBe(getProvider(8453))
  })
})

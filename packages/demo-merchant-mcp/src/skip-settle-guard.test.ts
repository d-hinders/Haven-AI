/**
 * The MERCHANT_SKIP_SETTLE_PRODUCT chain guard: the verify-without-settle QA
 * hook (#603) hands out goods against a merely well-FORMED authorization — no
 * settlement, and the only balance check lives inside the settlement call it
 * skips. A copy-pasted env var must not be able to enable that on mainnet.
 * Module-load guard, so each case re-imports x402.ts fresh under stubbed env.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.restoreAllMocks()
})

async function importX402With(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('./x402.js')
}

describe('MERCHANT_SKIP_SETTLE_PRODUCT chain guard', () => {
  // Each case does a fresh `vi.resetModules()` + dynamic import of x402.ts
  // (and its transitive graph), which is consistently the slowest thing in
  // this package's suite and — as the full-package `npx vitest run` count
  // grows — flakes past the 5s default under collection-time load rather
  // than any actual regression. Give this module-reimport guard real headroom.
  it('refuses to start on mainnet with the flag set', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit called')
      }) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      importX402With({ MERCHANT_CHAIN_ID: '8453', MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic' }),
    ).rejects.toThrow('process.exit called')
    expect(exit).toHaveBeenCalledWith(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('testnet-only')
  }, 15000)

  it('starts on Base Sepolia with the flag set', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
    const mod = await importX402With({
      MERCHANT_CHAIN_ID: '84532',
      MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic',
    })
    expect(mod.createX402PaymentProcessor).toBeTypeOf('function')
    expect(exit).not.toHaveBeenCalled()
  }, 15000)

  it('starts on mainnet when the flag is unset', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
    const mod = await importX402With({ MERCHANT_CHAIN_ID: '8453' })
    expect(mod.createX402PaymentProcessor).toBeTypeOf('function')
    expect(exit).not.toHaveBeenCalled()
  }, 15000)
})

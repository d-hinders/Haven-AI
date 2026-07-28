/**
 * `DEFAULT_CHAIN_ID` (#990) — the value, not just the wiring.
 *
 * This constant replaced a bare `8453` restated across ~8 backend call sites,
 * two of which are money-path files (`routes/x402-resources.ts`,
 * `routes/machine-payments.ts`). The refactor is only safe if the constant
 * equals the literal it replaced, so that is asserted directly rather than
 * inferred from the call sites compiling.
 *
 * The test also exists to make the constant HARDER to change than the literals
 * were, which is the point people usually get backwards about this kind of
 * hoist. Before, moving the default meant editing every site and confronting
 * each one in review. Now one character here would silently move where every
 * new Safe, payment intent and approval request lands. Pinning the value means
 * such a change breaks a test and has to be argued for.
 */

import { describe, it, expect } from 'vitest'
import { DEFAULT_CHAIN_ID, CHAIN_REGISTRY, getChainData } from './chains.js'

describe('DEFAULT_CHAIN_ID (#990)', () => {
  it('is Base mainnet, the value the call sites used before the hoist', () => {
    // Changing this moves the default network for new records on the money
    // path. It is not a config tweak — see the constant's docstring, and note
    // that migration 034 set the DB column defaults to this same value.
    expect(DEFAULT_CHAIN_ID).toBe(8453)
  })

  it('names a chain the registry actually knows', () => {
    // A default pointing at an unregistered chain would throw at the first
    // `getChainData` rather than at startup — a guard the literals never had.
    expect(CHAIN_REGISTRY[DEFAULT_CHAIN_ID]).toBeDefined()
    expect(() => getChainData(DEFAULT_CHAIN_ID)).not.toThrow()
    expect(getChainData(DEFAULT_CHAIN_ID).chainId).toBe(DEFAULT_CHAIN_ID)
  })

  it('is not Gnosis — the drift CLAUDE.md used to flag', () => {
    // Kept as its own case with its own reason. The first assertion would also
    // catch this, but the failure message matters: "expected 8453" reads as a
    // typo, while this one names what regressed.
    expect(DEFAULT_CHAIN_ID).not.toBe(100)
  })
})

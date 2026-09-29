/**
 * `DEFAULT_CHAIN_ID` (#990) — the value, not just the wiring.
 *
 * This constant replaced a bare `8453` restated across ten backend sites —
 * five route defaults, plus five SQL `COALESCE(..., 8453)` fallbacks that the
 * first pass missed. One of those, `middleware/agentAuth.ts`, is money-path:
 * it sets `agent.chain_id`, which `routes/machine-payments.ts` then reads
 * throughout. (An earlier version of this comment said machine-payments.ts was
 * itself edited. It was not — corrected rather than left as the next inherited
 * false claim.) The refactor is only safe if the constant equals the literal it
 * replaced, so that is asserted directly rather than inferred from the call
 * sites compiling.
 *
 * The test also exists to make the constant HARDER to change than the literals
 * were, which is the point people usually get backwards about this kind of
 * hoist. Before, moving the default meant editing every site and confronting
 * each one in review. Now one character here would silently move where every
 * new Safe, payment intent and approval request lands. Pinning the value means
 * such a change breaks a test and has to be argued for.
 */

import { describe, it, expect } from 'vitest'
import { DEFAULT_CHAIN_ID, CHAIN_REGISTRY, getChainData, effectiveDefaultChainId } from './chains.js'

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

describe('effectiveDefaultChainId (#3431)', () => {
  it('production: DEFAULT_CHAIN_ID is deployable, so the value is unchanged at 8453', () => {
    // Production's shape, pinned directly rather than through a fixture that
    // could silently drift from what production actually serves.
    expect(effectiveDefaultChainId([8453, 84532])).toBe(8453)
  })

  it('DEFAULT_CHAIN_ID first in the deployable list is still fine', () => {
    expect(effectiveDefaultChainId([8453])).toBe(8453)
  })

  it('a deployment whose deployable list excludes DEFAULT_CHAIN_ID reports a default that IS deployable', () => {
    // Dev's shape: Base Sepolia only. This is the funding-step trap #3431
    // found — the fixture is the one a bad fix would still fail on.
    expect(effectiveDefaultChainId([84532])).toBe(84532)
    expect([84532]).toContain(effectiveDefaultChainId([84532]))
  })

  it('falls back to the first deployable chain, not always the same one', () => {
    // Order matters: this is "the first chain it does deploy on", not "the
    // lowest id" or "the last". A hard-coded 84532 here would pass the case
    // above and fail this one.
    expect(effectiveDefaultChainId([100, 84532])).toBe(100)
  })

  it('an empty deployable list — a misconfigured HAVEN_DEPLOY_CHAIN_IDS — falls back to DEFAULT_CHAIN_ID', () => {
    expect(effectiveDefaultChainId([])).toBe(DEFAULT_CHAIN_ID)
  })
})

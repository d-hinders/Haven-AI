/**
 * #1455 — the pinned enforcer addresses must keep meaning what they say.
 *
 * `settlement-child.ts` hardcodes the DelegationManager and the caveat
 * enforcers rather than reading them from Haven, because a verifier that lets
 * the thing it verifies choose the yardstick verifies nothing. The cost of
 * pinning is drift, and this is what pays it: the constants are cross-checked
 * against the kit's own environment, for every chain Haven settles on.
 *
 * The kit is a devDependency here on purpose — it must not ship in a package
 * that installs on users' machines.
 */
import { describe, expect, it } from 'vitest'
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit'
import { CAVEAT_ENFORCERS, DELEGATION_MANAGER } from './settlement-child.js'

const CHAINS = [
  { id: 8453, name: 'Base' },
  { id: 84532, name: 'Base Sepolia' },
]

describe('pinned delegation addresses (#1455)', () => {
  for (const chain of CHAINS) {
    it(`matches the kit's environment on ${chain.name}`, () => {
      const env = getSmartAccountsEnvironment(chain.id) as unknown as {
        DelegationManager: string
        caveatEnforcers: Record<string, string>
      }
      const lower = (v: string) => v.toLowerCase()

      expect(lower(env.DelegationManager)).toBe(lower(DELEGATION_MANAGER))
      expect(lower(env.caveatEnforcers.ERC20TransferAmountEnforcer)).toBe(
        lower(CAVEAT_ENFORCERS.erc20TransferAmount),
      )
      expect(lower(env.caveatEnforcers.AllowedCalldataEnforcer)).toBe(
        lower(CAVEAT_ENFORCERS.allowedCalldata),
      )
      expect(lower(env.caveatEnforcers.TimestampEnforcer)).toBe(lower(CAVEAT_ENFORCERS.timestamp))
      expect(lower(env.caveatEnforcers.RedeemerEnforcer)).toBe(lower(CAVEAT_ENFORCERS.redeemer))
    })
  }

  it('keeps the kit OUT of the shipped dependency set', () => {
    // The reason the constants are pinned at all. If this ever fails, the
    // trade-off was reversed without the reasoning being revisited.
    const pkg = require('../package.json') as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.['@metamask/smart-accounts-kit']).toBeUndefined()
  })
})

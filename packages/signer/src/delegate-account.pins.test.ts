/**
 * #3272 — the vendored counterfactual-address derivation must keep computing
 * what the kit computes. Same pattern as `settlement-child.pins.test.ts`: the
 * kit is a devDependency only, cross-checked here, never imported at runtime
 * by `delegate-account.ts`.
 */
import { describe, expect, it } from 'vitest'
import { getCounterfactualAccountData } from '@metamask/smart-accounts-kit/utils'
import { getSmartAccountsEnvironment, Implementation } from '@metamask/smart-accounts-kit'
import directPaymentUserOp from '../../sdk/src/__fixtures__/direct-payment-userop.json' with { type: 'json' }
import {
  deriveDelegateAccountAddress,
  HYBRID_DELEGATOR_IMPLEMENTATION,
  SIMPLE_FACTORY_ADDRESS,
} from './delegate-account.js'

const CHAINS = [
  { id: 8453, name: 'Base' },
  { id: 84532, name: 'Base Sepolia' },
]

const TEST_OWNERS: `0x${string}`[] = [
  '0x2b2e66489c4BEdE4D510CD1A3062Ea45Edc8AAC9',
  '0x1234567890123456789012345678901234567890',
]

describe('deriveDelegateAccountAddress (#3272)', () => {
  it('matches the kit environment addresses on both pinned chains', () => {
    for (const chain of CHAINS) {
      const env = getSmartAccountsEnvironment(chain.id) as unknown as {
        SimpleFactory: string
        implementations: { HybridDeleGatorImpl: string }
      }
      expect(env.SimpleFactory.toLowerCase()).toBe(SIMPLE_FACTORY_ADDRESS.toLowerCase())
      expect(env.implementations.HybridDeleGatorImpl.toLowerCase()).toBe(
        HYBRID_DELEGATOR_IMPLEMENTATION.toLowerCase(),
      )
    }
  })

  for (const chain of CHAINS) {
    for (const owner of TEST_OWNERS) {
      it(`matches the kit's getCounterfactualAccountData for ${owner} on ${chain.name}`, async () => {
        const env = getSmartAccountsEnvironment(chain.id) as unknown as {
          SimpleFactory: `0x${string}`
          implementations: Record<string, `0x${string}`>
        }
        const fromKit = await getCounterfactualAccountData({
          factory: env.SimpleFactory,
          implementations: env.implementations,
          implementation: Implementation.Hybrid,
          deployParams: [owner, [], [], []],
          deploySalt: '0x',
        })
        const derived = deriveDelegateAccountAddress(owner)
        expect(derived.toLowerCase()).toBe((fromKit as { address: string }).address.toLowerCase())
      })
    }
  }

  it('matches the REAL fixture (direct-payment-userop.json): the recoverable owner derives its own sender', () => {
    // #3272: `delegate_address` in the fixture is the agent's delegate EOA
    // (the owner) — a real dev-backend account captured 2026-09-24. Its
    // counterfactual HybridDeleGator address, derived offline from nothing but
    // that owner address, must equal the typed data's own
    // `domain.verifyingContract` (== `message.sender`) — proving this
    // module's derivation against a real Base Sepolia payload served by the dev backend, not just the kit.
    const owner = directPaymentUserOp.delegate_address as `0x${string}`
    const sender = directPaymentUserOp.typed_data.message.sender as `0x${string}`
    expect(deriveDelegateAccountAddress(owner).toLowerCase()).toBe(sender.toLowerCase())
  })

  it('keeps the kit OUT of the shipped dependency set', () => {
    const pkg = require('../package.json') as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.['@metamask/smart-accounts-kit']).toBeUndefined()
  })
})

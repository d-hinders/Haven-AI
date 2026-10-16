/**
 * CHARACTERIZATION — the user-account deploy salt (#4023, epic #4022 slice S1).
 *
 * Pins the counterfactual Hybrid address an EXISTING user-account derivation
 * computes, offline through the kit's own counterfactual helper — never a
 * live RPC. Two facts are pinned:
 *
 *  1. At the historical salt `'0x'`, the derivation lands on a FIXED address
 *     (a literal in this file): the account every existing row was derived
 *     from. Any change to `deploySalt` handling that silently moved this
 *     address would re-derive every existing account onto an address nobody
 *     owns — this pin is the seatbelt.
 *  2. A non-zero salt derives a DIFFERENT address for the SAME owner — the
 *     property multiple accounts on one passkey rest on.
 *
 * The salt scheme (partner review, 2026-10-16): a monotonic per-(user, passkey
 * key_id) counter, GLOBAL across chains, starting at 1 — because
 * `pad('0x', { size: 32 })` is the SAME salt as `'0x'`
 * (`packages/sdk/src/delegate-account.ts:93`), so 0 would collide with the
 * historical salt-0 account.
 */
import { describe, expect, it } from 'vitest'
import { getCounterfactualAccountData } from '@metamask/smart-accounts-kit/utils'
import { getSmartAccountsEnvironment, Implementation } from '@metamask/smart-accounts-kit'
import { pad } from 'viem'

import { computeHybridAccountAddress } from '../hybrid-provisioning.js'

const CHAIN_ID = 84532 // Base Sepolia — the pinned derivation chain
const OWNER = '0x2b2e66489c4BEdE4D510CD1A3062Ea45Edc8AAC9' as const

/** The salt-'0x' counterfactual address for `OWNER`, derived offline via the kit. */
const SALT_ZERO_ADDRESS = '0xbb4D807a7BA2DDea2de92aa0b8a725D45918133d'
/** The SAME owner at the 32-byte salt `0x…01` (counter = 1) — a different account. */
const SALT_ONE_ADDRESS = '0x7bF30D5f692Fe151936bCb0b2b9283642EADC0D4'

/** The offline oracle: the kit's own counterfactual helper, no RPC. */
async function kitAddress(deploySalt: string): Promise<string> {
  const env = getSmartAccountsEnvironment(CHAIN_ID) as unknown as {
    SimpleFactory: `0x${string}`
    implementations: Record<string, `0x${string}`>
  }
  const data = await getCounterfactualAccountData({
    factory: env.SimpleFactory,
    implementations: env.implementations,
    implementation: Implementation.Hybrid,
    deployParams: [OWNER, [], [], []],
    deploySalt: deploySalt as `0x${string}`,
  })
  return (data as { address: string }).address
}

describe('user-account deploy salt (#4023 characterization)', () => {
  it('CHARACTERIZATION: at salt 0x the derivation lands on the pinned existing address', async () => {
    const derived = await computeHybridAccountAddress(CHAIN_ID, {
      ownerAddress: OWNER,
    })
    expect(derived.toLowerCase()).toBe(SALT_ZERO_ADDRESS.toLowerCase())
    // …and the oracle agrees — the pin is the kit's own answer, not ours.
    expect((await kitAddress('0x')).toLowerCase()).toBe(SALT_ZERO_ADDRESS.toLowerCase())
  })

  it('CHARACTERIZATION: a non-zero salt derives a different address for the same owner', async () => {
    const saltOne = pad('0x01', { size: 32 })
    expect((await kitAddress(saltOne)).toLowerCase()).toBe(SALT_ONE_ADDRESS.toLowerCase())
    // Not equal is the property multiple accounts on one passkey rest on.
    expect(SALT_ONE_ADDRESS.toLowerCase()).not.toBe(SALT_ZERO_ADDRESS.toLowerCase())
  })
})

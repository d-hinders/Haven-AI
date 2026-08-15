/**
 * The SDK's settlement-payload fixture must keep describing THIS backend
 * (#1452, epic #1450).
 *
 * `packages/sdk/src/__fixtures__/settlement-delegation-payload.json` was
 * generated from `buildSettlementDelegation` so the SDK's signing test runs
 * against a real payload instead of a hand-written guess. That only helps
 * while the two agree — a fixture is a snapshot, and a snapshot nobody checks
 * is just a stale copy that makes a broken signer look correct.
 *
 * This test is the check, and it lives on the BACKEND side deliberately: the
 * failure it must catch is "the backend changed its signing payload", and the
 * person making that change is editing this package. The SDK cannot import the
 * backend, so nothing over there would notice.
 *
 * It compares only the shape the signature's validity depends on — domain,
 * types, primaryType, and the message's key set. Not the values: expiry is
 * clock-derived and salt is per-delegation, so asserting those would make this
 * fail for reasons that have nothing to do with drift.
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Delegation } from '@metamask/smart-accounts-kit'
import { buildSettlementDelegation } from '../x402-delegation.js'

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../sdk/src/__fixtures__/settlement-delegation-payload.json',
)

/** The exact inputs the fixture was generated with — see the fixture's note. */
function buildSamePayload() {
  const budgetDelegation = {
    delegator: '0x1111111111111111111111111111111111111111',
    delegate: '0x2222222222222222222222222222222222222222',
    authority: `0x${'00'.repeat(32)}`,
    caveats: [],
    salt: '0x0',
    signature: `0x${'ab'.repeat(65)}`,
  } as unknown as Delegation

  return buildSettlementDelegation({
    chainId: 84532,
    delegateAccountAddress: '0x1111111111111111111111111111111111111111',
    budgetDelegation,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amountAtomic: 1000n,
    payTo: '0x3333333333333333333333333333333333333333',
    maxTimeoutSeconds: 300,
    redeemers: ['0x4444444444444444444444444444444444444444'],
  }).signingPayload
}

describe('SDK settlement-payload fixture (#1452)', () => {
  it('still matches what buildSettlementDelegation emits', async () => {
    const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'))
    const live = JSON.parse(
      JSON.stringify(buildSamePayload(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    )

    expect(live.domain).toEqual(fixture.domain)
    expect(live.types).toEqual(fixture.types)
    expect(live.primaryType).toBe(fixture.primaryType)
    expect(Object.keys(live.message).sort()).toEqual(Object.keys(fixture.message).sort())
  })

  it('the fixture carries no EIP712Domain in types — the SDK strip is defensive', async () => {
    // Documented in signer.ts as belt-and-braces. If this ever fails, that
    // comment became wrong and the delete became load-bearing.
    const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'))
    expect(fixture.types.EIP712Domain).toBeUndefined()
    expect(buildSamePayload().types).not.toHaveProperty('EIP712Domain')
  })
})

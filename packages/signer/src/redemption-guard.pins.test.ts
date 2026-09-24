/**
 * #3272 (B1) — the vendored `Delegation`/`Caveat` ABI tuple and
 * `ExecutionMode.SingleDefault` must keep meaning what the kit's own encoder
 * says they mean. The kit is a devDependency only (see `package.json`),
 * cross-checked here, never imported at runtime by `redemption-guard.ts`.
 */
import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, encodeAbiParameters, getAddress, type Address } from 'viem'
import { ExecutionMode } from '@metamask/smart-accounts-kit'
import { encodeDelegations, DELEGATION_ABI_TYPE_COMPONENTS } from '@metamask/smart-accounts-kit/utils'
import {
  DELEGATION_TUPLE_COMPONENTS,
  SINGLE_DEFAULT_MODE,
  assertRedeemsOwnBudgetDelegation,
} from './redemption-guard.js'
import { buildBoundRedeemDelegationsCallData, buildDelegation } from './test-support/direct-userop.js'

const DELEGATE = getAddress(`0x${'11'.repeat(20)}`) as Address
const DELEGATOR = getAddress(`0x${'22'.repeat(20)}`) as Address

describe('vendored Delegation/Caveat ABI (#3272 B1)', () => {
  it('matches the kit\'s own DELEGATION_ABI_TYPE_COMPONENTS exactly', () => {
    expect(DELEGATION_TUPLE_COMPONENTS).toEqual(DELEGATION_ABI_TYPE_COMPONENTS)
  })

  it('decodes what the kit encodes, field for field', () => {
    const kitEncoded = encodeDelegations([
      {
        delegate: DELEGATE,
        delegator: DELEGATOR,
        authority: `0x${'ff'.repeat(32)}` as `0x${string}`,
        caveats: [{ enforcer: getAddress(`0x${'33'.repeat(20)}`), terms: '0xdead', args: '0x' }],
        salt: `0x07` as `0x${string}`,
        signature: '0xbeef',
      },
    ])
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple[]', components: DELEGATION_TUPLE_COMPONENTS }],
      kitEncoded,
    )
    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toMatchObject({
      delegate: DELEGATE,
      delegator: DELEGATOR,
      salt: 7n,
    })
    expect(decoded[0].caveats).toHaveLength(1)
  })

  it('our own encoder round-trips through the kit-shaped decoder', () => {
    const delegation = buildDelegation({ delegate: DELEGATE, delegator: DELEGATOR })
    const ourEncoded = encodeAbiParameters(
      [{ type: 'tuple[]', components: DELEGATION_TUPLE_COMPONENTS }],
      [[delegation]],
    )
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple[]', components: DELEGATION_TUPLE_COMPONENTS }],
      ourEncoded,
    )
    expect(decoded[0]).toMatchObject({ delegate: DELEGATE, delegator: DELEGATOR })
  })

  it('SINGLE_DEFAULT_MODE matches the kit\'s ExecutionMode.SingleDefault', () => {
    expect(SINGLE_DEFAULT_MODE.toLowerCase()).toBe((ExecutionMode.SingleDefault as string).toLowerCase())
  })

  it('accepts a real, kit-shaped redemption for the correct delegate', () => {
    // End-to-end: our OWN builder (used by every signer test) produces
    // something `assertRedeemsOwnBudgetDelegation` accepts — not just
    // something that happens to decode.
    const callData = buildBoundRedeemDelegationsCallData({ delegate: DELEGATE, delegator: DELEGATOR })
    expect(() => assertRedeemsOwnBudgetDelegation(callData, DELEGATE)).not.toThrow()
  })

  it('keeps the kit OUT of the shipped dependency set', () => {
    const pkg = require('../package.json') as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.['@metamask/smart-accounts-kit']).toBeUndefined()
  })
})

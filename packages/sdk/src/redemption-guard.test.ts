import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { assertRedeemsOwnBudgetDelegation, REDEEM_DELEGATIONS_ABI, SINGLE_DEFAULT_MODE } from './redemption-guard.js'
import {
  buildDelegation,
  buildChainPermissionContext,
  buildPermissionContext,
  buildSingleExecutionCallData,
  DEFAULT_DELEGATOR,
} from './test-support/direct-userop.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'

const THIRD_PARTY = '0x5555555555555555555555555555555555555555' as Address

function redeemCallData(chain: ReturnType<typeof buildDelegation>[], sender: Address) {
  return encodeFunctionData({
    abi: REDEEM_DELEGATIONS_ABI,
    functionName: 'redeemDelegations',
    args: [
      [chain.length === 1 ? buildPermissionContext(chain[0]) : buildChainPermissionContext(chain)],
      [SINGLE_DEFAULT_MODE],
      [buildSingleExecutionCallData(sender, 0n, '0x')],
    ],
  })
}

describe('assertRedeemsOwnBudgetDelegation — one-link chain (unchanged)', () => {
  const owner = privateKeyToAccount(generatePrivateKey()).address
  const own = deriveDelegateAccountAddress(owner)

  it('accepts the single budget grant', () => {
    const budget = buildDelegation({ delegate: own, delegator: DEFAULT_DELEGATOR })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([budget], own), own)).not.toThrow()
  })

  it('refuses a self-to-self one-link delegation', () => {
    const selfDelegation = buildDelegation({ delegate: own, delegator: own })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([selfDelegation], own), own)).toThrow(
      /granted by this signer's OWN account/,
    )
  })
})

describe('assertRedeemsOwnBudgetDelegation — two-link task-budget chain (#3329)', () => {
  const owner = privateKeyToAccount(generatePrivateKey()).address
  const own = deriveDelegateAccountAddress(owner)

  it('accepts [self-delegated task child, budget]', () => {
    const taskChild = buildDelegation({ delegate: own, delegator: own })
    const budget = buildDelegation({ delegate: own, delegator: DEFAULT_DELEGATOR })
    expect(() =>
      assertRedeemsOwnBudgetDelegation(redeemCallData([taskChild, budget], own), own),
    ).not.toThrow()
  })

  it('refuses a two-link chain whose leaf is not self-delegated (third-party leaf delegator)', () => {
    const leaf = buildDelegation({ delegate: own, delegator: THIRD_PARTY })
    const root = buildDelegation({ delegate: THIRD_PARTY, delegator: DEFAULT_DELEGATOR })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([leaf, root], own), own)).toThrow(
      /task-budget child is always self-delegated/,
    )
  })

  it('refuses a two-link chain whose second link does not delegate to the own account', () => {
    const taskChild = buildDelegation({ delegate: own, delegator: own })
    const budget = buildDelegation({ delegate: THIRD_PARTY, delegator: DEFAULT_DELEGATOR })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([taskChild, budget], own), own)).toThrow(
      /second link delegates to/,
    )
  })

  it('refuses a two-link chain whose budget link is granted by the own account (self-to-self budget)', () => {
    const taskChild = buildDelegation({ delegate: own, delegator: own })
    const budget = buildDelegation({ delegate: own, delegator: own })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([taskChild, budget], own), own)).toThrow(
      /budget link is granted by this signer's OWN account/,
    )
  })

  it('refuses a three-link chain whose leaf is self-delegated (a task child never chains two deep) (#3330)', () => {
    const leaf = buildDelegation({ delegate: own, delegator: own })
    const mid = buildDelegation({ delegate: own, delegator: THIRD_PARTY })
    const root = buildDelegation({ delegate: THIRD_PARTY, delegator: DEFAULT_DELEGATOR })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([leaf, mid, root], own), own)).toThrow(
      /leaf is delegated by this signer's OWN account/,
    )
  })

  // ── Three-link sub-budget chain (#3330): [sub grant, parent child, budget] ─

  it('accepts the three-link sub-budget chain (#3330)', () => {
    // B's grant (delegate=B=own, delegator=A), A's parent-child (self), A's
    // budget (delegate=A, delegator=treasury).
    const grant = buildDelegation({ delegate: own, delegator: THIRD_PARTY })
    const parentChild = buildDelegation({ delegate: THIRD_PARTY, delegator: THIRD_PARTY })
    const budget = buildDelegation({ delegate: THIRD_PARTY, delegator: DEFAULT_DELEGATOR })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([grant, parentChild, budget], own), own)).not.toThrow()
  })

  it('refuses a three-link chain whose middle link is not the delegating agent self-delegated (#3330)', () => {
    const grant = buildDelegation({ delegate: own, delegator: THIRD_PARTY })
    const parentChild = buildDelegation({ delegate: THIRD_PARTY, delegator: DEFAULT_DELEGATOR }) // not self
    const budget = buildDelegation({ delegate: THIRD_PARTY, delegator: DEFAULT_DELEGATOR })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([grant, parentChild, budget], own), own)).toThrow(
      /middle link is delegated by/,
    )
  })

  it('refuses a three-link chain whose middle link does not delegate to the delegating agent (#3330)', () => {
    const grant = buildDelegation({ delegate: own, delegator: THIRD_PARTY })
    const parentChild = buildDelegation({ delegate: DEFAULT_DELEGATOR, delegator: THIRD_PARTY })
    const budget = buildDelegation({ delegate: THIRD_PARTY, delegator: DEFAULT_DELEGATOR })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([grant, parentChild, budget], own), own)).toThrow(
      /middle link delegates to/,
    )
  })

  it('refuses a three-link chain whose budget link does not delegate to the delegating agent (#3330)', () => {
    const grant = buildDelegation({ delegate: own, delegator: THIRD_PARTY })
    const parentChild = buildDelegation({ delegate: THIRD_PARTY, delegator: THIRD_PARTY })
    const budget = buildDelegation({ delegate: own, delegator: DEFAULT_DELEGATOR })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([grant, parentChild, budget], own), own)).toThrow(
      /budget link delegates to/,
    )
  })

  it('refuses a three-link chain whose budget link is granted by the delegating agent (#3330)', () => {
    const grant = buildDelegation({ delegate: own, delegator: THIRD_PARTY })
    const parentChild = buildDelegation({ delegate: THIRD_PARTY, delegator: THIRD_PARTY })
    const budget = buildDelegation({ delegate: THIRD_PARTY, delegator: THIRD_PARTY })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([grant, parentChild, budget], own), own)).toThrow(
      /budget link is granted by the delegating agent's OWN/,
    )
  })

  it('refuses when the leaf delegate is not the own account, even in a two-link chain', () => {
    const leaf = buildDelegation({ delegate: THIRD_PARTY, delegator: THIRD_PARTY })
    const root = buildDelegation({ delegate: own, delegator: DEFAULT_DELEGATOR })
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCallData([leaf, root], own), own)).toThrow(
      /not this signer's own account/,
    )
  })
})

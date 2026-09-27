/**
 * Characterization test for `assembleSettlementPayload` (#3329 prep): pins
 * the exact `permissionContext` bytes for the ORDINARY two-delegation chain
 * (`[settlement, budget]`) before #3329 adds an optional THREE-delegation
 * form (`[settlement, taskChild, budget]`, when a task budget authorized the
 * settlement). The two-delegation case must keep producing IDENTICAL bytes —
 * every merchant that redeems today depends on it.
 */
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import type { Delegation } from '@metamask/smart-accounts-kit'
import { assembleSettlementPayload } from '../x402-delegation.js'

const CHAIN_ID = 84532
const DELEGATE_ACCOUNT: Address = '0x1111111111111111111111111111111111111111'

const CHILD: Omit<Delegation, 'signature'> = {
  delegate: '0x0000000000000000000000000000000000000a11',
  delegator: DELEGATE_ACCOUNT,
  authority: `0x${'ff'.repeat(32)}` as Hex,
  caveats: [
    { enforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069', terms: `0x${'00'.repeat(32)}` as Hex, args: '0x' as Hex },
  ],
  salt: 1n,
} as unknown as Omit<Delegation, 'signature'>

const CHILD_SIGNATURE = `0x${'cd'.repeat(65)}` as Hex

const BUDGET: Delegation = {
  delegate: DELEGATE_ACCOUNT,
  delegator: '0x2222222222222222222222222222222222222222',
  authority: `0x${'00'.repeat(32)}` as Hex,
  caveats: [],
  salt: 2n,
  signature: `0x${'ab'.repeat(65)}` as Hex,
} as unknown as Delegation

const TASK_CHILD: Delegation = {
  delegate: DELEGATE_ACCOUNT,
  delegator: DELEGATE_ACCOUNT,
  authority: `0x${'ee'.repeat(32)}` as Hex,
  caveats: [],
  salt: 3n,
  signature: `0x${'12'.repeat(65)}` as Hex,
} as unknown as Delegation

describe('assembleSettlementPayload — two-delegation characterization (#3329)', () => {
  it('pins the encoded [settlement, budget] permission context', () => {
    const payload = assembleSettlementPayload(CHAIN_ID, CHILD, CHILD_SIGNATURE, BUDGET, DELEGATE_ACCOUNT)
    expect(payload.delegator).toBe(DELEGATE_ACCOUNT)
    expect(payload.permissionContext.startsWith('0x')).toBe(true)
    expect(payload.permissionContext).toMatchSnapshot()
  })

  it('#3329: encodes [settlement, taskChild, budget] when a task budget child is supplied', () => {
    const twoChain = assembleSettlementPayload(CHAIN_ID, CHILD, CHILD_SIGNATURE, BUDGET, DELEGATE_ACCOUNT)
    const threeChain = assembleSettlementPayload(
      CHAIN_ID, CHILD, CHILD_SIGNATURE, BUDGET, DELEGATE_ACCOUNT, TASK_CHILD,
    )
    expect(threeChain.permissionContext).not.toBe(twoChain.permissionContext)
    expect(threeChain.permissionContext).toMatchSnapshot()
  })
})

/**
 * Characterization test for `buildRedemptionCall` (#3329 prep): pins the
 * exact bytes a SINGLE-delegation redemption call encodes to, before #3329
 * widens the function to accept a delegation CHAIN (`[task child, budget]`)
 * for task-budget-authorized payments. The one-delegation case must keep
 * producing IDENTICAL bytes — every existing money-path caller
 * (`prepareDelegationPayment`'s ordinary `[budget]` case) depends on it.
 */
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { buildRedemptionCall, type Delegation } from '../delegation-rail.js'

const CHAIN_ID = 84532
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const TO: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const AMOUNT = 1_000_000n

const BUDGET: Delegation = {
  delegate: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  delegator: '0x98ffBf30459a98FD80fAce18f519967769641F76',
  authority: `0x${'ff'.repeat(32)}` as Hex,
  caveats: [
    { enforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069', terms: `0x${'00'.repeat(32)}` as Hex, args: '0x' as Hex },
  ],
  salt: 1n,
  signature: `0x${'ab'.repeat(65)}` as Hex,
} as unknown as Delegation

describe('buildRedemptionCall — single-delegation characterization (#3329)', () => {
  it('pins the encoded call for one delegation, wrapped in a one-element chain', () => {
    const call = buildRedemptionCall(CHAIN_ID, [BUDGET], USDC, TO, AMOUNT)
    expect(call.to).toBe('0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3')
    expect(call.value).toBe(0n)
    expect(call.data.startsWith('0x')).toBe(true)
    expect(call.data.length).toBeGreaterThan(10)
    // Snapshot the exact bytes so any future encoding change is visible.
    expect(call.data).toMatchSnapshot()
  })
})

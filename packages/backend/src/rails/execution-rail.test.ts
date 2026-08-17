/**
 * #1482 — `prepared_user_op` means different things per settlement scheme.
 *
 * CHARACTERIZATION FIRST (money.md §2). `deserializeUserOp` is on the rail
 * seam, so what it returns for a real 3009-bridge UserOp is pinned here before
 * anything reads its shape — the invariant the new guard must preserve is that
 * a genuine UserOp keeps flowing through untouched.
 */

import { describe, expect, it } from 'vitest'
import { deserializeUserOp, isSettlementChainState } from './execution-rail.js'

/** Shape the 3009 bridge stores: a UserOperation, bigints marker-encoded. */
const USER_OP_STATE = {
  sender: '0x98ffBf30459a98FD80fAce18f519967769641F76',
  nonce: '__bigint__1',
  callData: '0xdeadbeef',
  callGasLimit: '__bigint__100000',
}

/** Shape erc7710 stores (#946/#1454): the delegation chain to redeem. */
const SETTLEMENT_CHAIN_STATE = {
  child: { delegate: '0x' + 'a1'.repeat(20), caveats: [] },
  budget: { delegate: '0x' + 'b2'.repeat(20), caveats: [] },
  delegateAccountAddress: '0x' + 'c3'.repeat(20),
  network: 'eip155:84532',
}

describe('deserializeUserOp — characterization', () => {
  it('round-trips a UserOp state and decodes its bigint markers', () => {
    const state = deserializeUserOp(USER_OP_STATE) as Record<string, unknown>
    expect(state.sender).toBe(USER_OP_STATE.sender)
    expect(state.nonce).toBe(1n)
    expect(state.callGasLimit).toBe(100000n)
  })

  it('accepts the stored form as a JSON string too', () => {
    const state = deserializeUserOp(JSON.stringify(USER_OP_STATE)) as Record<string, unknown>
    expect(state.nonce).toBe(1n)
  })
})

describe('isSettlementChainState (#1482)', () => {
  it('recognises an erc7710 settlement chain', () => {
    expect(isSettlementChainState(deserializeUserOp(SETTLEMENT_CHAIN_STATE))).toBe(true)
  })

  it('does NOT flag a UserOp — the invariant the guard must preserve', () => {
    // The whole point: adding the guard must not stop a 3009-bridge payment
    // from being submitted. This is the characterization half.
    expect(isSettlementChainState(deserializeUserOp(USER_OP_STATE))).toBe(false)
  })

  it('needs BOTH halves of the chain, not just one', () => {
    // `child` alone is not a redeemable chain, and treating it as one would
    // refuse a payment for the wrong reason.
    expect(isSettlementChainState({ child: {} })).toBe(false)
    expect(isSettlementChainState({ budget: {} })).toBe(false)
  })

  it('is safe on non-objects rather than throwing', () => {
    // It runs on deserialized DB content, so a null or a scalar must produce
    // a boolean, not an exception inside the signing path.
    expect(isSettlementChainState(null)).toBe(false)
    expect(isSettlementChainState(undefined)).toBe(false)
    expect(isSettlementChainState('a string')).toBe(false)
    expect(isSettlementChainState(42)).toBe(false)
  })
})

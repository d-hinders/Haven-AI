/**
 * #1455 — the refusals ARE the deliverable.
 *
 * Every test below mutates ONE field of a real `buildSettlementDelegation`
 * payload (the #1452 fixture, drift-guarded on the backend side) and asserts
 * the signer refuses. That direction matters: a verifier proven only on the
 * happy path is a verifier nobody has shown can fire.
 */

import { describe, expect, it } from 'vitest'
import { HavenSigningError } from '@haven_ai/sdk'
import CHILD from '../../sdk/src/__fixtures__/settlement-delegation-payload.json' with { type: 'json' }
import {
  CAVEAT_ENFORCERS,
  DELEGATION_MANAGER,
  MAX_SETTLEMENT_WINDOW_SECONDS,
  isSettlementChildTypedData,
  verifySettlementChild,
  type SettlementChildTypedData,
} from './settlement-child.js'

/** The fixture's own values, so the "matching" expectation is not invented. */
const MERCHANT = '0x3333333333333333333333333333333333333333'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const EXPECTED = { merchantTo: MERCHANT, amount: '1000', asset: USDC, chainId: 84532 }

/** The fixture's expiry is a fixed timestamp; anchor `now` just inside it. */
function nowInsideWindow(child: SettlementChildTypedData): number {
  const ts = child.message.caveats as Array<{ enforcer: string; terms: string }>
  const t = ts.find((c) => c.enforcer.toLowerCase() === CAVEAT_ENFORCERS.timestamp.toLowerCase())!
  const before = Number(BigInt('0x' + t.terms.slice(2).slice(32, 64)))
  return (before - 60) * 1000
}

function child(): SettlementChildTypedData {
  return JSON.parse(JSON.stringify(CHILD)) as SettlementChildTypedData
}

function caveat(td: SettlementChildTypedData, enforcer: string) {
  const list = td.message.caveats as Array<{ enforcer: string; terms: string }>
  return list.find((c) => c.enforcer.toLowerCase() === enforcer.toLowerCase())!
}

function expectRefusal(td: SettlementChildTypedData, match: RegExp, now?: number) {
  expect(() => verifySettlementChild(td, EXPECTED, now ?? nowInsideWindow(child()))).toThrow(match)
  expect(() => verifySettlementChild(td, EXPECTED, now ?? nowInsideWindow(child()))).toThrow(
    HavenSigningError,
  )
}

describe('verifySettlementChild (#1455)', () => {
  it('accepts the real child against a matching expectation', () => {
    expect(() => verifySettlementChild(child(), EXPECTED, nowInsideWindow(child()))).not.toThrow()
  })

  it('recognises a delegation payload, and does not mistake a UserOp for one', () => {
    expect(isSettlementChildTypedData(child())).toBe(true)
    expect(isSettlementChildTypedData({ primaryType: 'PackedUserOperation', domain: {}, types: {}, message: {} })).toBe(false)
    expect(isSettlementChildTypedData(undefined)).toBe(false)
  })

  // ── one refusal per field the declaration promises ──────────────────────

  it('refuses a child paying a DIFFERENT address than declared', () => {
    // The attack this whole file exists for: the declaration says the merchant,
    // the caveat pins someone else, and the two bind together perfectly.
    const td = child()
    const c = caveat(td, CAVEAT_ENFORCERS.allowedCalldata)
    c.terms = c.terms.slice(0, 2 + 64 + 24) + '9'.repeat(40)
    expectRefusal(td, /pays a different address than Haven declared/)
  })

  it('refuses a different amount', () => {
    const td = child()
    const c = caveat(td, CAVEAT_ENFORCERS.erc20TransferAmount)
    c.terms = c.terms.slice(0, 2 + 40) + (2000).toString(16).padStart(64, '0')
    expectRefusal(td, /amount does not match/)
  })

  it('refuses a different token', () => {
    const td = child()
    const c = caveat(td, CAVEAT_ENFORCERS.erc20TransferAmount)
    c.terms = '0x' + '8'.repeat(40) + c.terms.slice(2 + 40)
    expectRefusal(td, /spends a different token/)
  })

  it('refuses the wrong chain', () => {
    const td = child()
    td.domain.chainId = 8453
    expectRefusal(td, /scoped to the wrong chain/)
  })

  it('refuses an unknown DelegationManager', () => {
    // Every enforcer comparison below is meaningless under a different manager.
    const td = child()
    td.domain.verifyingContract = '0x' + '7'.repeat(40)
    expectRefusal(td, /unknown DelegationManager/)
  })

  it('refuses a payee pin at the wrong calldata offset', () => {
    const td = child()
    const c = caveat(td, CAVEAT_ENFORCERS.allowedCalldata)
    c.terms = '0x' + (36).toString(16).padStart(64, '0') + c.terms.slice(2 + 64)
    expectRefusal(td, /wrong calldata offset/)
  })

  // ── absence is as dangerous as disagreement ─────────────────────────────

  it('refuses when the payee pin is missing entirely', () => {
    const td = child()
    td.message.caveats = (td.message.caveats as Array<{ enforcer: string }>).filter(
      (c) => c.enforcer.toLowerCase() !== CAVEAT_ENFORCERS.allowedCalldata.toLowerCase(),
    )
    expectRefusal(td, /no payee pin/)
  })

  it('refuses when the amount caveat is missing entirely', () => {
    const td = child()
    td.message.caveats = (td.message.caveats as Array<{ enforcer: string }>).filter(
      (c) => c.enforcer.toLowerCase() !== CAVEAT_ENFORCERS.erc20TransferAmount.toLowerCase(),
    )
    expectRefusal(td, /no ERC-20 transfer-amount caveat/)
  })

  it('refuses when the expiry caveat is missing entirely', () => {
    const td = child()
    td.message.caveats = (td.message.caveats as Array<{ enforcer: string }>).filter(
      (c) => c.enforcer.toLowerCase() !== CAVEAT_ENFORCERS.timestamp.toLowerCase(),
    )
    expectRefusal(td, /never expires/)
  })

  it('refuses a child with no caveats at all', () => {
    const td = child()
    td.message.caveats = []
    expectRefusal(td, /no caveats at all/)
  })

  // ── the window ──────────────────────────────────────────────────────────

  it('refuses an already-expired child', () => {
    const td = child()
    const before = Number(BigInt('0x' + caveat(td, CAVEAT_ENFORCERS.timestamp).terms.slice(2).slice(32, 64)))
    expectRefusal(td, /already expired/, (before + 1) * 1000)
  })

  it('refuses a window longer than a settlement may live', () => {
    // The backend clamps to MAX_SETTLEMENT_WINDOW_SECONDS. Re-checking locally
    // means a backend that stopped clamping cannot hand out a long-lived grant.
    const td = child()
    const c = caveat(td, CAVEAT_ENFORCERS.timestamp)
    const before = Number(BigInt('0x' + c.terms.slice(2).slice(32, 64)))
    const now = (before - MAX_SETTLEMENT_WINDOW_SECONDS - 60) * 1000
    expectRefusal(td, /longer than a settlement may live/, now)
  })

  it('refuses a child that outlives the declared payment window', () => {
    const td = child()
    const before = Number(BigInt('0x' + caveat(td, CAVEAT_ENFORCERS.timestamp).terms.slice(2).slice(32, 64)))
    const now = (before - 60) * 1000
    expect(() =>
      verifySettlementChild(
        td,
        { ...EXPECTED, expiresAt: new Date((before - 30) * 1000).toISOString() },
        now,
      ),
    ).toThrow(/outlives the payment window/)
  })

  // ── what must NOT be refused ────────────────────────────────────────────

  it('allows an unrecognised extra caveat — they can only narrow authority', () => {
    const td = child()
    ;(td.message.caveats as Array<{ enforcer: string; terms: string }>).push({
      enforcer: '0x' + 'ab'.repeat(20),
      terms: '0x1234',
    })
    expect(() => verifySettlementChild(td, EXPECTED, nowInsideWindow(child()))).not.toThrow()
  })

  it('is case-insensitive about addresses', () => {
    expect(() =>
      verifySettlementChild(
        child(),
        { ...EXPECTED, merchantTo: MERCHANT.toUpperCase().replace('0X', '0x'), asset: USDC.toLowerCase() },
        nowInsideWindow(child()),
      ),
    ).not.toThrow()
  })

  it('pins the DelegationManager the fixture actually uses', () => {
    expect(child().domain.verifyingContract?.toLowerCase()).toBe(DELEGATION_MANAGER.toLowerCase())
  })
})

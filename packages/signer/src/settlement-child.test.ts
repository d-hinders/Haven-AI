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
  chainIdForNetwork,
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

/**
 * Review finding (#1455): the production call site passed
 * `Number(typedData.domain.chainId)` as the expectation, so the chain check
 * compared a value to itself and could never fire. The unit test above passed
 * throughout, because it supplied an independent expectation the call site did
 * not. These pin the DERIVATION instead.
 */
describe('chainIdForNetwork — the expectation must come from the signed field', () => {
  it('maps the network strings Haven actually signs', () => {
    expect(chainIdForNetwork('eip155:84532')).toBe(84532)
    expect(chainIdForNetwork('eip155:8453')).toBe(8453)
    expect(chainIdForNetwork('base')).toBe(8453)
    expect(chainIdForNetwork('base-sepolia')).toBe(84532)
  })

  it('returns undefined for a network it cannot map, so the caller cannot pass silently', () => {
    // The call site turns this into -1, which no domain chainId can equal.
    // Failing closed on an unmappable network beats guessing one.
    expect(chainIdForNetwork('solana')).toBeUndefined()
    expect(chainIdForNetwork(undefined)).toBeUndefined()
    expect(chainIdForNetwork('eip155:')).toBeUndefined()
  })

  it('refuses a child whose domain chain disagrees with the SIGNED network', () => {
    // The end-to-end shape of the bug: Haven signs network=base-sepolia while
    // the child is built for Base. Deriving the expectation from the payload
    // made these agree by construction.
    const td = child()
    td.domain.chainId = 8453
    expect(() =>
      verifySettlementChild(
        td,
        { ...EXPECTED, chainId: chainIdForNetwork('eip155:84532')! },
        nowInsideWindow(child()),
      ),
    ).toThrow(/scoped to the wrong chain/)
  })
})

/**
 * #1455 review challenged the "extra caveats can only narrow" premise, citing
 * `LogicalOrWrapperEnforcer` — which really does let a redeemer pick its least
 * restrictive GROUP. Resolved against the framework source: `redeemDelegations`
 * calls `beforeHook` on every caveat with no break and no try/catch, so
 * top-level caveats are strictly AND-ed and the wrapper is just one more of
 * them. These pin both halves of that conclusion.
 */
describe('the AND premise, after the LogicalOrWrapper challenge (#1455)', () => {
  const LOGICAL_OR_WRAPPER = '0x' + 'c0ffee'.padEnd(40, '0')

  it('allows a wrapper-style caveat alongside the required four', () => {
    // It cannot unlock them: every caveat must pass, so this can only add a
    // constraint on top of the payee/amount/expiry pins.
    const td = child()
    ;(td.message.caveats as Array<{ enforcer: string; terms: string }>).push({
      enforcer: LOGICAL_OR_WRAPPER,
      terms: '0x' + '00'.repeat(64),
    })
    expect(() => verifySettlementChild(td, EXPECTED, nowInsideWindow(child()))).not.toThrow()
  })

  it('refuses a child whose payee pin is NOT a top-level caveat', () => {
    // The genuinely dangerous shape: the pin hidden inside a wrapper group,
    // where a redeemer could select a group that omits it. Absence at top
    // level is what this file refuses on, so it is caught for the right reason.
    const td = child()
    td.message.caveats = (td.message.caveats as Array<{ enforcer: string }>)
      .filter((c) => c.enforcer.toLowerCase() !== CAVEAT_ENFORCERS.allowedCalldata.toLowerCase())
      .concat([{ enforcer: LOGICAL_OR_WRAPPER, terms: '0x' + '11'.repeat(64) } as never])
    expectRefusal(td, /no payee pin/)
  })
})

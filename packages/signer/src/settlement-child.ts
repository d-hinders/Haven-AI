/**
 * Independent verification of an erc7710 x402 settlement child (#1455).
 *
 * WHY THIS EXISTS. `assertExpectedBinding` proves Haven *declared* a payload:
 * the expected context is signed by `HAVEN_X402_BINDING_SIGNER` and commits to
 * the digest of the exact bytes being signed. That is a real property, and it
 * is not this one. It says nothing about what the payload MEANS.
 *
 * A backend that declared `merchantTo = the real merchant` while pinning a
 * different payee in the child's `AllowedCalldata` caveat would produce a
 * perfectly consistent pair: the declaration binds the digest, the digest is
 * the child's, and the child pays someone else. The signature is the authority
 * here — the merchant's facilitator redeems it and pulls from the treasury — so
 * the signer has to re-derive the meaning locally or it is a pass-through with
 * extra steps.
 *
 * ADDRESSES ARE PINNED HERE ON PURPOSE. Reading the enforcer map from Haven
 * would make the check circular: an attacker who can pick which contract counts
 * as "the payee enforcer" can satisfy any comparison. Taking
 * `@metamask/smart-accounts-kit` as a runtime dependency was the other option
 * and was rejected — this package installs on users' machines. The constants
 * below are snapshot-pinned and cross-checked against the kit by a test
 * (`settlement-child.pins.test.ts`), the same pattern
 * `packages/core/src/chains.ts` uses against its registry.
 *
 * EXTRA CAVEATS ARE ALLOWED, and that is deliberate — verified, not assumed
 * (#1455 review challenged it directly).
 *
 * `DelegationManager.redeemDelegations` loops every caveat of every delegation
 * and calls `beforeHook` on each, with no break and no try/catch: a single
 * revert aborts the whole redemption, and nothing lets one caveat cause another
 * to be skipped. Top-level caveats are therefore strictly AND-ed, so one this
 * file does not recognise can only add a constraint, never remove one.
 *
 * The specific challenge was `LogicalOrWrapperEnforcer`, whose terms encode
 * several caveat GROUPS and whose own security notice warns that "the redeemer
 * can select the least restrictive group, bypassing stricter requirements in
 * other groups". That warning is about groups INSIDE the wrapper — it binds
 * whoever authors wrapper terms. The wrapper is itself one caveat among the
 * delegation's, so it is AND-ed with the four required below and cannot unlock
 * them.
 *
 * The shape that WOULD be dangerous is the inverse: a required caveat hidden
 * inside a wrapper group instead of sitting at top level, where the redeemer
 * could select a group that omits it. This file scans top-level caveats and
 * refuses on absence, so that child is refused for lacking the caveat — which
 * is the correct outcome and is pinned by a test.
 */

import { HavenSigningError } from '@haven_ai/sdk'

/** DelegationManager, the EIP-712 `verifyingContract` for a delegation. */
export const DELEGATION_MANAGER = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'

/**
 * Caveat enforcers, by role. Deterministically deployed, so Base and Base
 * Sepolia share addresses — verified for both chains by the pin test.
 */
export const CAVEAT_ENFORCERS = {
  erc20TransferAmount: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc',
  allowedCalldata: '0xc2b0d624c1c4319760C96503BA27C347F3260f55',
  timestamp: '0x1046bb45C8d673d4ea75321280DB34899413c069',
  redeemer: '0xE144b0b2618071B4E56f746313528a669c7E65c5',
} as const

/** The backend's own ceiling (`MAX_SETTLEMENT_WINDOW_SECONDS`), enforced again here. */
export const MAX_SETTLEMENT_WINDOW_SECONDS = 600

export interface SettlementChildTypedData {
  domain: { name?: string; version?: string; chainId?: number | string; verifyingContract?: string }
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

interface Caveat {
  enforcer: string
  terms: string
}

/** True when this typed data is a delegation — the shape that must never be signed unbound. */
export function isSettlementChildTypedData(value: unknown): value is SettlementChildTypedData {
  const td = value as SettlementChildTypedData | undefined
  return (
    !!td &&
    td.primaryType === 'Delegation' &&
    typeof td.domain?.verifyingContract === 'string' &&
    Array.isArray((td.message as { caveats?: unknown })?.caveats)
  )
}

function same(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

function hex(value: string): string {
  return value.startsWith('0x') ? value.slice(2).toLowerCase() : value.toLowerCase()
}

/** Byte slice [start, end) of a `0x…` string, as lowercase hex without prefix. */
function slice(terms: string, start: number, end?: number): string {
  const body = hex(terms)
  return end === undefined ? body.slice(start * 2) : body.slice(start * 2, end * 2)
}

function findCaveat(caveats: Caveat[], enforcer: string): Caveat | undefined {
  return caveats.find((c) => same(c.enforcer, enforcer))
}

function refuse(what: string, detail: string): never {
  throw new HavenSigningError(
    `Refusing to sign the x402 settlement child: ${what}. ${detail} ` +
      'The signature on this child is what lets a merchant pull from the treasury, so it is ' +
      'verified locally against the Haven-signed expected context rather than trusted.',
  )
}

/**
 * Map an x402 network string to a chain id. Local on purpose (#1455 review):
 * the chain must come from Haven's SIGNED `network` field, never from the
 * payload under verification — see `verifySettlementChild`.
 */
export function chainIdForNetwork(network: string | undefined): number | undefined {
  if (!network) return undefined
  const caip = /^eip155:(\d+)$/.exec(network)
  if (caip) return Number(caip[1])
  if (network === 'base') return 8453
  if (network === 'base-sepolia') return 84532
  return undefined
}

export interface SettlementChildExpectation {
  merchantTo: string
  amount: string
  asset: string
  /**
   * Derived from the expected context's SIGNED `network`, never from
   * `typedData.domain.chainId`. Comparing the payload's own claim against
   * itself is a check that cannot fail — which is exactly what shipped in the
   * first draft of this file's call site, and what the review caught.
   */
  chainId: number
  /** ISO timestamp; the child must not outlive it. */
  expiresAt?: string
}

/**
 * Verify a settlement child implements what the expected context declares.
 * Throws `HavenSigningError` on any disagreement; returns nothing on success.
 *
 * `now` is injectable so the expiry checks are testable without faking clocks.
 */
export function verifySettlementChild(
  typedData: SettlementChildTypedData,
  expected: SettlementChildExpectation,
  now: number = Date.now(),
): void {
  // ── The delegation's own frame ────────────────────────────────────────────
  if (typedData.primaryType !== 'Delegation') {
    refuse('it is not a Delegation payload', `primaryType was '${typedData.primaryType}'.`)
  }
  if (!same(typedData.domain?.verifyingContract, DELEGATION_MANAGER)) {
    // A different verifying contract means a different DelegationManager —
    // every caveat address below would then be meaningless to compare.
    refuse(
      'the EIP-712 domain names an unknown DelegationManager',
      `Expected ${DELEGATION_MANAGER}, got ${typedData.domain?.verifyingContract}.`,
    )
  }
  const domainChain = Number(typedData.domain?.chainId)
  if (!Number.isFinite(domainChain) || domainChain !== expected.chainId) {
    refuse(
      'it is scoped to the wrong chain',
      `The expected context says chain ${expected.chainId}; the child says ${typedData.domain?.chainId}.`,
    )
  }

  const caveats = (typedData.message?.caveats as Caveat[] | undefined) ?? []
  if (caveats.length === 0) {
    refuse('it carries no caveats at all', 'An unconstrained delegation is not a payment.')
  }

  // ── Asset + amount: `ERC20TransferAmountEnforcer` ─────────────────────────
  // terms = 20-byte token ‖ 32-byte amount
  const transfer = findCaveat(caveats, CAVEAT_ENFORCERS.erc20TransferAmount)
  if (!transfer) {
    refuse(
      'it has no ERC-20 transfer-amount caveat',
      'Without it the delegation is not bounded to an amount.',
    )
  }
  const token = `0x${slice(transfer.terms, 0, 20)}`
  if (!same(token, expected.asset)) {
    refuse('it spends a different token', `Expected ${expected.asset}, child pins ${token}.`)
  }
  const amount = BigInt(`0x${slice(transfer.terms, 20, 52)}`)
  if (amount !== BigInt(expected.amount)) {
    refuse(
      'the amount does not match',
      `The expected context says ${expected.amount}; the child allows ${amount.toString()}.`,
    )
  }

  // ── Payee: `AllowedCalldataEnforcer` ──────────────────────────────────────
  // terms = uint256 startIndex ‖ 32-byte value. startIndex 4 is the `to` word
  // of `transfer(address,uint256)`, i.e. the payee is pinned.
  const calldata = findCaveat(caveats, CAVEAT_ENFORCERS.allowedCalldata)
  if (!calldata) {
    refuse(
      'it has no payee pin',
      'Without an allowed-calldata caveat the merchant could redeem it to any address.',
    )
  }
  const startIndex = BigInt(`0x${slice(calldata.terms, 0, 32)}`)
  if (startIndex !== 4n) {
    refuse(
      'the payee pin points at the wrong calldata offset',
      `Expected offset 4 (the transfer's \`to\` word), got ${startIndex.toString()}.`,
    )
  }
  // The value is the address left-padded to 32 bytes: 12 zero bytes then 20.
  const paddedPayee = slice(calldata.terms, 32, 64)
  if (paddedPayee.slice(0, 24) !== '0'.repeat(24)) {
    refuse('the pinned payee is not a plain address', 'Its 32-byte word is not a padded address.')
  }
  const payee = `0x${paddedPayee.slice(24)}`
  if (!same(payee, expected.merchantTo)) {
    refuse(
      'it pays a different address than Haven declared',
      `The expected context says ${expected.merchantTo}; the child pins ${payee}.`,
    )
  }

  // ── Expiry: `TimestampEnforcer` ───────────────────────────────────────────
  // terms = uint128 afterThreshold ‖ uint128 beforeThreshold (seconds).
  const timestamp = findCaveat(caveats, CAVEAT_ENFORCERS.timestamp)
  if (!timestamp) {
    refuse('it never expires', 'A settlement child without a timestamp caveat is open-ended.')
  }
  const beforeThreshold = Number(BigInt(`0x${slice(timestamp.terms, 16, 32)}`))
  if (beforeThreshold <= 0) {
    refuse('its expiry is unset', 'The timestamp caveat has no upper bound.')
  }
  const nowSec = Math.floor(now / 1000)
  if (beforeThreshold <= nowSec) {
    refuse('it has already expired', `Expiry ${beforeThreshold} is not in the future.`)
  }
  if (beforeThreshold > nowSec + MAX_SETTLEMENT_WINDOW_SECONDS) {
    // The backend clamps to this; re-checking locally means a backend that
    // stopped clamping cannot hand out a long-lived grant unnoticed.
    refuse(
      'its window is longer than a settlement may live',
      `Expiry is ${beforeThreshold - nowSec}s out; the ceiling is ${MAX_SETTLEMENT_WINDOW_SECONDS}s.`,
    )
  }
  if (expected.expiresAt) {
    const declared = Math.floor(Date.parse(expected.expiresAt) / 1000)
    if (Number.isFinite(declared) && beforeThreshold > declared) {
      refuse(
        'it outlives the payment window Haven declared',
        `The expected context expires at ${expected.expiresAt}; the child lives to ${beforeThreshold}.`,
      )
    }
  }
}

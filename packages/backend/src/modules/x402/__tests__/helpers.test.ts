import { describe, expect, it } from 'vitest'
import {
  chainIdFromX402Network,
  existingX402IntentMismatch,
  isPositiveDecimalAtomicAmount,
} from '../helpers.js'

/**
 * `existingX402IntentMismatch` is the #961 idempotency-key-reuse guard: it
 * decides whether a retried authorize call may RESUME the existing intent, or
 * must 409 because the same key is being asked to cover a materially
 * different payment. Pinned directly (without HTTP) so this seam's coverage
 * survives the #996 `src/modules/x402/` split unbroken — the import above is
 * the only line that changes when the function moves.
 *
 * Characterization gap found in the pre-#996 route suites: only 3 of this
 * function's 7 branches (`funding_to`, `amount`, `facilitator_addresses`)
 * were exercised by an assertion on the returned mismatch reason (grep for
 * "different x402" across x402.test.ts / x402-delegation.test.ts finds no
 * `resource_url`, `merchant_to`, `asset`, or `network` case). Money-path
 * discipline (money.md §2) requires pinning the seam being moved, so this
 * file fills that gap for the moved seam, not just the branches the HTTP
 * suites happened to reach.
 */

const BASE_REQUEST = {
  resourceUrl: 'https://merchant.example/resource',
  fundingTo: '0x' + 'aa'.repeat(20),
  merchantTo: '0x' + 'bb'.repeat(20),
  amountRaw: '100000',
  tokenAddress: '0x' + 'cc'.repeat(20),
  network: 'eip155:8453',
  facilitatorAddresses: undefined as string[] | undefined,
}

function matchingExisting(overrides: Record<string, unknown> = {}) {
  return {
    x402_resource_url: BASE_REQUEST.resourceUrl,
    to_address: BASE_REQUEST.fundingTo,
    x402_merchant_address: BASE_REQUEST.merchantTo,
    amount_raw: BASE_REQUEST.amountRaw,
    token_address: BASE_REQUEST.tokenAddress,
    machine_metadata: { network: BASE_REQUEST.network },
    prepared_user_op: null,
    ...overrides,
  }
}

describe('existingX402IntentMismatch (#961)', () => {
  it('returns null — no mismatch — when every field matches', () => {
    expect(existingX402IntentMismatch(matchingExisting(), BASE_REQUEST)).toBeNull()
  })

  it('detects a resource_url mismatch (untested by the pre-#996 HTTP suites)', () => {
    const existing = matchingExisting({ x402_resource_url: 'https://other.example/resource' })
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBe('resource_url')
  })

  it('falls back to payment_resource_url when x402_resource_url is absent', () => {
    const existing = matchingExisting({ x402_resource_url: undefined, payment_resource_url: 'https://other.example/resource' })
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBe('resource_url')
  })

  it('detects a funding_to (payTo) mismatch, case-insensitively', () => {
    const existing = matchingExisting({ to_address: '0x' + 'ff'.repeat(20) })
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBe('funding_to')
    // Same address, different case — NOT a mismatch.
    const sameCaseInsensitive = matchingExisting({ to_address: BASE_REQUEST.fundingTo.toUpperCase() })
    expect(existingX402IntentMismatch(sameCaseInsensitive, BASE_REQUEST)).toBeNull()
  })

  it('detects a merchant_to mismatch (untested by the pre-#996 HTTP suites)', () => {
    const existing = matchingExisting({ x402_merchant_address: '0x' + 'ee'.repeat(20) })
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBe('merchant_to')
  })

  it('falls back to merchant_address when x402_merchant_address is absent', () => {
    const existing = matchingExisting({ x402_merchant_address: undefined, merchant_address: '0x' + 'ee'.repeat(20) })
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBe('merchant_to')
  })

  it('detects an amount mismatch', () => {
    const existing = matchingExisting({ amount_raw: '999' })
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBe('amount')
  })

  it('detects an asset (token address) mismatch (untested by the pre-#996 HTTP suites)', () => {
    const existing = matchingExisting({ token_address: '0x' + 'dd'.repeat(20) })
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBe('asset')
  })

  it('detects a network mismatch (untested by the pre-#996 HTTP suites)', () => {
    const existing = matchingExisting({ machine_metadata: { network: 'eip155:84532' } })
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBe('network')
  })

  it('parses machine_metadata when it is stored as a JSON string, not an object', () => {
    const existing = matchingExisting({ machine_metadata: JSON.stringify({ network: 'eip155:84532' }) })
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBe('network')
  })

  it('detects a facilitatorAddresses rotation (#1058) — stored vs requested, order-sensitive', () => {
    const requested = { ...BASE_REQUEST, facilitatorAddresses: ['0x' + '11'.repeat(20)] }
    const existing = matchingExisting({ prepared_user_op: { facilitatorAddresses: ['0x' + '22'.repeat(20)] } })
    expect(existingX402IntentMismatch(existing, requested)).toBe('facilitator_addresses')
    // Same facilitators — no mismatch.
    const sameFacilitators = matchingExisting({ prepared_user_op: { facilitatorAddresses: ['0x' + '11'.repeat(20)] } })
    expect(existingX402IntentMismatch(sameFacilitators, requested)).toBeNull()
  })

  it('treats absent stored facilitators and an undefined request as equal (3009-mode parity)', () => {
    const existing = matchingExisting({ prepared_user_op: { sender: '0x' + 'aa'.repeat(20) } }) // no facilitatorAddresses key
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBeNull()
  })

  it('checks resource_url BEFORE funding_to — evaluation order, not just each branch in isolation', () => {
    // Both fields differ; the function must report the FIRST one in its
    // if-chain. A refactor that reorders the checks would flip which reason
    // comes back, and no single-branch test above would catch that reorder.
    const existing = matchingExisting({
      x402_resource_url: 'https://other.example/resource',
      to_address: '0x' + 'ff'.repeat(20),
    })
    expect(existingX402IntentMismatch(existing, BASE_REQUEST)).toBe('resource_url')
  })

  it('checks facilitator_addresses LAST — after every other field has passed', () => {
    const requested = { ...BASE_REQUEST, facilitatorAddresses: ['0x' + '11'.repeat(20)] }
    const existing = matchingExisting({
      amount_raw: '999', // an earlier-checked mismatch
      prepared_user_op: { facilitatorAddresses: ['0x' + '22'.repeat(20)] }, // also mismatched
    })
    expect(existingX402IntentMismatch(existing, requested)).toBe('amount')
  })
})

describe('isPositiveDecimalAtomicAmount', () => {
  it('accepts a positive decimal-integer string', () => {
    expect(isPositiveDecimalAtomicAmount('1')).toBe(true)
    expect(isPositiveDecimalAtomicAmount('100000')).toBe(true)
  })

  it('rejects zero, negatives, decimals, and non-numeric strings', () => {
    expect(isPositiveDecimalAtomicAmount('0')).toBe(false)
    expect(isPositiveDecimalAtomicAmount('-1')).toBe(false)
    expect(isPositiveDecimalAtomicAmount('1.5')).toBe(false)
    expect(isPositiveDecimalAtomicAmount('abc')).toBe(false)
    expect(isPositiveDecimalAtomicAmount('')).toBe(false)
  })
})

describe('chainIdFromX402Network', () => {
  it('maps the bare "base" alias to 8453', () => {
    expect(chainIdFromX402Network('base')).toBe(8453)
  })

  it('parses a CAIP-2 eip155 network id', () => {
    expect(chainIdFromX402Network('eip155:84532')).toBe(84532)
  })

  it('rejects unrecognized network strings', () => {
    expect(chainIdFromX402Network('solana:mainnet')).toBeNull()
    expect(chainIdFromX402Network('eip155:not-a-number')).toBeNull()
    expect(chainIdFromX402Network('')).toBeNull()
  })
})

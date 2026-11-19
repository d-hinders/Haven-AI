import { describe, expect, it } from 'vitest'
import {
  CHECKOUT_DETAILS_BUDGET_BYTES,
  CHECKOUT_DETAILS_EXTENSION,
  HEADER_BLOCK_CEILING_BYTES,
  X_CHECKOUT_DETAILS_HEADER,
  decideCheckoutDetails,
  estimatePaidHeaderBlockBytes,
  parseCheckoutDetailsRequest,
  withCheckoutDetailsHeader,
  withinHeaderBlock,
  type CheckoutAddress,
  type CheckoutDetailsValues,
} from './checkout-details.js'
import type { X402PaymentOption } from './types.js'

/**
 * #4872, the pure half of `docs/architecture/13-checkout-details.md`: reading
 * the merchant's request (§2), building the answer within its budget (§3),
 * and the header-block check (§3 *The size check*).
 */

const ask = (fields: Record<string, unknown>, version: unknown = 1) => ({
  [CHECKOUT_DETAILS_EXTENSION]: { info: { version, fields } },
})

const decode = (header: string) => JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>

const ADDRESS: CheckoutAddress = { line1: 'Sveavägen 1', city: 'Stockholm', postCode: '111 57', country: 'SE' }
const STORED: CheckoutDetailsValues = { receipt_email: 'owner@example.se', billing_address: ADDRESS, shipping_address: ADDRESS }

/** The largest address the shape allows (§2's maxima). */
const MAX_ADDRESS: CheckoutAddress = {
  line1: 'a'.repeat(70),
  line2: 'b'.repeat(70),
  line3: 'c'.repeat(70),
  city: 'd'.repeat(50),
  postCode: 'e'.repeat(16),
  subdivision: 'SE-ABC',
  country: 'SE',
}
const MAX_EMAIL = `${'x'.repeat(242)}@example.com` // 254 characters

describe('reading the merchant request (§2)', () => {
  it('reads the fields and their required flags, in the merchant’s order', () => {
    expect(
      parseCheckoutDetailsRequest(ask({ shipping_address: { required: false }, receipt_email: { required: true } })),
    ).toEqual({
      fields: [
        { name: 'shipping_address', required: false },
        { name: 'receipt_email', required: true },
      ],
    })
  })

  it('is no request when there is no entry, or no extensions at all', () => {
    expect(parseCheckoutDetailsRequest(undefined)).toBeNull()
    expect(parseCheckoutDetailsRequest({})).toBeNull()
    expect(parseCheckoutDetailsRequest({ bazaar: { info: {} } })).toBeNull()
  })

  it('ignores an unknown field name, and a request of unknown names only is no request', () => {
    expect(parseCheckoutDetailsRequest(ask({ phone: { required: true }, receipt_email: { required: false } }))).toEqual({
      fields: [{ name: 'receipt_email', required: false }],
    })
    expect(parseCheckoutDetailsRequest(ask({ phone: { required: true } }))).toBeNull()
  })

  it('treats every malformed entry as no request, never as a half-read one', () => {
    const malformed: unknown[] = [
      { [CHECKOUT_DETAILS_EXTENSION]: 'yes please' },
      { [CHECKOUT_DETAILS_EXTENSION]: {} },
      { [CHECKOUT_DETAILS_EXTENSION]: { info: 'x' } },
      ask({ receipt_email: { required: true } }, 2),
      ask({ receipt_email: { required: true } }, '1'),
      { [CHECKOUT_DETAILS_EXTENSION]: { info: { version: 1, fields: ['receipt_email'] } } },
      ask({ receipt_email: true }),
      ask({ receipt_email: { required: 'true' } }),
      ask({ receipt_email: {} }),
      // An unknown-but-malformed field still makes the entry unreadable.
      ask({ receipt_email: { required: true }, phone: 'required' }),
    ]
    for (const extensions of malformed) expect(parseCheckoutDetailsRequest(extensions), JSON.stringify(extensions)).toBeNull()
  })
})

describe('building the answer (§3, §5)', () => {
  it('sends only the fields the merchant asked for', () => {
    const decision = decideCheckoutDetails(
      parseCheckoutDetailsRequest(ask({ receipt_email: { required: true } })),
      { available: true, values: STORED },
    )
    expect(decision.kind).toBe('answer')
    if (decision.kind !== 'answer' || !decision.header) throw new Error('expected an answer')
    expect(decode(decision.header)).toEqual({ version: 1, receipt_email: 'owner@example.se' })
    expect(decision.header).not.toMatch(/[+/=]/) // base64url, no padding
  })

  it('keeps non-ASCII values intact through the encoding', () => {
    const decision = decideCheckoutDetails(parseCheckoutDetailsRequest(ask({ billing_address: { required: false } })), {
      available: true,
      values: STORED,
    })
    if (decision.kind !== 'answer' || !decision.header) throw new Error('expected an answer')
    expect((decode(decision.header).billing_address as CheckoutAddress).line1).toBe('Sveavägen 1')
  })

  it('no request: nothing to decide', () => {
    expect(decideCheckoutDetails(null, { available: true, values: STORED })).toEqual({ kind: 'none' })
  })

  it('an optional field that cannot be shared is omitted and the purchase proceeds', () => {
    const decision = decideCheckoutDetails(parseCheckoutDetailsRequest(ask({ receipt_email: { required: false } })), {
      available: false,
      reason: 'not_shared',
    })
    expect(decision).toEqual({ kind: 'answer', header: undefined, sentFields: [], omitted: [{ name: 'receipt_email', reason: 'not_shared' }] })
  })

  it('a required field that cannot be shared refuses, naming every missing required field and the reason', () => {
    const request = parseCheckoutDetailsRequest(
      ask({ receipt_email: { required: true }, billing_address: { required: true }, shipping_address: { required: false } }),
    )
    for (const reason of ['not_shared', 'feature_disabled', 'unreadable', 'backend_unsupported'] as const) {
      expect(decideCheckoutDetails(request, { available: false, reason })).toEqual({
        kind: 'refuse',
        missingFields: ['receipt_email', 'billing_address'],
        reason,
      })
    }
  })

  it('a required field the owner has not saved refuses as not_stored, and the saved ones are not sent', () => {
    const decision = decideCheckoutDetails(
      parseCheckoutDetailsRequest(ask({ receipt_email: { required: false }, billing_address: { required: true } })),
      { available: true, values: { receipt_email: 'owner@example.se' } },
    )
    expect(decision).toEqual({ kind: 'refuse', missingFields: ['billing_address'], reason: 'not_stored' })
  })

  it('fits the largest answer the shape allows within the 1,536-byte budget (§3: 1,426 bytes)', () => {
    const decision = decideCheckoutDetails(
      parseCheckoutDetailsRequest(
        ask({ receipt_email: { required: true }, billing_address: { required: true }, shipping_address: { required: true } }),
      ),
      { available: true, values: { receipt_email: MAX_EMAIL, billing_address: MAX_ADDRESS, shipping_address: MAX_ADDRESS } },
    )
    if (decision.kind !== 'answer' || !decision.header) throw new Error('expected an answer')
    expect(decision.sentFields).toEqual(['receipt_email', 'billing_address', 'shipping_address'])
    expect(decision.header.length).toBeLessThanOrEqual(CHECKOUT_DETAILS_BUDGET_BYTES)
    expect(decision.header.length).toBe(1426)
  })

  it('over the budget: an optional field is omitted, a required one refuses', () => {
    const values = { receipt_email: 'owner@example.se', billing_address: MAX_ADDRESS }
    const optional = decideCheckoutDetails(
      parseCheckoutDetailsRequest(ask({ receipt_email: { required: true }, billing_address: { required: false } })),
      { available: true, values },
      100,
    )
    expect(optional.kind).toBe('answer')
    if (optional.kind !== 'answer') throw new Error('expected an answer')
    expect(optional.sentFields).toEqual(['receipt_email'])
    expect(optional.omitted).toEqual([{ name: 'billing_address', reason: 'over_budget' }])

    expect(
      decideCheckoutDetails(parseCheckoutDetailsRequest(ask({ billing_address: { required: true } })), { available: true, values }, 100),
    ).toEqual({ kind: 'refuse', missingFields: ['billing_address'], reason: 'over_budget' })
  })
})

describe('the header block (§3)', () => {
  const accepted: X402PaymentOption = {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '10000',
    payTo: `0x${'12'.repeat(20)}`,
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  }
  const resource = { url: 'https://merchant.test/paid', description: 'paid', mimeType: 'application/json' }

  it('estimates the design’s EIP-3009 case well under the ceiling, and erc7710 above EIP-3009', () => {
    const extensions = ask({ receipt_email: { required: true } })
    const eip = estimatePaidHeaderBlockBytes({ paymentRequired: { x402Version: 2, resource, extensions }, accepted, isErc7710: false, answerHeader: 'a'.repeat(1426) })
    const erc = estimatePaidHeaderBlockBytes({ paymentRequired: { x402Version: 2, resource, extensions }, accepted, isErc7710: true, answerHeader: 'a'.repeat(1426) })
    expect(eip).toBeLessThan(HEADER_BLOCK_CEILING_BYTES / 2)
    expect(erc).toBeGreaterThan(eip)
    expect(erc).toBeLessThan(HEADER_BLOCK_CEILING_BYTES)
  })

  it('over the ceiling: a required field sent refuses before paying; with only optional fields the answer is dropped', () => {
    const answer = { kind: 'answer' as const, header: 'h'.repeat(100), sentFields: ['receipt_email' as const], omitted: [] }
    const over = () => HEADER_BLOCK_CEILING_BYTES + 1
    expect(withinHeaderBlock(answer, parseCheckoutDetailsRequest(ask({ receipt_email: { required: true } })), over)).toEqual({
      kind: 'refuse',
      missingFields: ['receipt_email'],
      reason: 'over_budget',
    })
    expect(withinHeaderBlock(answer, parseCheckoutDetailsRequest(ask({ receipt_email: { required: false } })), over)).toEqual({
      kind: 'answer',
      header: undefined,
      sentFields: [],
      omitted: [{ name: 'receipt_email', reason: 'over_budget' }],
    })
    // Under the ceiling: untouched.
    expect(withinHeaderBlock(answer, null, () => HEADER_BLOCK_CEILING_BYTES)).toBe(answer)
  })
})

describe('the attach site', () => {
  it('sets the header, and removes a stale one when there is no answer', () => {
    expect(new Headers(withCheckoutDetailsHeader({ method: 'GET' }, 'abc').headers).get(X_CHECKOUT_DETAILS_HEADER)).toBe('abc')
    const stale = withCheckoutDetailsHeader({ headers: { [X_CHECKOUT_DETAILS_HEADER]: 'old', accept: 'x' } }, undefined)
    expect(new Headers(stale.headers).has(X_CHECKOUT_DETAILS_HEADER)).toBe(false)
    expect(new Headers(stale.headers).get('accept')).toBe('x')
    const untouched = { method: 'GET' }
    expect(withCheckoutDetailsHeader(untouched, undefined)).toBe(untouched)
  })
})

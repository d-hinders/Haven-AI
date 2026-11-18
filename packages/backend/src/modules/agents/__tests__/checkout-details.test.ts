/**
 * Pure rule tests for the checkout-details read decision (#4871, epic #4868).
 * No db, no config, no clock — every fact is a parameter.
 *
 * Covered, per the issue's acceptance list:
 * - the closed three-reason vocabulary, each reason the FIRST fact that
 *   failed (`feature_disabled` before `disabled` before `no_details`);
 * - the stored receipt email, billing address and shipping address returned
 *   under the names and address shape `docs/architecture/13-checkout-details.md`
 *   §2 decides;
 * - a field the owner has not saved is OMITTED, never `null` — in particular
 *   the read NEVER falls back to the sign-up email (sharing on, no receipt
 *   email saved → no `receipt_email` key);
 * - the switch may be on with nothing stored (`no_details`), and one stored
 *   field is enough for `available: true`.
 */
import { describe, expect, it } from 'vitest'
import {
  resolveCheckoutDetails,
  type CheckoutDetailsFacts,
} from '../checkout-details.js'

const BILLING = {
  line1: 'Sveavagen 1',
  line2: '4 tr',
  city: 'Stockholm',
  postCode: '111 57',
  subdivision: 'SE-AB',
  country: 'SE',
}

const SHIPPING = { line1: 'Storgatan 2', city: 'Goteborg', country: 'SE' }

const BASE: CheckoutDetailsFacts = {
  featureEnabled: true,
  sharingEnabled: true,
  receipt_email: 'billing@acme.se',
  billing_address: BILLING,
  shipping_address: SHIPPING,
}

describe('resolveCheckoutDetails — the three reasons', () => {
  it('feature flag off → feature_disabled, before every other fact', () => {
    const result = resolveCheckoutDetails({ ...BASE, featureEnabled: false })
    expect(result).toEqual({ available: false, reason: 'feature_disabled' })
  })

  it('sharing off → disabled, even with every field stored', () => {
    const result = resolveCheckoutDetails({ ...BASE, sharingEnabled: false })
    expect(result).toEqual({ available: false, reason: 'disabled' })
  })

  it('sharing on with nothing stored → no_details', () => {
    const result = resolveCheckoutDetails({
      ...BASE,
      receipt_email: null,
      billing_address: null,
      shipping_address: null,
    })
    expect(result).toEqual({ available: false, reason: 'no_details' })
  })

  it('an empty-string receipt email counts as not stored', () => {
    const result = resolveCheckoutDetails({
      ...BASE,
      receipt_email: '',
      billing_address: null,
      shipping_address: null,
    })
    expect(result).toEqual({ available: false, reason: 'no_details' })
  })
})

describe('resolveCheckoutDetails — the content', () => {
  it('returns all three stored fields under the decided names and address shape', () => {
    expect(resolveCheckoutDetails(BASE)).toEqual({
      available: true,
      checkout_details: {
        receipt_email: 'billing@acme.se',
        billing_address: BILLING,
        shipping_address: SHIPPING,
      },
    })
  })

  it('omits a field the owner has not saved — never `null`', () => {
    const result = resolveCheckoutDetails({ ...BASE, shipping_address: null })
    expect(result).toEqual({
      available: true,
      checkout_details: {
        receipt_email: 'billing@acme.se',
        billing_address: BILLING,
      },
    })
    expect(result).not.toHaveProperty('checkout_details.shipping_address')
  })

  it('sharing on with no receipt email saved has NO email — never the sign-up email', () => {
    const result = resolveCheckoutDetails({ ...BASE, receipt_email: null })
    expect(result.available).toBe(true)
    if (!result.available) throw new Error('unreachable')
    expect(result.checkout_details).not.toHaveProperty('receipt_email')
    expect(result.checkout_details.billing_address).toEqual(BILLING)
    expect(result.checkout_details.shipping_address).toEqual(SHIPPING)
  })

  it('one stored field is enough for available: true', () => {
    const result = resolveCheckoutDetails({
      ...BASE,
      receipt_email: null,
      billing_address: null,
      shipping_address: SHIPPING,
    })
    expect(result).toEqual({
      available: true,
      checkout_details: { shipping_address: SHIPPING },
    })
  })

  it('passes the stored address object through verbatim (no reshaping)', () => {
    const result = resolveCheckoutDetails(BASE)
    if (!result.available) throw new Error('unreachable')
    expect(result.checkout_details.billing_address).toBe(BILLING)
    expect(result.checkout_details.shipping_address).toBe(SHIPPING)
  })
})

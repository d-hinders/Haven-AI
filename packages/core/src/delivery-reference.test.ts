import { describe, expect, it } from 'vitest'
import {
  DELIVERY_REFERENCE_MAX_LENGTH,
  deliveryReferenceError,
  deliveryReferenceLooksLikeSecret,
} from './delivery-reference.js'

describe('deliveryReferenceLooksLikeSecret — #3778', () => {
  const HONEST_REFERENCES = [
    'Bik Bok 5 SEK, order 6ac7',
    'Bik Bok 5 SEK gift card, order 6ac7f3b2',
    'ORD-2026-10-08-001',
    'INV 88123',
    'Bitrefill delivery, invoice ff28c928',
    '1x coffee voucher, merchant order #A1042',
  ]

  it('accepts honest order/product references', () => {
    for (const ref of HONEST_REFERENCES) {
      expect(deliveryReferenceLooksLikeSecret(ref), ref).toBe(false)
    }
  })

  it('refuses a code-shaped value (the acceptance-criterion test)', () => {
    // A redemption-code shape: dense mixed-case token material with digits.
    expect(deliveryReferenceLooksLikeSecret('aB3xK9mQ2pL7vR4t')).toBe(true)
    // A grouped uppercase gift-card code.
    expect(deliveryReferenceLooksLikeSecret('GRBQ-KX4M-9P2T-7WZC')).toBe(true)
    expect(deliveryReferenceLooksLikeSecret('BIK5-BOOK-77X2-QQ41')).toBe(true)
  })

  it('refuses known credential shapes', () => {
    expect(
      deliveryReferenceLooksLikeSecret(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      ),
    ).toBe(true)
    expect(deliveryReferenceLooksLikeSecret('sk_live_51H8xYq2eZvKYlo2C')).toBe(true)
    expect(deliveryReferenceLooksLikeSecret('ghp_16CharactersFineButLongerIsBetter')).toBe(true)
    expect(deliveryReferenceLooksLikeSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true)
    // 64-hex — raw key or private material.
    expect(deliveryReferenceLooksLikeSecret('a'.repeat(64))).toBe(true)
    // Long base64ish token with letters and digits.
    expect(deliveryReferenceLooksLikeSecret('c2VjcmV0LXRva2VuLW1hdGVyaWFsMTIz')).toBe(true)
  })

  it('does not fire on short or prose-shaped values', () => {
    expect(deliveryReferenceLooksLikeSecret('order 6ac7')).toBe(false)
    expect(deliveryReferenceLooksLikeSecret('BIKBOK')).toBe(false)
    expect(deliveryReferenceLooksLikeSecret('')).toBe(false)
    expect(deliveryReferenceLooksLikeSecret('   ')).toBe(false)
  })

  it('bounds the field at 512 characters', () => {
    expect(DELIVERY_REFERENCE_MAX_LENGTH).toBe(512)
    expect(deliveryReferenceError('x'.repeat(513))).toMatch(/at most 512/)
    expect(deliveryReferenceError('x'.repeat(512))).toBeNull()
  })

  it('deliveryReferenceError names the relay rule on a secret-shaped value', () => {
    const err = deliveryReferenceError('GRBQ-KX4M-9P2T-7WZC')
    expect(err).toMatch(/refused/)
    expect(err).toMatch(/relay the secret/)
    expect(deliveryReferenceError('Bik Bok 5 SEK, order 6ac7')).toBeNull()
  })
})

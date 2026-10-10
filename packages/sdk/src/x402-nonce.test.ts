import { describe, expect, it } from 'vitest'
import { deriveX402PaymentNonce, X402_PAYMENT_NONCE_TAG } from './x402-nonce.js'

describe('deriveX402PaymentNonce', () => {
  // #3888: the encoding is pinned by test vector — keccak256 over the UTF-8
  // bytes of the tag followed immediately by the UTF-8 bytes of the payment
  // id, no separator byte, no length prefix. If this value ever changes, the
  // derivation changed, and every settlement recorded before it is
  // attributable only under the OLD derivation.
  it('matches the pinned test vector', () => {
    expect(deriveX402PaymentNonce('pi_3888_vector')).toBe(
      '0x722b47e0f7ad8ca7d63bfd4219ca254614858674ddb61bbc1b4a3ed210483886',
    )
  })

  it('returns the x402 nonce shape: 0x + 64 hex characters (32 bytes)', () => {
    const nonce = deriveX402PaymentNonce('pi_3888_vector')
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('is a pure function — same id, same nonce, on every surface', () => {
    expect(deriveX402PaymentNonce('same-id')).toBe(deriveX402PaymentNonce('same-id'))
  })

  it('distinguishes payment ids', () => {
    expect(deriveX402PaymentNonce('one')).not.toBe(deriveX402PaymentNonce('two'))
  })

  // The tag ends with `:` precisely so a tag/id boundary can never be
  // confused across two ids whose concatenations would otherwise collide.
  it('does not let the tag boundary blur two different ids', () => {
    expect(deriveX402PaymentNonce('a:b')).not.toBe(deriveX402PaymentNonce('a'))
    expect(deriveX402PaymentNonce('a:b')).not.toBe(deriveX402PaymentNonce(':b'))
  })

  it('keeps the tag the documented constant', () => {
    // The tag is part of the pinned encoding — changing it orphans every
    // settlement not yet detected. Rename it only through a migration of the
    // detection path, never by editing the value in place.
    expect(X402_PAYMENT_NONCE_TAG).toBe('haven-x402-payment-nonce:')
  })
})

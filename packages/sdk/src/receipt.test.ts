import { describe, it, expect } from 'vitest'
import { Wallet } from 'ethers'
import {
  verifyPaymentReceipt,
  RECEIPT_VERSION,
  type PaymentReceipt,
} from './receipt.js'

const DELEGATE = new Wallet(`0x${'11'.repeat(32)}`)
const SIGN_HASH = `0x${'ab'.repeat(32)}`

function receipt(over: Partial<PaymentReceipt['authorization']> = {}): PaymentReceipt {
  return {
    version: RECEIPT_VERSION,
    paymentId: 'pi1',
    payment: {
      token: 'xDAI',
      tokenAddress: '0x0000000000000000000000000000000000000000',
      amount: '1',
      amountSek: '10.60',
      recipient: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
      safe: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      chainId: 100,
      settledAt: '2026-06-20T10:00:00.000Z',
      resourceUrl: 'https://api.example/resource',
    },
    authorization: { delegate: DELEGATE.address, signHash: SIGN_HASH, signature: null, ...over },
    onChain: { txHash: `0x${'cd'.repeat(32)}`, chainId: 100 },
  }
}

describe('verifyPaymentReceipt (client-side, no Haven trust)', () => {
  it('verifies a receipt whose signature recovers to the delegate', () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    const result = verifyPaymentReceipt(receipt({ signature }))
    expect(result.verified).toBe(true)
    if (result.verified) expect(result.recoveredSigner.toLowerCase()).toBe(DELEGATE.address.toLowerCase())
  })

  it('rejects a receipt with no signature', () => {
    expect(verifyPaymentReceipt(receipt({ signature: null }))).toMatchObject({
      verified: false,
      reason: 'missing_signature',
    })
  })

  it('rejects a signature that recovers to a non-delegate address', () => {
    const other = new Wallet(`0x${'22'.repeat(32)}`)
    const signature = other.signingKey.sign(SIGN_HASH).serialized
    expect(verifyPaymentReceipt(receipt({ signature }))).toMatchObject({
      verified: false,
      reason: 'signer_mismatch',
    })
  })

  it('rejects a malformed signature', () => {
    expect(verifyPaymentReceipt(receipt({ signature: '0xnope' }))).toMatchObject({
      verified: false,
      reason: 'bad_signature',
    })
  })

  it('uses the default recover when none is injected (runs with no deps wired)', () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    expect(verifyPaymentReceipt(receipt({ signature })).verified).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { Wallet } from 'ethers'
import {
  buildPaymentReceipt,
  verifyPaymentReceipt,
  RECEIPT_VERSION,
  type PaymentReceiptRow,
} from '../receipt.js'
import { recoverSigner } from '../allowance-module.js'

const DELEGATE = new Wallet(`0x${'11'.repeat(32)}`)
const SIGN_HASH = `0x${'ab'.repeat(32)}`

function row(over: Partial<PaymentReceiptRow> = {}): PaymentReceiptRow {
  return {
    id: 'pi1',
    safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    chain_id: 100,
    token_symbol: 'xDAI',
    token_address: '0x0000000000000000000000000000000000000000',
    to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    amount_human: '1',
    delegate_address: DELEGATE.address,
    sign_hash: SIGN_HASH,
    signature: null,
    tx_hash: `0x${'cd'.repeat(32)}`,
    confirmed_at: '2026-06-20T10:00:00.000Z',
    resource_url: 'https://api.example/resource',
    amount_sek: '10.60',
    ...over,
  }
}

/** A real ECDSA signature of SIGN_HASH by the delegate key. */
async function signByDelegate(hash = SIGN_HASH): Promise<string> {
  return DELEGATE.signingKey.sign(hash).serialized
}

describe('buildPaymentReceipt', () => {
  it('assembles a versioned bundle with payment, authorization, and on-chain parts', () => {
    const r = buildPaymentReceipt(row({ signature: '0xsig' }))
    expect(r.version).toBe(RECEIPT_VERSION)
    expect(r.paymentId).toBe('pi1')
    expect(r.payment).toMatchObject({ token: 'xDAI', amount: '1', amountSek: '10.60', recipient: row().to_address })
    expect(r.authorization).toEqual({ delegate: DELEGATE.address, signHash: SIGN_HASH, signature: '0xsig' })
    expect(r.onChain).toEqual({ txHash: row().tx_hash, chainId: 100 })
  })
})

describe('verifyPaymentReceipt (independently of Haven)', () => {
  it('verifies a receipt whose signature recovers to the delegate', async () => {
    const signature = await signByDelegate()
    const result = verifyPaymentReceipt(buildPaymentReceipt(row({ signature })), recoverSigner)
    expect(result.verified).toBe(true)
    if (result.verified) expect(result.recoveredSigner.toLowerCase()).toBe(DELEGATE.address.toLowerCase())
  })

  it('rejects a receipt with no signature', () => {
    const result = verifyPaymentReceipt(buildPaymentReceipt(row({ signature: null })))
    expect(result).toMatchObject({ verified: false, reason: 'missing_signature' })
  })

  it('rejects a signature that recovers to someone other than the delegate', async () => {
    // Signed by a different key → recovers to a non-delegate address.
    const other = new Wallet(`0x${'22'.repeat(32)}`)
    const signature = other.signingKey.sign(SIGN_HASH).serialized
    const result = verifyPaymentReceipt(buildPaymentReceipt(row({ signature })), recoverSigner)
    expect(result.verified).toBe(false)
    if (!result.verified) expect(result.reason).toBe('signer_mismatch')
  })

  it('rejects a malformed signature', () => {
    const result = verifyPaymentReceipt(buildPaymentReceipt(row({ signature: '0xnotasignature' })), recoverSigner)
    expect(result).toMatchObject({ verified: false, reason: 'bad_signature' })
  })
})

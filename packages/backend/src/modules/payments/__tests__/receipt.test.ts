import { describe, it, expect } from 'vitest'
import { Wallet } from 'ethers'
import {
  buildPaymentReceipt,
  verifyPaymentReceipt,
  RECEIPT_VERSION,
  type PaymentReceiptRow,
} from '../receipt.js'

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

describe('buildPaymentReceipt (backend DB mapping)', () => {
  it('assembles a versioned bundle with payment, authorization, and on-chain parts', () => {
    const r = buildPaymentReceipt(row({ signature: '0xsig' }))
    expect(r.version).toBe(RECEIPT_VERSION)
    expect(r.paymentId).toBe('pi1')
    expect(r.payment).toMatchObject({ token: 'xDAI', amount: '1', amountSek: '10.60', recipient: row().to_address })
    expect(r.authorization).toEqual({ delegate: DELEGATE.address, signHash: SIGN_HASH, signature: '0xsig' })
    expect(r.onChain).toEqual({ txHash: row().tx_hash, chainId: 100 })
  })

  it('produces a receipt that verifies via the SDK verifier (end-to-end)', () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    const receipt = buildPaymentReceipt(row({ signature }))
    expect(verifyPaymentReceipt(receipt).verified).toBe(true)
  })
})

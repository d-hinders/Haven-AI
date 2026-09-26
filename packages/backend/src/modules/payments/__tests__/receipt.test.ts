import { afterEach, describe, it, expect } from 'vitest'
import { Wallet } from 'ethers'
import { config } from '../../../config.js'
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
    account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
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

  // #2907: payment.account twins payment.safe (same value) — additive,
  // outside the SDK's typed PaymentReceipt['payment'] shape, so asserted at
  // the JS-object level rather than through the TS type. Mutation-proven by
  // dropping the `account: row.account_address` line in receipt.ts.
  it('#2907: payment.account is a same-value twin of payment.safe', () => {
    const r = buildPaymentReceipt(row({ signature: '0xsig' })) as unknown as {
      payment: { safe: string; account: string }
    }
    expect(r.payment.account).toBe(r.payment.safe)
    expect(r.payment.account).toBe('0x135a9215604711AC70d970e12Caa812c53537EF4')
  })

  it('#2907: verification still passes with the additive payment.account field present (signHash is stored, not recomputed over payment)', () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    const receipt = buildPaymentReceipt(row({ signature }))
    expect(verifyPaymentReceipt(receipt).verified).toBe(true)
  })

  // #3332 review M2 — the FLAG WIRING in this file, not just
  // `buyerPartyFromJoin`'s own pure test: a row that carries buyer_* columns
  // must not surface `parties.buyer` when `config.ownerCompanyDetailsEnabled`
  // is false, and must surface it (present, never present-and-null) when
  // true. Mutation-proven: replacing `config.ownerCompanyDetailsEnabled` with
  // a literal `true` at this file's call site would make the "off" case
  // below fail.
  describe('#3332: parties.buyer flag wiring', () => {
    const originalFlag = config.ownerCompanyDetailsEnabled

    afterEach(() => {
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = originalFlag
    })

    const buyerRow = row({
      buyer_legal_name: 'Acme AB',
      buyer_country: 'SE',
      buyer_org_number: '556677-8899',
      buyer_vat_number: 'SE556677889901',
      buyer_vies_status: 'valid',
      buyer_vies_checked_at: '2026-09-20T10:00:00.000Z',
    })

    it('flag OFF: parties has no "buyer" key at all, even with a fully-populated join', () => {
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false
      const r = buildPaymentReceipt(buyerRow) as unknown as { payment: { parties: Record<string, unknown> } }
      expect('buyer' in r.payment.parties).toBe(false)
    })

    it('flag ON: parties.buyer is present and shaped correctly', () => {
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
      const r = buildPaymentReceipt(buyerRow) as unknown as {
        payment: { parties: { buyer?: Record<string, unknown> } }
      }
      expect(r.payment.parties.buyer).toEqual({
        legal_name: 'Acme AB',
        country: 'SE',
        org_number: '556677-8899',
        vat_number: 'SE556677889901',
        vies_status: 'valid',
        vies_checked_at: '2026-09-20T10:00:00.000Z',
      })
    })

    it('flag ON but no saved details (join columns null): still no "buyer" key', () => {
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
      const r = buildPaymentReceipt(row()) as unknown as { payment: { parties: Record<string, unknown> } }
      expect('buyer' in r.payment.parties).toBe(false)
    })
  })
})

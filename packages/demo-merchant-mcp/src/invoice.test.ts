import { describe, expect, it } from 'vitest'
import { generateInvoice, renderInvoiceText } from './invoice.js'

const BASE_PARAMS = {
  invoiceNumber: 'FAK-2026-00099',
  productId: 'storage_50gb' as const,
  buyerAddress: '0x2222222222222222222222222222222222222222',
  authorizationNonce: `0x${'ab'.repeat(32)}`,
  txHash: `0x${'cd'.repeat(32)}` as const,
  settlement: 'settled_onchain' as const,
}

/**
 * #2960: the merchant only ever observes the address it verified the
 * payment FROM — the delegate EOA on `eip3009`, the delegate SMART account
 * (`delegator`) on `erc7710` — never the owner's treasury account, which
 * never appears in the x402 payload on either scheme (F1, quality scan
 * 2026-09-13). `payerRole` carries that distinction onto the invoice
 * instead of an unqualified "buyer".
 */
describe('generateInvoice — party role (#2960)', () => {
  it('eip3009: kopare.roll is agent_delegate', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate' })
    expect(invoice.json.kopare.roll).toBe('agent_delegate')
    expect(invoice.json.kopare.identifierare).toBe(BASE_PARAMS.buyerAddress)
  })

  it('erc7710: kopare.roll is agent_delegate_account', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate_account' })
    expect(invoice.json.kopare.roll).toBe('agent_delegate_account')
  })

  it('the Swedish bookkeeping render (#1550) is byte-for-byte UNCHANGED by the party-role field — no "roll" text appears in it', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate_account' })
    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    expect(sv).toContain('KÖPARE')
    expect(sv).not.toContain('Role:')
    expect(sv).not.toMatch(/agent[_ ]delegate/i)
  })

  it('the English render does NOT call a delegate-account payer "the buyer" (mutation target: reintroducing a bare BUYER header must fail this)', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate_account' })
    const en = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'en')
    expect(en).not.toContain('BUYER')
    expect(en).toContain('PAYER')
    expect(en).toContain('Role:')
    expect(en).toMatch(/agent delegate account/i)
  })

  it('the English render labels an eip3009 payer as the agent delegate, not the delegate account', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate' })
    const en = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'en')
    expect(en).not.toContain('BUYER')
    expect(en).toContain('agent delegate address (eip3009)')
    expect(en).not.toMatch(/agent delegate account/i)
  })
})

const ZERO_TX_HASH = `0x${'0'.repeat(64)}`

/**
 * #2969: `already_settled_earlier` and `settlement_unknown` are both
 * non-settled, but they are DIFFERENT facts and must render differently, and
 * neither may print the zero hash the caller still passes in `txHash`
 * (mirroring the real call site — `invoiceForPayment` always forwards
 * `payment.txHash`, which is `ZERO_TX_HASH` on both non-settled paths).
 */
describe('generateInvoice — settlement state (#2969)', () => {
  it('already_settled_earlier: no reference, its own status, no zero hash anywhere', () => {
    const invoice = generateInvoice({
      ...BASE_PARAMS,
      payerRole: 'agent_delegate',
      txHash: ZERO_TX_HASH,
      settlement: 'already_settled_earlier',
    })
    expect(invoice.json.blockkedje_referens).toBeNull()
    expect(invoice.json.status).toBe('Betald i tidigare transaktion — referens saknas')
    expect(invoice.json.status).not.toBe('Betald')
    expect(JSON.stringify(invoice.json)).not.toContain(ZERO_TX_HASH)
    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    const en = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'en')
    expect(sv).not.toContain('BLOCKKEDJEREFERENS')
    expect(sv).not.toContain(ZERO_TX_HASH)
    expect(en).not.toContain('BLOCKCHAIN REFERENCE')
    expect(en).not.toContain(ZERO_TX_HASH)
    expect(en).toContain('Paid in an earlier transaction')
  })

  it('settlement_unknown: keeps the #2970 "delivered, unconfirmed" status and omits the reference block', () => {
    const invoice = generateInvoice({
      ...BASE_PARAMS,
      payerRole: 'agent_delegate',
      txHash: ZERO_TX_HASH,
      settlement: 'settlement_unknown',
    })
    expect(invoice.json.blockkedje_referens).toBeNull()
    expect(invoice.json.status).toBe('Levererad — ej bekräftad på kedjan')
    expect(JSON.stringify(invoice.json)).not.toContain(ZERO_TX_HASH)
    // Distinct from already_settled_earlier's status string.
    expect(invoice.json.status).not.toBe('Betald i tidigare transaktion — referens saknas')
  })

  it('settled_onchain: still prints the real reference and "Betald" (unchanged behaviour)', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate' })
    expect(invoice.json.blockkedje_referens).toBe(`Tx: ${BASE_PARAMS.txHash}`)
    expect(invoice.json.status).toBe('Betald')
    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    expect(sv).toContain('BLOCKKEDJEREFERENS')
    expect(sv).toContain(BASE_PARAMS.txHash)
  })
})

import { describe, expect, it } from 'vitest'
import { buildPurchaseSummary } from './server.js'
import { PRODUCTS, formatUsdc } from './products.js'
import type { Invoice } from './invoice.js'
import type { SettledPayment } from './x402.js'

const TX_HASH = `0x${'ef'.repeat(32)}` as const

function fakeInvoice(overrides: Partial<Invoice['json']> = {}): Invoice {
  return {
    json: {
      fakturanummer: 'FAK-2026-00042',
      fakturadatum: '2026-08-11',
      forfallodatum: '2026-09-10',
      ocr_nummer: '000420000000000',
      saljare: {
        name: 'Haven Demo AB',
        address: 'Birger Jarlsgatan 57, 113 56 Stockholm',
        org_nr: '559412-3456',
        moms_nr: 'SE559412345601',
        iban: 'SE35 5000 0000 0549 1000 0003',
        bic: 'ESSESESS',
        crypto_address: '0x1111111111111111111111111111111111111111',
      },
      kopare: { identifierare: '0x2222222222222222222222222222222222222222', typ: 'blockkedjeadress' },
      rader: [],
      belopp_exkl_moms: '0.0004',
      moms_procent: 25,
      moms_belopp: '0.0001',
      totalt_inkl_moms: '0.0005',
      valuta: 'USDC',
      betalningssatt: 'Kryptovaluta (USDC på Base)',
      blockkedje_referens: `Tx: ${TX_HASH}`,
      status: 'Betald',
      ...overrides,
    },
    text: 'irrelevant for this test',
  }
}

function fakeSettledPayment(overrides: Partial<SettledPayment> = {}): SettledPayment {
  return {
    productId: 'storage_50gb',
    settlementMethod: 'eip3009',
    from: '0x2222222222222222222222222222222222222222',
    to: '0x1111111111111111111111111111111111111111',
    value: PRODUCTS.storage_50gb.price_usdc,
    nonce: `0x${'aa'.repeat(32)}`,
    txHash: TX_HASH,
    paymentResponse: { success: true, payer: '0x2222222222222222222222222222222222222222', transaction: TX_HASH, network: 'eip155:8453', amount: PRODUCTS.storage_50gb.price_usdc.toString() },
    paymentResponseHeader: 'irrelevant',
    ...overrides,
  }
}

describe('buildPurchaseSummary (#1273) — display/reporting contract', () => {
  it('reports status confirmed with the settled payment identity and invoice id', () => {
    const payment = fakeSettledPayment()
    const invoice = fakeInvoice()
    const summary = buildPurchaseSummary(payment, invoice)

    expect(summary).toEqual({
      status: 'confirmed',
      product_id: 'storage_50gb',
      product_name: PRODUCTS.storage_50gb.name,
      invoice_id: 'FAK-2026-00042',
      amount_atomic: PRODUCTS.storage_50gb.price_usdc.toString(),
      amount: formatUsdc(PRODUCTS.storage_50gb.price_usdc),
      asset: 'USDC',
      network: expect.stringMatching(/^eip155:\d+$/),
      settlement_tx_hash: TX_HASH,
    })
  })

  // Mutation-proof #2: the amount MUST be read from the settled payment, never
  // re-derived from the quoted product price. A settled payment whose value
  // differs from the catalog price (e.g. a stale/edited quote) must show up in
  // the summary as what was ACTUALLY settled on-chain.
  it('sources amount_atomic/amount from the settled payment value, not the catalog price', () => {
    const offCatalogValue = PRODUCTS.storage_50gb.price_usdc + 1n
    const payment = fakeSettledPayment({ value: offCatalogValue })
    const summary = buildPurchaseSummary(payment, fakeInvoice())

    expect(summary.amount_atomic).toBe(offCatalogValue.toString())
    expect(summary.amount).toBe(formatUsdc(offCatalogValue))
    expect(summary.amount_atomic).not.toBe(PRODUCTS.storage_50gb.price_usdc.toString())
  })

  // Mutation-proof #2: settlement_tx_hash must come from the settled payment's
  // OWN tx hash, distinct from any nonce/invoice reference in scope.
  it('sources settlement_tx_hash from the settled payment tx, not the invoice reference', () => {
    const distinctTx = `0x${'cd'.repeat(32)}` as const
    const payment = fakeSettledPayment({ txHash: distinctTx })
    const invoice = fakeInvoice({ blockkedje_referens: `Tx: ${TX_HASH}` }) // deliberately different
    const summary = buildPurchaseSummary(payment, invoice)

    expect(summary.settlement_tx_hash).toBe(distinctTx)
    expect(summary.settlement_tx_hash).not.toBe(TX_HASH)
  })

  it('does not report funding_tx_hash when it is not known merchant-side', () => {
    const summary = buildPurchaseSummary(fakeSettledPayment(), fakeInvoice())
    expect(summary.funding_tx_hash).toBeUndefined()
  })
})

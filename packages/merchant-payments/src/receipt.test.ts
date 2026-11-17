import { describe, expect, it } from 'vitest'
import {
  buildReceipt,
  generateOcr,
  receiptLineText,
  receiptNumberForTransaction,
  renderReceiptText,
  vatAmountsAtomic,
  type ReceiptParams,
} from './receipt.js'

/**
 * #4890: the receipt builder takes every merchant-specific value as a
 * parameter. These tests build a receipt for a merchant that is NOT the demo
 * merchant and check that nothing of the demo merchant's leaks through: its
 * seller, its bank details, Haven's support address, its product table or a
 * default chain.
 */
const KIT_MERCHANT: ReceiptParams = {
  invoiceNumber: receiptNumberForTransaction(`0x${'ef'.repeat(32)}`),
  line: { name: 'Inference', description: 'One chat completion, capped at 512 output tokens.', priceAtomic: 2_000n },
  seller: { name: 'Exempel AB', address: 'Storgatan 1, 111 22 Stockholm', org_nr: '556000-0000', moms_nr: 'SE556000000001' },
  receivingAddress: '0x3333333333333333333333333333333333333333',
  network: { sv: 'Base Sepolia testnät', en: 'Base Sepolia testnet' },
  vatRule: 'SE_25_WITH_EU_REVERSE_CHARGE',
  buyerAddress: '0x4444444444444444444444444444444444444444',
  payerRole: 'agent_delegate',
  txHash: `0x${'ef'.repeat(32)}`,
  settlement: 'settled_onchain',
  now: new Date('2026-11-17T12:00:00Z'),
}

describe('buildReceipt takes every merchant value as a parameter (#4890)', () => {
  it('uses the configured seller, with no bank details it was not given', () => {
    const json = buildReceipt(KIT_MERCHANT)
    expect(json.saljare).toEqual({ ...KIT_MERCHANT.seller, crypto_address: KIT_MERCHANT.receivingAddress })
    expect(Object.keys(json.saljare)).toEqual(['name', 'address', 'org_nr', 'moms_nr', 'crypto_address'])
  })

  it('keeps extra seller fields, in the order given, before crypto_address', () => {
    const json = buildReceipt({ ...KIT_MERCHANT, seller: { ...KIT_MERCHANT.seller, iban: 'SE00', bic: 'XXXX' } })
    expect(Object.keys(json.saljare)).toEqual(['name', 'address', 'org_nr', 'moms_nr', 'iban', 'bic', 'crypto_address'])
  })

  it('writes the line as name — description, with no period when none is given', () => {
    const json = buildReceipt(KIT_MERCHANT)
    expect(json.rader[0].beskrivning).toBe('Inference — One chat completion, capped at 512 output tokens.')
    expect(receiptLineText({ ...KIT_MERCHANT.line, billingPeriod: 'monthly' })).toMatch(/\(1 månad\)$/)
    expect(receiptLineText({ ...KIT_MERCHANT.line, billingPeriod: 'one_time' })).toMatch(/\(engångsköp\)$/)
  })

  it('names the network it is given', () => {
    expect(buildReceipt(KIT_MERCHANT).betalningssatt).toBe('Kryptovaluta (USDC på Base Sepolia testnät)')
  })

  it('states the VAT figures at full six-decimal precision for a sub-cent price', () => {
    const json = buildReceipt(KIT_MERCHANT)
    expect(json.totalt_inkl_moms).toBe('0.002')
    expect(json.belopp_exkl_moms).toBe('0.0016')
    expect(json.moms_belopp).toBe('0.0004')
    expect(json.momsbehandling).toBe('SE_25')
  })

  it('reads its dates from the injected clock', () => {
    const json = buildReceipt(KIT_MERCHANT)
    expect(json.fakturadatum).toBe('2026-11-17')
    expect(json.forfallodatum).toBe('2026-12-17')
  })

  it('numbers the receipt as given and derives the OCR from that number', () => {
    const json = buildReceipt(KIT_MERCHANT)
    expect(json.fakturanummer).toBe(KIT_MERCHANT.invoiceNumber)
    expect(json.ocr_nummer).toBe(generateOcr(KIT_MERCHANT.invoiceNumber))
  })
})

describe('renderReceiptText takes the support contact and network as parameters (#4890)', () => {
  const json = buildReceipt(KIT_MERCHANT)
  for (const locale of ['sv', 'en'] as const) {
    it(`prints the given support contact and never Haven's (${locale})`, () => {
      const text = renderReceiptText(json, {
        productName: 'Inference',
        locale,
        networkEn: 'Base Sepolia testnet',
        supportContact: 'help@example.se',
      })
      expect(text).toContain('help@example.se')
      expect(text).not.toContain('haven.xyz')
      expect(text).not.toContain('Haven Demo')
    })
  }

  it('names the given network in the English render', () => {
    const text = renderReceiptText(json, {
      productName: 'Inference',
      locale: 'en',
      networkEn: 'Base Sepolia testnet',
      supportContact: 'help@example.se',
    })
    expect(text).toContain('Cryptocurrency (USDC on Base Sepolia testnet)')
  })
})

describe('vatAmountsAtomic', () => {
  it('takes 25% out of a VAT-inclusive price under SE_25', () => {
    expect(vatAmountsAtomic(500n, 'SE_25')).toEqual({ exclVat: 400n, vat: 100n, vatPercent: 25 })
  })

  it('shows the full price as net under REVERSE_CHARGE', () => {
    expect(vatAmountsAtomic(500n, 'REVERSE_CHARGE')).toEqual({ exclVat: 500n, vat: 0n, vatPercent: 0 })
  })
})

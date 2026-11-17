import { describe, expect, it } from 'vitest'
import se25 from './fixtures/merchant-receipts/demo-merchant-se25.json' with { type: 'json' }
import reverseCharge from './fixtures/merchant-receipts/demo-merchant-reverse-charge.json' with { type: 'json' }
import { UNDERLAG_MAX_RECEIPT_LINES, underlagFromData, type ReceiptUnderlagData } from '../receipt-underlag.js'
import { feedDescription } from '../fortnox-connector.js'
import { asciiFold, checkedReceiptStatement, type CheckedReceiptStatement } from '../receipt-statement.js'
import { feedTransaction } from './connector-conformance.js'

/**
 * #4876: the merchant's stated product lines and VAT on Haven's own
 * accounting document (the underlag PDF) and in the Fortnox comment, under
 * the label of owner decision 3 (2026-11-17, #4874), with only the MERCHANT's
 * VAT treatment shown (decision 2). The fixtures are the demo merchant's own
 * receipts (#4875).
 */

const DATA: ReceiptUnderlagData = {
  paymentId: 'pay-123',
  settledAt: '2026-11-17T09:30:00.000Z',
  token: 'USDC',
  amountAtomic: '500',
  amount: '0.0005',
  amountSek: '0.0052',
  fxRate: '10.42',
  fxSource: 'riksbank',
  fxAt: '2026-11-17T09:30:00.000Z',
  amountLedger: '0.0052',
  ledgerCurrency: 'SEK',
  fxRateLedger: '10.42',
  merchantName: 'Haven Demo AB',
  merchantAddress: '0x' + 'ab'.repeat(20),
  merchantCountry: 'SE',
  merchantVatNo: 'SE559412345601',
  merchantOrgNo: '559412-3456',
  resourceUrl: 'https://merchant.example/storage',
  transactionKind: 'purchase',
  description: 'merchant.example - storage (purchase)',
  purchaseGroupId: null,
  parentReceiptRef: null,
  receiptRef: 'evidence-1',
  chainId: 84532,
  txHash: '0x' + 'cd'.repeat(32),
  txHashIsFunding: false,
  fundingTxHash: null,
  delegate: '0x' + 'ef'.repeat(20),
  signHash: '0x' + '12'.repeat(32),
  signature: '0x' + '34'.repeat(65),
}

const statement = (json: unknown, amountAtomic = '500'): CheckedReceiptStatement =>
  checkedReceiptStatement(json, { token: 'USDC', amountAtomic, chainId: 84532 })!

const render = (over: Partial<ReceiptUnderlagData>) => underlagFromData({ ...DATA, ...over }).pdf.toString('latin1')

describe('the underlag shows the receipt lines (#4876)', () => {
  it('lists each line and the totals in the receipt currency, labelled, with the merchant VAT treatment', () => {
    const s = render({ receiptStatement: statement(se25) })
    expect(s).toContain("MERCHANT RECEIPT LINES \\(On the merchant's receipt, as reported by the agent\\)")
    expect(s).toContain('Line 1         CloudNest 50 GB - Saker krypterad molnlagring.')
    expect(s).toContain('qty 1, net 0.0004 USDC each, VAT 25% 0.0001 USDC, total 0.0005 USDC')
    expect(s).toContain('Receipt net    0.0004 USDC')
    expect(s).toContain('Receipt VAT    25% 0.0001 USDC')
    expect(s).toContain('Receipt total  0.0005 USDC')
    expect(s).toContain("VAT treatment  SE_25 \\(the merchant's\\)")
    // A matching total says nothing; the booked amount line is unchanged.
    expect(s).not.toContain('Total check')
    expect(s).toContain('Amount         0.0005 USDC \\(500 atomic units\\)')
    expect(s).not.toContain('not stated by the merchant')
  })

  it('a reverse-charge receipt shows its stated zero VAT, not "not stated"', () => {
    const s = render({ receiptStatement: statement(reverseCharge) })
    expect(s).toContain('Receipt VAT    0% 0 USDC')
    expect(s).toContain("VAT treatment  REVERSE_CHARGE \\(the merchant's\\)")
    expect(s).not.toContain('not stated by the merchant')
  })

  it('folds the Swedish description to readable ASCII rather than a row of ?', () => {
    const s = render({ receiptStatement: statement(se25) })
    // "Säker", "ingår" and "månad" in the demo merchant's description.
    expect(s).toContain('Saker krypterad')
    expect(s).toContain('1 manad')
    expect(s).not.toMatch(/S\?ker|m\?nad/)
    expect(asciiFold('Molnlagring — 1 månad, engångsköp, Straße')).toBe('Molnlagring - 1 manad, engangskop, Strasse')
  })

  it('says when the receipt total differs from what was settled, and still books the settled amount', () => {
    const s = render({ receiptStatement: statement(se25, '1000'), amountAtomic: '1000', amount: '0.001' })
    expect(s).toContain('Total check    receipt total differs from the amount settled; settled amount booked')
    expect(s).toContain('Amount         0.001 USDC \\(1000 atomic units\\)')
  })

  it('lists at most the cap of lines on the single page and counts the rest', () => {
    const many = { ...se25, rader: Array.from({ length: UNDERLAG_MAX_RECEIPT_LINES + 3 }, () => se25.rader[0]) }
    const s = render({ receiptStatement: statement(many) })
    expect(s).toContain(`Line ${UNDERLAG_MAX_RECEIPT_LINES} `)
    expect(s).not.toContain(`Line ${UNDERLAG_MAX_RECEIPT_LINES + 1} `)
    expect(s).toContain("...and 3 more lines on the merchant's receipt \\(attached\\)")
  })

  it('a protocol payment whose receipt states no lines says "VAT not stated by the merchant"', () => {
    const s = render({ receiptStatement: null })
    expect(s).toContain('VAT            VAT not stated by the merchant')
    expect(s).toContain('Description    merchant.example - storage \\(purchase\\)')
    expect(s).not.toContain('MERCHANT RECEIPT LINES')
  })

  it('a direct payment (no resource URL) gets no receipt block at all', () => {
    const s = render({ resourceUrl: null, receiptStatement: null })
    expect(s).not.toContain('not stated by the merchant')
    expect(s).not.toContain('MERCHANT RECEIPT LINES')
  })

  it('a document whose first render predates #4876 (statement absent) is byte-identical to before', () => {
    const before = underlagFromData(DATA).pdf
    expect(underlagFromData({ ...DATA, receiptStatement: undefined }).pdf.equals(before)).toBe(true)
  })
})

describe('the Fortnox comment carries the product and the stated VAT (#4876)', () => {
  const tx = (over: Parameters<typeof feedTransaction>[1] = {}) =>
    feedTransaction('pay-123', { txHash: `0x${'cd'.repeat(32)}`, ...over })

  it('states the label, the VAT, the merchant treatment and the product — in Fortnox-safe characters', () => {
    const d = feedDescription(tx({ merchantReceipt: { url: null, inlineJson: se25 } }))
    expect(d).toContain('On the merchants receipt, as reported by the agent.')
    expect(d).toContain('VAT 25 pct 0.0001 USDC, merchant VAT treatment SE 25.')
    expect(d).toContain('Product CloudNest 50 GB - Saker krypterad molnlagring.')
    expect(d).toMatch(/^[A-Za-z0-9 .,()-]+$/)
    expect(d).toContain('Haven payment pay-123.')
  })

  it('says "VAT not stated by the merchant" for a protocol payment with no stated lines', () => {
    expect(feedDescription(tx())).toContain('VAT not stated by the merchant.')
  })

  it('says nothing about VAT for a direct payment', () => {
    expect(feedDescription(tx({ resourceUrl: null }))).not.toContain('VAT')
  })

  it('a long product never pushes the booked hash or "Haven payment <id>" out of the 512 characters', () => {
    const long = {
      ...se25,
      rader: Array.from({ length: 50 }, (_, i) => ({ ...se25.rader[0], beskrivning: `Product number ${i} ${'x'.repeat(250)}` })),
    }
    const d = feedDescription(
      tx({
        merchantReceipt: { url: null, inlineJson: long },
        description: `api.merchant.example - ${'route/'.repeat(30)}x (purchase)`,
        resourceUrl: `https://${'sub.'.repeat(20)}merchant.example/paid`,
      }),
    )
    expect(d.length).toBeLessThanOrEqual(512)
    expect(d).toContain(`Tx 0x${'cd'.repeat(32)}.`)
    expect(d.endsWith('Haven payment pay-123.')).toBe(true)
    expect(d).toContain('VAT 25 pct 0.0001 USDC')
    // The resource host gave up its room to the stated VAT; the attached
    // document carries the full resource URL.
    expect(d).not.toContain('Resource ')
  })

  it('with room to spare, the resource host stays and only the product names are cut', () => {
    const long = {
      ...se25,
      rader: Array.from({ length: 50 }, (_, i) => ({ ...se25.rader[0], beskrivning: `Product number ${i} ${'x'.repeat(250)}` })),
    }
    const d = feedDescription(tx({ merchantReceipt: { url: null, inlineJson: long } }))
    expect(d.length).toBeLessThanOrEqual(512)
    expect(d).toContain('Resource merchant.example.')
    expect(d).toContain('VAT 25 pct 0.0001 USDC, merchant VAT treatment SE 25. Product Product number 0')
    expect(d).toMatch(/\.\. Tx 0x/)
    expect(d.endsWith('Haven payment pay-123.')).toBe(true)
  })
})

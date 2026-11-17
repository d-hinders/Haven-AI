import { describe, expect, it } from 'vitest'
import se25 from './fixtures/merchant-receipts/demo-merchant-se25.json' with { type: 'json' }
import { UNDERLAG_MAX_PAGE_LINES, underlagFromData, type ReceiptUnderlagData } from '../receipt-underlag.js'
import { feedDescription } from '../fortnox-connector.js'
import { checkedReceiptStatement } from '../receipt-statement.js'
import {
  NO_PRODUCT_SOURCES,
  PRODUCT_SOURCE_LABEL,
  PRODUCT_SOURCE_MAX,
  cleanSourceText,
  presentSources,
  productSourcesFrom,
  type ProductSources,
} from '../product-sources.js'
import { feedTransaction } from './connector-conformance.js'

/**
 * #4877: what was bought, when the merchant's receipt states no lines. The
 * ladder (owner decision 4 of 2026-11-17 on #4874): the receipt's lines, then
 * the Haven catalog name, then the price quote's description, then the
 * agent's own words (`delivery_reference`, decision 5). Each source prints
 * under its own label — never as the merchant's statement — and the highest
 * present one is the product line.
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

const ALL: ProductSources = {
  catalogName: 'CloudNest 50 GB',
  quoteDescription: 'Encrypted cloud storage, 50 GB, one month',
  deliveryReference: 'Bought storage for the backup job',
}
const only = (key: keyof ProductSources): ProductSources => ({ ...NO_PRODUCT_SOURCES, [key]: ALL[key] })

const render = (over: Partial<ReceiptUnderlagData>) => underlagFromData({ ...DATA, ...over }).pdf.toString('latin1')
const statement = (json: unknown) => checkedReceiptStatement(json, { token: 'USDC', amountAtomic: '500', chainId: 84532 })!
const esc = (s: string) => s.replace(/\(/g, '\\(').replace(/\)/g, '\\)')

describe('the product-source ladder on the underlag (#4877)', () => {
  it.each([
    ['catalogName', 'Haven catalog'],
    ['quoteDescription', "In the merchant's price quote, as reported by the agent"],
    ['deliveryReference', 'Stated by the agent'],
  ] as const)('%s alone is the product line, under its own label', (key, label) => {
    const s = render({ receiptStatement: null, productSources: only(key) })
    expect(s).toContain(`Product        ${ALL[key]}`)
    expect(s).toContain(esc(`               (${label})`))
    expect(s).not.toContain('Also stated')
  })

  it('the highest present source is the product; the others follow, each under its own label', () => {
    const s = render({ receiptStatement: null, productSources: ALL })
    expect(s).toContain(`Product        ${ALL.catalogName}`)
    expect(s).toContain(`Also stated    ${ALL.quoteDescription}`)
    expect(s).toContain(`Also stated    ${ALL.deliveryReference}`)
    expect(s.indexOf(ALL.catalogName)).toBeLessThan(s.indexOf(ALL.quoteDescription))
    expect(s.indexOf(ALL.quoteDescription)).toBeLessThan(s.indexOf(ALL.deliveryReference))
    for (const label of Object.values(PRODUCT_SOURCE_LABEL)) expect(s).toContain(esc(`(${label})`))
  })

  it('beside receipt lines, every source is "Also stated" — the receipt is the product', () => {
    const s = render({ receiptStatement: statement(se25), productSources: ALL })
    expect(s).toContain('MERCHANT RECEIPT LINES')
    expect(s).not.toContain('Product        ')
    expect(s).toContain(`Also stated    ${ALL.catalogName}`)
  })

  it('the Description line is byte-identical for every rung — the product line is separate', () => {
    const line = (pdf: string) => pdf.match(/\(Description {4}[^)]*(?:\\\)[^)]*)*\)/)?.[0]
    const base = line(render({ receiptStatement: null }))
    expect(base).toBeDefined()
    for (const key of ['catalogName', 'quoteDescription', 'deliveryReference'] as const) {
      expect(line(render({ receiptStatement: null, productSources: only(key) }))).toBe(base)
    }
    expect(line(render({ receiptStatement: statement(se25), productSources: ALL }))).toBe(base)
  })

  it('no source is ever labelled as the merchant receipt', () => {
    const s = render({ receiptStatement: null, productSources: ALL })
    expect(s).not.toContain("On the merchant's receipt")
    expect(s).toContain('VAT            not stated by the merchant')
  })

  it('a direct payment shows no product source', () => {
    const s = render({ resourceUrl: null, receiptStatement: null, productSources: ALL })
    expect(s).not.toContain(ALL.catalogName)
    expect(s).not.toContain('Also stated')
  })

  it('a pin from before #4877 (no productSources) renders none, byte-identical', () => {
    const before = underlagFromData(DATA).pdf
    expect(underlagFromData({ ...DATA, productSources: undefined }).pdf.equals(before)).toBe(true)
    expect(underlagFromData({ ...DATA, productSources: NO_PRODUCT_SOURCES }).pdf.equals(before)).toBe(true)
  })

  it('the worst case — maximal receipt and every source at its maximum — still fits the single page', () => {
    const big = `${'9'.repeat(30)}.${'9'.repeat(30)}`
    const many = {
      ...se25,
      valuta: 'U'.repeat(32),
      momsbehandling: 'T'.repeat(32),
      belopp_exkl_moms: big,
      moms_belopp: big,
      totalt_inkl_moms: big,
      rader: Array.from({ length: 50 }, () => ({
        beskrivning: 'y'.repeat(300), antal: 1, apris_exkl_moms: big, moms_procent: 25, moms_belopp: big, totalt_inkl_moms: big,
      })),
    }
    const maxed = productSourcesFrom({
      catalogName: 'c'.repeat(PRODUCT_SOURCE_MAX.catalogName),
      quoteDescription: 'q'.repeat(PRODUCT_SOURCE_MAX.quoteDescription),
      deliveryReference: 'd'.repeat(PRODUCT_SOURCE_MAX.deliveryReference),
    })
    for (const receiptStatement of [statement(many), null]) {
      const s = render({
        receiptStatement,
        productSources: maxed,
        fundingTxHash: `0x${'ee'.repeat(32)}`,
        ledgerCurrency: 'EUR',
        purchaseGroupId: 'group-1',
        parentReceiptRef: 'parent-1',
      })
      expect((s.match(/\) Tj T\*/g) ?? []).length).toBeLessThanOrEqual(UNDERLAG_MAX_PAGE_LINES)
      expect(s).toContain('Signature      ')
    }
  })
})

describe('the product sources in the Fortnox comment (#4877)', () => {
  const tx = (over: Parameters<typeof feedTransaction>[1] = {}) =>
    feedTransaction('pay-123', { txHash: `0x${'cd'.repeat(32)}`, ...over })

  it('with no receipt lines, the highest source is the product, labelled; the others follow', () => {
    const d = feedDescription(tx({ productSources: ALL }))
    expect(d).toContain('VAT not stated by the merchant.')
    expect(d).toContain('Product (Haven catalog) CloudNest 50 GB.')
    expect(d).toContain('Also stated (In the merchants price quote, as reported by the agent) Encrypted cloud storage, 50 GB, one month.')
    expect(d).toContain('Also stated (Stated by the agent) Bought storage for the backup job.')
    expect(d).toMatch(/^[A-Za-z0-9 .,()-]+$/)
  })

  it('beside receipt lines, the sources are "Also stated" and the receipt keeps the product', () => {
    const d = feedDescription(tx({ productSources: ALL, merchantReceipt: { url: null, inlineJson: se25 } }))
    expect(d).toContain('Product CloudNest 50 GB - Saker krypterad molnlagring.')
    expect(d).toContain('Also stated (Haven catalog) CloudNest 50 GB.')
  })

  it('the Haven-derived description in the comment is unchanged by any source', () => {
    for (const productSources of [NO_PRODUCT_SOURCES, ALL, only('deliveryReference')]) {
      expect(feedDescription(tx({ productSources }))).toContain(' merchant.example - vpn (purchase). ')
    }
  })

  it('a direct payment carries no source', () => {
    expect(feedDescription(tx({ resourceUrl: null, productSources: ALL }))).not.toContain('stated')
  })

  it('every source at its maximum never pushes the booked hash or the payment id out of 512', () => {
    const maxed = productSourcesFrom({
      catalogName: 'c '.repeat(60),
      quoteDescription: 'q '.repeat(150),
      deliveryReference: 'd '.repeat(256),
    })
    for (const merchantReceipt of [null, { url: null, inlineJson: se25 }]) {
      const d = feedDescription(
        tx({
          productSources: maxed,
          merchantReceipt,
          description: `api.merchant.example - ${'route/'.repeat(30)}x (purchase)`,
          resourceUrl: `https://${'sub.'.repeat(20)}merchant.example/paid`,
        }),
      )
      expect(d.length).toBeLessThanOrEqual(512)
      expect(d).toContain(`Tx 0x${'cd'.repeat(32)}.`)
      expect(d.endsWith('Haven payment pay-123.')).toBe(true)
      expect(d).toMatch(/VAT /)
    }
  })

  it('when room runs out the delivery reference goes first, then the quote, the catalog last', () => {
    const d = feedDescription(
      tx({
        productSources: productSourcesFrom({
          catalogName: 'Catalog '.repeat(15),
          quoteDescription: 'Quote '.repeat(50),
          deliveryReference: 'Agent '.repeat(80),
        }),
        description: `api.merchant.example - ${'route/'.repeat(10)}x (purchase)`,
      }),
    )
    expect(d.length).toBeLessThanOrEqual(512)
    expect(d).toContain('Product (Haven catalog) Catalog')
    expect(d).not.toContain('(In the merchants price quote')
    expect(d).not.toContain('(Stated by the agent)')
    expect(d.endsWith('Haven payment pay-123.')).toBe(true)
  })
})

describe('cleaning a source (#4877)', () => {
  it('strips controls, bidi and zero-width characters, collapses whitespace, and bounds by code points', () => {
    expect(cleanSourceText('  a\tb\nc‮​d\u0007  ', 10)).toBe('a b cd')
    expect(cleanSourceText('😀'.repeat(5), 3)).toBe('😀😀…')
    expect(cleanSourceText('   ', 10)).toBeNull()
    expect(cleanSourceText(null, 10)).toBeNull()
    expect(cleanSourceText(42 as unknown as string, 10)).toBeNull()
  })

  it('keeps the zero-width joiner and non-joiner', () => {
    expect(cleanSourceText('a‍b‌c', 10)).toBe('a‍b‌c')
  })

  it('presents only the present sources, in ladder order', () => {
    expect(presentSources({ catalogName: null, quoteDescription: 'q', deliveryReference: 'd' }).map((s) => s.key)).toEqual([
      'quoteDescription',
      'deliveryReference',
    ])
    expect(presentSources(NO_PRODUCT_SOURCES)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { sieExporter } from '../sie-exporter.js'
import type { AccountingEntry } from '../accounting-entry.js'

function entry(over: Partial<AccountingEntry> = {}): AccountingEntry {
  return {
    paymentId: 'pi1',
    txHash: '0xabc',
    chainId: 8453,
    settledAt: '2026-06-19T10:00:00.000Z',
    direction: 'out',
    counterparty: { address: '0xmerchant', name: 'Soundside', country: null },
    token: 'USDC',
    amountAtomic: '12500000',
    amountSek: '132.50',
    fxRate: '10.60',
    fxSource: 'coingecko_spot',
    fxAt: '2026-06-19T10:00:00.000Z',
    feeSek: null,
    category: 'media',
    account: null,
    vatTreatment: 'reverse_charge',
    resourceUrl: 'https://api.example/resource',
    receiptRef: 'ev1',
    ...over,
  }
}

const OPTS = { companyName: 'Acme AB', generatedAt: new Date('2026-06-20T00:00:00.000Z') }

describe('sieExporter', () => {
  it('emits a valid SIE 4I header', () => {
    const { content } = sieExporter.export([entry()], OPTS)
    expect(content).toContain('#FLAGGA 0')
    expect(content).toContain('#SIETYP 4')
    expect(content).toContain('#FORMAT PC8')
    expect(content).toContain('#GEN 20260620')
    expect(content).toContain('#FNAMN "Acme AB"')
  })

  it('writes a balanced reverse-charge verifikation (default) summing to zero', () => {
    const { content, entryCount } = sieExporter.export([entry()], OPTS)
    expect(entryCount).toBe(1)
    expect(content).toContain('#VER "A" 1 20260619 "Soundside"')
    // reverse charge: purchase 4535 + cash 1930 + input VAT 2645 + output VAT 2614
    const trans = content.split('\r\n').filter((l) => l.includes('#TRANS'))
    expect(trans).toHaveLength(4)
    const amounts = trans.map((l) => Number(l.trim().split(/\s+/)[3]))
    expect(amounts.reduce((s, a) => s + a, 0)).toBeCloseTo(0, 5)
    // 25% VAT self-accounted on the 132.50 base
    expect(content).toContain('#TRANS 4535 {} 132.50')
    expect(content).toContain('#TRANS 1930 {} -132.50')
    expect(content).toContain('#TRANS 2645 {} 33.13')
    expect(content).toContain('#TRANS 2614 {} -33.13')
  })

  it('writes a simple two-line verifikation when VAT is not reverse charge', () => {
    const { content } = sieExporter.export([entry({ vatTreatment: 'none' })], OPTS)
    const trans = content.split('\r\n').filter((l) => l.includes('#TRANS'))
    expect(trans).toHaveLength(2)
    expect(content).toContain('#TRANS 6540 {} 132.50')
    expect(content).toContain('#TRANS 1930 {} -132.50')
  })

  it('honours a per-merchant account override on the expense line', () => {
    const { content } = sieExporter.export([entry({ vatTreatment: 'none', account: '6550' })], OPTS)
    expect(content).toContain('#TRANS 6550 {} 132.50')
  })

  it('declares the accounts it uses with names', () => {
    const { content } = sieExporter.export([entry()], OPTS)
    expect(content).toContain('#KONTO 1930 "Företagskonto"')
    expect(content).toContain('#KONTO 4535 "Inköp av tjänster annat EU-land, 25%"')
    expect(content).toContain('#KONTO 2614 "Utgående moms omvänd skattskyldighet, 25%"')
  })

  it('skips entries with no book-time SEK (unbookable) and counts them', () => {
    const result = sieExporter.export([entry(), entry({ amountSek: null, paymentId: 'pi2' })], OPTS)
    expect(result.entryCount).toBe(1)
    expect(result.skipped).toBe(1)
  })

  it('numbers verifikationer sequentially across written entries only', () => {
    const { content } = sieExporter.export(
      [entry({ amountSek: null }), entry({ paymentId: 'pi2' }), entry({ paymentId: 'pi3' })],
      OPTS,
    )
    expect(content).toContain('#VER "A" 1 ')
    expect(content).toContain('#VER "A" 2 ')
    expect(content).not.toContain('#VER "A" 3 ')
  })

  it('escapes quotes in the verifikation text and falls back to address/url', () => {
    const { content } = sieExporter.export(
      [entry({ counterparty: { address: '0xm', name: 'A "quoted" co', country: null } })],
      OPTS,
    )
    expect(content).toContain('"A \\"quoted\\" co"')
  })

  it('uses the default expense account for an unknown category (non-reverse)', () => {
    const { content } = sieExporter.export([entry({ vatTreatment: 'none', category: 'something-weird' })], OPTS)
    expect(content).toContain('#TRANS 6540 {}')
  })
})

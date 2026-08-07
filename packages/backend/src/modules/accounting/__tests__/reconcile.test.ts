import { describe, expect, it } from 'vitest'
import { reconcileEntries } from '../reconcile.js'
import type { AccountingEntry } from '../accounting-entry.js'

function entry(over: Partial<AccountingEntry> = {}): AccountingEntry {
  return {
    paymentId: 'pi1',
    txHash: '0xabc',
    chainId: 8453,
    settledAt: '2026-06-19T10:00:00.000Z',
    direction: 'out',
    counterparty: { address: '0xm', name: null, country: null },
    token: 'USDC',
    amountAtomic: '100000000',
    amountSek: '100.00',
    fxRate: '10',
    fxSource: 'coingecko_spot',
    fxAt: '2026-06-19T10:00:00.000Z',
    feeSek: null,
    category: 'media',
    account: null,
    vatTreatment: 'reverse_charge',
    resourceUrl: 'https://api.example/r',
    receiptRef: 'ev1',
    ...over,
  }
}

describe('reconcileEntries', () => {
  it('counts clean entries as ok and lists only the issues', () => {
    const report = reconcileEntries([
      entry({ paymentId: 'a' }),
      entry({ paymentId: 'b', amountSek: null }),
      entry({ paymentId: 'c', txHash: '' }),
    ])
    expect(report.total).toBe(3)
    expect(report.ok).toBe(1)
    expect(report.issues).toBe(2)
    expect(report.byStatus.missing_fx).toBe(1)
    expect(report.byStatus.missing_tx).toBe(1)
    // ok entries are not listed
    expect(report.items.map((i) => i.paymentId).sort()).toEqual(['b', 'c'])
  })

  it('reports an empty period cleanly', () => {
    const report = reconcileEntries([])
    expect(report).toMatchObject({ total: 0, ok: 0, issues: 0 })
    expect(report.items).toEqual([])
  })
})

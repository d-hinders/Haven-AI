import { describe, it, expect, beforeEach } from 'vitest'
import { toReportingTransaction } from '../reporting-transaction.js'
import {
  registerConnector,
  getConnector,
  clearConnectors,
  InMemoryConnector,
} from '../connector.js'
import type { AccountingEntry } from '../../accounting-entry.js'

function entry(over: Partial<AccountingEntry> = {}): AccountingEntry {
  return {
    paymentId: 'pi1',
    txHash: '0xabc',
    chainId: 8453,
    settledAt: '2026-06-20T10:00:00.000Z',
    direction: 'out',
    counterparty: { address: '0xmerchant', name: 'Soundside', country: 'US' },
    token: 'USDC',
    amountAtomic: '12500000',
    amountSek: '132.50',
    fxRate: '10.60',
    fxSource: 'coingecko_spot',
    fxAt: '2026-06-20T10:00:00.000Z',
    feeSek: null,
    category: 'media',
    account: null,
    vatTreatment: 'reverse_charge',
    resourceUrl: 'https://api.example/r',
    receiptRef: 'ev1',
    ...over,
  }
}

describe('toReportingTransaction', () => {
  it('carries book-time FX, counterparty, and receipt', () => {
    const tx = toReportingTransaction(entry())
    expect(tx).toMatchObject({
      paymentId: 'pi1',
      settledAt: '2026-06-20T10:00:00.000Z',
      direction: 'out',
      token: 'USDC',
      amountAtomic: '12500000',
      amountSek: '132.50',
      fxSource: 'coingecko_spot',
      receiptRef: 'ev1',
    })
    expect(tx.counterparty).toEqual({ address: '0xmerchant', name: 'Soundside' })
  })

  it('asserts nothing — no vatTreatment or posted account fields', () => {
    const tx = toReportingTransaction(entry()) as unknown as Record<string, unknown>
    expect(tx.vatTreatment).toBeUndefined()
    expect(tx.account).toBeUndefined()
    expect(tx.category).toBeUndefined()
    expect(tx.feeSek).toBeUndefined()
  })

  it('surfaces a per-merchant override only as a suggestion', () => {
    expect(toReportingTransaction(entry()).suggestedAccount).toBeNull()
    expect(toReportingTransaction(entry({ account: '6550' })).suggestedAccount).toBe('6550')
  })
})

describe('connector registry + in-memory adapter', () => {
  beforeEach(() => clearConnectors())

  it('resolves a registered connector by provider', () => {
    const c = new InMemoryConnector()
    registerConnector(c)
    expect(getConnector('memory')).toBe(c)
    expect(getConnector('fortnox')).toBeUndefined()
  })

  it('skips unconnected users, pushes connected ones, and dedups', async () => {
    const c = new InMemoryConnector()
    const tx = toReportingTransaction(entry())

    expect(await c.pushTransaction('u1', tx)).toMatchObject({ status: 'skipped', reason: 'not_connected' })

    c.connect('u1')
    expect(await c.pushTransaction('u1', tx)).toMatchObject({ status: 'pushed' })
    expect(await c.pushTransaction('u1', tx)).toMatchObject({ status: 'skipped', reason: 'duplicate' })
    expect(c.pushed).toHaveLength(1)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { toFeedTransaction } from '../feed-transaction.js'
import {
  registerConnector,
  getConnector,
  clearConnectors,
  hasLiveConnector,
  InMemoryConnector,
} from '../connector.js'
import type { AccountingEntry } from '../../accounting/index.js'

function entry(over: Partial<AccountingEntry> = {}): AccountingEntry {
  return {
    paymentId: 'pi1',
    txHash: '0xabc',
    bookedTxHash: null,
    bookedTxHashIsFunding: false,
    fundingTxHash: null,
    settlementScheme: null,
    verifiedSettlementTxHash: null,
    pinnedBookedTxHash: null,
    pinnedBookedTxKind: null,
    chainId: 8453,
    settledAt: '2026-06-20T10:00:00.000Z',
    direction: 'out',
    treasuryAccount: null,
    counterparty: { address: '0xmerchant', name: 'Soundside', country: 'US' },
    token: 'USDC',
    amountAtomic: '12500000',
    amountHuman: '0.1',
    fxRates: { SEK: 10 },
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
    // #4532: the kind and its line. A fixture, not a derivation.
    transactionKind: 'purchase',
    transactionDescription: 'api.example - r (purchase)',
    // #4534: ungrouped by default; the correlation-key cases override.
    purchaseGroupId: null,
    parentReceiptRef: null,
    ...over,
  }
}

describe('toFeedTransaction', () => {
  it('carries book-time FX, counterparty, and receipt', () => {
    const tx = toFeedTransaction(entry(), { ledgerCurrency: 'SEK' })
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
    expect(tx.counterparty).toEqual({ address: '0xmerchant', name: 'Soundside', country: 'US' })
  })

  it('asserts nothing — no vatTreatment or posted account fields', () => {
    const tx = toFeedTransaction(entry(), { ledgerCurrency: 'SEK' }) as unknown as Record<string, unknown>
    expect(tx.vatTreatment).toBeUndefined()
    expect(tx.account).toBeUndefined()
    expect(tx.category).toBeUndefined()
    expect(tx.feeSek).toBeUndefined()
  })

  it('surfaces a per-merchant override only as a suggestion', () => {
    expect(toFeedTransaction(entry(), { ledgerCurrency: 'SEK' }).suggestedAccount).toBeNull()
    expect(toFeedTransaction(entry({ account: '6550' }), { ledgerCurrency: 'SEK' }).suggestedAccount).toBe('6550')
  })

  // #4532: the feed payload carries the kind and its line beside the existing
  // fields, from the same two values the receipt underlag renders.
  it('carries the transaction kind and description (#4532)', () => {
    const tx = toFeedTransaction(entry(), { ledgerCurrency: 'SEK' })
    expect(tx.transactionKind).toBe('purchase')
    expect(tx.description).toBe('api.example - r (purchase)')
  })

  it('CONTROL: the payload really does read the entry, not a constant', () => {
    const fee = toFeedTransaction(
      entry({ transactionKind: 'api_fee', transactionDescription: 'api.example - r (API fee)' }),
      { ledgerCurrency: 'SEK' },
    )
    expect(fee.transactionKind).toBe('api_fee')
    expect(fee.description).toBe('api.example - r (API fee)')
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

  it('reports no live connector until a non-test adapter is registered (#496/#498 deferred)', () => {
    // Empty registry → live sync not ready (production state today).
    expect(hasLiveConnector()).toBe(false)
    // The in-memory test connector must not count as live.
    registerConnector(new InMemoryConnector())
    expect(hasLiveConnector()).toBe(false)
    // A real provider does count.
    registerConnector({
      provider: 'fortnox',
      isConnected: async () => false,
      pushTransaction: async () => ({ externalRef: null, status: 'skipped' as const }),
      verify: async () => ({ ok: false as const, error_code: 'not_connected' as const }),
      getCompanyInfo: async () => ({ externalCompanyId: null, name: null, baseCurrency: null }),
      revoke: async () => {},
    })
    expect(hasLiveConnector()).toBe(true)
  })

  it('skips unconnected users, pushes connected ones, and dedups', async () => {
    const c = new InMemoryConnector()
    const tx = toFeedTransaction(entry(), { ledgerCurrency: 'SEK' })

    expect(await c.pushTransaction('u1', tx)).toMatchObject({ status: 'skipped', reason: 'not_connected' })

    c.connect('u1')
    expect(await c.pushTransaction('u1', tx)).toMatchObject({ status: 'pushed' })
    expect(await c.pushTransaction('u1', tx)).toMatchObject({ status: 'skipped', reason: 'duplicate' })
    expect(c.pushed).toHaveLength(1)
  })
})

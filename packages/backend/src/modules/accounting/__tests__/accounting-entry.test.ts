import { describe, expect, it } from 'vitest'
import {
  toAccountingEntry,
  type AccountingEntrySourceRow,
} from '../accounting-entry.js'

function row(over: Partial<AccountingEntrySourceRow> = {}): AccountingEntrySourceRow {
  return {
    id: 'ev1',
    payment_intent_id: 'pi1',
    approval_request_id: null,
    tx_hash: '0xabc',
    chain_id: 8453,
    merchant_address: '0xmerchant',
    token_symbol: 'USDC',
    amount_raw: '12500000',
    amount_sek: '132.5000',
    fx_rate_sek: '10.600000000000',
    fx_source: 'coingecko_spot',
    fx_at: '2026-06-19T10:00:00.000Z',
    resource_url: 'https://api.example/resource',
    confirmed_at: '2026-06-19T10:00:00.000Z',
    created_at: '2026-06-19T09:59:00.000Z',
    category: 'media',
    country: null,
    override_account: null,
    fee_sek: null,
    ...over,
  }
}

describe('toAccountingEntry', () => {
  it('maps a settled evidence row to the canonical record', () => {
    const e = toAccountingEntry(row())
    expect(e).toMatchObject({
      paymentId: 'pi1',
      txHash: '0xabc',
      chainId: 8453,
      settledAt: '2026-06-19T10:00:00.000Z',
      direction: 'out',
      token: 'USDC',
      amountAtomic: '12500000',
      amountSek: '132.5000',
      fxRate: '10.600000000000',
      fxSource: 'coingecko_spot',
      resourceUrl: 'https://api.example/resource',
      receiptRef: 'ev1',
    })
    expect(e.counterparty.address).toBe('0xmerchant')
  })

  it('keeps SEK amounts as strings (no float rounding)', () => {
    const e = toAccountingEntry(row({ amount_sek: '0.0001' }))
    expect(e.amountSek).toBe('0.0001')
    expect(typeof e.amountSek).toBe('string')
  })

  it('derives VAT treatment from supplier country', () => {
    expect(toAccountingEntry(row()).vatTreatment).toBe('reverse_charge') // unknown
    expect(toAccountingEntry(row({ country: 'DE' })).vatTreatment).toBe('reverse_charge')
    expect(toAccountingEntry(row({ country: 'US' })).vatTreatment).toBe('reverse_charge')
    expect(toAccountingEntry(row({ country: 'SE' })).vatTreatment).toBe('standard')
    expect(toAccountingEntry(row({ country: 'DE' })).counterparty.country).toBe('DE')
  })

  it('carries null FX through when none was captured (backfillable)', () => {
    const e = toAccountingEntry(row({ amount_sek: null, fx_rate_sek: null, fx_source: null, fx_at: null }))
    expect(e.amountSek).toBeNull()
    expect(e.fxRate).toBeNull()
    expect(e.fxSource).toBeNull()
  })

  it('falls back to created_at when confirmed_at is missing', () => {
    expect(toAccountingEntry(row({ confirmed_at: null })).settledAt).toBe('2026-06-19T09:59:00.000Z')
  })

  it('prefers approval_request id when there is no payment intent', () => {
    const e = toAccountingEntry(row({ payment_intent_id: null, approval_request_id: 'ar9' }))
    expect(e.paymentId).toBe('ar9')
  })

  it('populates category from the catalog and fee from the ledger', () => {
    expect(toAccountingEntry(row()).feeSek).toBeNull()
    expect(toAccountingEntry(row()).category).toBe('media')
    expect(toAccountingEntry(row({ fee_sek: '1.25' })).feeSek).toBe('1.25')
  })

  it('carries a per-merchant account override when present, else null', () => {
    expect(toAccountingEntry(row()).account).toBeNull()
    expect(toAccountingEntry(row({ override_account: '6550' })).account).toBe('6550')
  })
})

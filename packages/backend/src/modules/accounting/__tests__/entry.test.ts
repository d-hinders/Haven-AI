import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import {
  ledgerRatesFromFiatValues,
  normalizeLedgerRates,
  toAccountingEntry,
  type AccountingEntrySourceRow,
} from '../entry.js'

function row(over: Partial<AccountingEntrySourceRow> = {}): AccountingEntrySourceRow {
  return {
    id: 'ev1',
    payment_intent_id: 'pi1',
    approval_request_id: null,
    tx_hash: '0xabc',
    chain_id: 8453,
    merchant_address: '0xmerchant',
    payer_address: '0xtreasury',
    token_symbol: 'USDC',
    amount_raw: '12500000',
    amount_human: '0.1',
    fx_rates: { SEK: 10 },
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

  // #2960: our own side — documented as `treasury_account` on every other
  // surface — is `machine_payment_evidence.payer_address`, not the merchant.
  it('maps payer_address to treasuryAccount, distinct from the merchant counterparty', () => {
    const e = toAccountingEntry(row({ payer_address: '0xtreasury', merchant_address: '0xmerchant' }))
    expect(e.treasuryAccount).toBe('0xtreasury')
    expect(e.counterparty.address).toBe('0xmerchant')
    expect(e.treasuryAccount).not.toBe(e.counterparty.address)
  })

  it('treasuryAccount is null when the evidence row carries no payer_address', () => {
    const e = toAccountingEntry(row({ payer_address: null }))
    expect(e.treasuryAccount).toBeNull()
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

/**
 * #4532: the transaction kind is derived from the stored row, not asserted.
 * These pin the wiring — the classifier itself is covered by
 * `transaction-kind.test.ts`.
 */
describe('the transaction kind (#4532)', () => {
  it('derives the kind from the resource route and renders the description', () => {
    const e = toAccountingEntry(row({ resource_url: 'https://api.bitrefill.com/x402/invoice/pay' }))
    expect(e.transactionKind).toBe('purchase')
    expect(e.transactionDescription).toBe('api.bitrefill.com - invoice/pay (purchase)')
  })

  it('pins the three Bitrefill routes through the entry builder', () => {
    const kinds = [
      'https://api.bitrefill.com/x402/invoice/create',
      'https://api.bitrefill.com/x402/invoice/pay',
      'https://api.bitrefill.com/x402/invoice/status',
    ].map((url) => toAccountingEntry(row({ resource_url: url })).transactionKind)
    expect(kinds).toEqual(['api_fee', 'purchase', 'api_fee'])
  })

  it('reads the intent metadata MCP tool as the route for an MCP purchase', () => {
    const e = toAccountingEntry(
      row({ resource_url: 'https://mcp.soundside.ai/mcp', mcp_tool_name: 'create_text' }),
    )
    expect(e.transactionKind).toBe('purchase')
    expect(e.transactionDescription).toBe('mcp.soundside.ai - create_text (purchase)')
  })

  it('reads the delivery reference as a purchase signal', () => {
    const e = toAccountingEntry(
      row({ resource_url: 'https://api.example/v1/thing', delivery_reference: 'Bik Bok 5 SEK, order 6ac7' }),
    )
    expect(e.transactionKind).toBe('purchase')
  })

  it('reads the captured merchant invoice as a purchase signal', () => {
    const e = toAccountingEntry(
      row({
        resource_url: 'https://api.example/v1/thing',
        merchant_receipt_json: { fakturanummer: 'FAK-1', saljare: { name: 'Haven Demo AB' } },
      }),
    )
    expect(e.transactionKind).toBe('purchase')
  })

  it('a row with no derivable signal is `unknown` and does not throw', () => {
    const e = toAccountingEntry(row({ resource_url: 'https://api.example/v1/thing' }))
    expect(e.transactionKind).toBe('unknown')
    expect(e.transactionDescription).toBe('api.example - v1/thing (unclassified)')
  })

  // #4578: the direct-payment branch emits `TRUE::BOOLEAN` for the signal, so
  // a settled direct payment is a transfer labelled with its counterparty's
  // canonical address — not `Unknown merchant (unclassified)`.
  it('a direct payment is a transfer labelled with its counterparty address (#4578)', () => {
    const e = toAccountingEntry(
      row({
        resource_url: null,
        merchant_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
        is_direct_payment: true,
      }),
    )
    expect(e.transactionKind).toBe('transfer')
    expect(e.transactionDescription).toBe('0x15179876c595922999C2d5DC7c23Cc7711fE799a (transfer)')
    // The label is the address only: filling `counterparty.name` would also
    // change Fortnox's booked supplier and the underlag's `Counterparty` line.
    expect(e.counterparty.name).toBeNull()
    expect(e.counterparty.address).toBe('0x15179876c595922999C2d5DC7c23Cc7711fE799a')
  })

  it('CONTROL: the same row without the direct-payment signal is still unknown (#4578)', () => {
    const e = toAccountingEntry(
      row({ resource_url: null, merchant_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a' }),
    )
    expect(e.transactionKind).toBe('unknown')
    expect(e.transactionDescription).toBe('Unknown merchant (unclassified)')
  })

  it('CONTROL: two different routes really do produce two different kinds', () => {
    const pay = toAccountingEntry(row({ resource_url: 'https://api.bitrefill.com/x402/invoice/pay' }))
    const create = toAccountingEntry(row({ resource_url: 'https://api.bitrefill.com/x402/invoice/create' }))
    expect(pay.transactionKind).not.toBe(create.transactionKind)
    expect(pay.transactionDescription).not.toBe(create.transactionDescription)
  })
})

/**
 * `normalizeLedgerRates` is the only thing standing between `fx_rates` — JSONB
 * written by some build, not necessarily this one — and a figure on a supplier
 * invoice. Its defensive branches had no test: the review on #2877 found that
 * the whole body could be replaced with `return value as LedgerRates` and the
 * suite stayed green, which made "fails safe" an unproven claim.
 */
describe('normalizeLedgerRates (#2877)', () => {
  it('keeps supported currencies with a usable positive rate, and coerces a string rate', () => {
    expect(normalizeLedgerRates({ SEK: 10.42, DKK: '6.87' })).toEqual({ SEK: 10.42, DKK: 6.87 })
  })

  it('uppercases a lowercase currency key rather than dropping it', () => {
    expect(normalizeLedgerRates({ dkk: 6.87 })).toEqual({ DKK: 6.87 })
  })

  it('drops a currency this build does not support — a stored rate never outlives the list', () => {
    expect(normalizeLedgerRates({ SEK: 10.42, JPY: 150 })).toEqual({ SEK: 10.42 })
  })

  it.each([
    ['zero', { SEK: 0 }],
    ['negative', { SEK: -10.42 }],
    ['NaN', { SEK: Number.NaN }],
    ['Infinity', { SEK: Number.POSITIVE_INFINITY }],
    ['unparseable string', { SEK: 'about ten' }],
    ['null rate', { SEK: null }],
  ])('drops a %s rate — a bad number never reaches an invoice', (_label, input) => {
    expect(normalizeLedgerRates(input)).toBeNull()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"SEK":10}'],
    ['a number', 10],
    ['an empty object', {}],
  ])('returns null for %s, so the caller reads not-ready rather than throwing', (_label, input) => {
    expect(normalizeLedgerRates(input)).toBeNull()
  })

  it('a partially bad map keeps its good half', () => {
    expect(normalizeLedgerRates({ SEK: 10.42, EUR: -1, DKK: 6.87 })).toEqual({ SEK: 10.42, DKK: 6.87 })
  })
})

/**
 * #4533: a direct payment has no `machine_payment_evidence` row, so it has no
 * `fx_rates` map — but `confirmSubmittedIntent` froze the same three fiat
 * values on the intent. Recovering the rate map from them is what lets a
 * non-SEK ledger book a direct payment exactly as it books an x402 one.
 */
describe('ledgerRatesFromFiatValues (#4533)', () => {
  it('recovers the token→currency rates the settlement capture was computed from', () => {
    const rates = ledgerRatesFromFiatValues({
      amount_human: '0.01',
      sek_value: '0.104200',
      usd_value: '0.010000',
      eur_value: '0.009200',
    })
    expect(rates?.SEK).toBeCloseTo(10.42, 6)
    expect(rates?.USD).toBeCloseTo(1, 6)
    expect(rates?.EUR).toBeCloseTo(0.92, 6)
  })

  it('keeps only the currencies that were actually captured', () => {
    expect(
      ledgerRatesFromFiatValues({ amount_human: '2', sek_value: '20', usd_value: null, eur_value: null }),
    ).toEqual({ SEK: 10 })
  })

  it.each([
    ['no capture at all', { amount_human: '1', sek_value: null, usd_value: null, eur_value: null }],
    ['a zero token amount', { amount_human: '0', sek_value: '10', usd_value: null, eur_value: null }],
    ['an unparseable token amount', { amount_human: 'n/a', sek_value: '10', usd_value: null, eur_value: null }],
    ['a zero value', { amount_human: '1', sek_value: '0', usd_value: null, eur_value: null }],
    ['a negative value', { amount_human: '1', sek_value: '-10', usd_value: null, eur_value: null }],
  ])('returns null for %s, so the feed reads not-ready rather than booking a bad rate', (_label, input) => {
    expect(ledgerRatesFromFiatValues(input)).toBeNull()
  })

  it('is the fallback only: a stored fx_rates map wins', () => {
    const entry = toAccountingEntry(
      row({ fx_rates: { SEK: 11 }, sek_value: '0.104200', usd_value: '0.01', eur_value: '0.0092' }),
    )
    expect(entry.fxRates).toEqual({ SEK: 11 })
  })

  it('fills fxRates from the intent capture when the evidence map is absent', () => {
    const entry = toAccountingEntry(
      row({
        fx_rates: null,
        amount_human: '0.01',
        sek_value: '0.104200',
        usd_value: '0.01',
        eur_value: '0.0092',
      }),
    )
    expect(entry.fxRates?.SEK).toBeCloseTo(10.42, 6)
  })
})

/**
 * #3129: the bookkeeping underlag documents the SAME payment the transaction
 * feed reports. Before #3129 both emitted the lowercase `payment_intents`
 * casing and agreed by accident; normalising only the feed would have made
 * one payment read `0xabcd…1234` on its receipt and `0xAbCd…1234` in the
 * transaction it documents.
 */
describe('address form on the accounting entry (#3129)', () => {
  const MERCHANT = ethers.getAddress('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  const TREASURY = ethers.getAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b')

  it('canonicalises the merchant and treasury addresses the column stored lowercase', () => {
    const entry = toAccountingEntry(
      row({ merchant_address: MERCHANT.toLowerCase(), payer_address: TREASURY.toLowerCase() }),
    )

    expect(entry.counterparty.address).toBe(MERCHANT)
    expect(entry.treasuryAccount).toBe(TREASURY)
  })

  it('CONTROL: the two forms really differ, so the assertions above can fail', () => {
    expect(MERCHANT).not.toBe(MERCHANT.toLowerCase())
    expect(TREASURY).not.toBe(TREASURY.toLowerCase())
  })

  it('leaves a non-address value alone rather than inventing one', () => {
    // The file's other fixtures use `'0xmerchant'`, which is not an address.
    // Settling casing is not validating: an unexpected value stays visible.
    const entry = toAccountingEntry(row())
    expect(entry.counterparty.address).toBe('0xmerchant')
    expect(entry.treasuryAccount).toBe('0xtreasury')
  })
})

/** #3767: which hash the surfaces book — decided once here, consumed everywhere. */
describe('the booked hash (#3767)', () => {
  const FUNDING = `0x${'f1'.repeat(32)}`
  const SETTLEMENT = `0x${'5e'.repeat(32)}`

  it('books the verified merchant settlement, keeping the funding hash as secondary', () => {
    const e = toAccountingEntry(
      row({ tx_hash: FUNDING, settlement_scheme: 'eip3009', verified_settlement_tx_hash: SETTLEMENT, pinned_booked_tx_hash: null }),
    )
    expect(e.bookedTxHash).toBe(SETTLEMENT)
    expect(e.bookedTxHashIsFunding).toBe(false)
    expect(e.fundingTxHash).toBe(FUNDING)
  })

  it('labels the funding hash as funding when no settlement is recorded (the window passed)', () => {
    const e = toAccountingEntry(row({ tx_hash: FUNDING, settlement_scheme: 'eip3009' }))
    expect(e.bookedTxHash).toBe(FUNDING)
    expect(e.bookedTxHashIsFunding).toBe(true)
    expect(e.fundingTxHash).toBeNull()
  })

  it('the pin wins over a settlement recorded after the first claim — identical bytes on retries', () => {
    const e = toAccountingEntry(
      row({
        tx_hash: FUNDING,
        settlement_scheme: 'eip3009',
        verified_settlement_tx_hash: SETTLEMENT,
        pinned_booked_tx_hash: FUNDING,
        pinned_booked_tx_kind: 'funding',
      }),
    )
    expect(e.bookedTxHash).toBe(FUNDING)
    expect(e.bookedTxHashIsFunding).toBe(true)
    expect(e.fundingTxHash).toBeNull()
  })

  it('ignores a malformed pin or verified hash rather than booking it', () => {
    const e = toAccountingEntry(
      row({ tx_hash: FUNDING, settlement_scheme: 'eip3009', pinned_booked_tx_hash: 'not-a-hash', pinned_booked_tx_kind: 'funding' }),
    )
    expect(e.bookedTxHash).toBe(FUNDING)
    expect(e.bookedTxHashIsFunding).toBe(true)
  })

  it('erc7710 books its own tx hash — it already IS the settlement', () => {
    const e = toAccountingEntry(row({ tx_hash: FUNDING, settlement_scheme: 'erc7710' }))
    expect(e.bookedTxHash).toBe(FUNDING)
    expect(e.bookedTxHashIsFunding).toBe(false)
    expect(e.fundingTxHash).toBeNull()
  })

  it('retired / scheme-less rails book nothing — their rendering is unchanged', () => {
    for (const over of [{}, { settlement_scheme: null }, { settlement_scheme: 'mpp_demo' }]) {
      const e = toAccountingEntry(row(over))
      expect(e.bookedTxHash).toBeNull()
      expect(e.bookedTxHashIsFunding).toBe(false)
      expect(e.fundingTxHash).toBeNull()
      // entry.txHash keeps its raw meaning for every consumer that reads it.
      expect(e.txHash).toBe('0xabc')
    }
  })
})

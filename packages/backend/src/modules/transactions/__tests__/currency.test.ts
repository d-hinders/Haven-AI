import { describe, expect, it } from 'vitest'
import { convertedTransactionAmount } from '../currency.js'
import { TRANSACTION_CURRENCIES, DEFAULT_TRANSACTION_CURRENCY, transactionCurrencyOrDefault, isTransactionCurrency } from '../../../domain/transaction-currency.js'

/**
 * The converted triple (#3127): currency named as a FIELD, struck from the
 * row's OWN stored book-time capture, never a serve-time price read, and
 * null — never another currency — when no usable rate was captured.
 *
 * The arithmetic mirrors `modules/accounting/feed-transaction.ts`'s
 * `ledgerAmount`: SEK from the stored columns, every other currency the TOKEN
 * amount times the captured rate, at the `NUMERIC(38,4)` four-decimal scale.
 */

// A token amount of 1 USDC whose SEK value is 10.5000 at 10.5 SEK/token. The
// USD and EUR rates are the kind of map a #2877 capture freezes (one read,
// every ledger currency).
const RATE_MAP = { SEK: 10.5, USD: 1.02, EUR: 0.93, DKK: 0.69, NOK: 1.13, GBP: 0.79 }
const AMOUNT_SEK = '10.5000'
const AMOUNT_TOKEN = '1'

describe('convertedTransactionAmount', () => {
  describe('SEK — answered from the stored columns', () => {
    it('mirrors amountSek exactly, with the currency named', () => {
      const out = convertedTransactionAmount(AMOUNT_SEK, AMOUNT_TOKEN, RATE_MAP, 'SEK')
      expect(out).toEqual({
        convertedAmount: '10.5000',
        convertedCurrency: 'SEK',
        // The row already carries fxRateSek/fxSource; no restatement.
        convertedFxRate: null,
      })
    })

    it('stays null when amountSek is null (non-machine / unpriced rows)', () => {
      expect(convertedTransactionAmount(null, AMOUNT_TOKEN, RATE_MAP, 'SEK').convertedAmount).toBeNull()
      expect(convertedTransactionAmount(undefined, AMOUNT_TOKEN, null, 'SEK').convertedAmount).toBeNull()
    })

    it('ignores the rate map even when it has no SEK entry', () => {
      // The columns are the answer — a pre-082 row with SEK columns and no
      // map must convert exactly as before.
      expect(convertedTransactionAmount('2.0000', AMOUNT_TOKEN, null, 'SEK').convertedAmount).toBe('2.0000')
    })
  })

  describe('USD/EUR — the token amount times the captured rate', () => {
    it('multiplies the token amount by the rate at the four-decimal scale', () => {
      expect(convertedTransactionAmount(AMOUNT_SEK, '10.5', RATE_MAP, 'USD')).toEqual({
        convertedAmount: '10.7100',
        convertedCurrency: 'USD',
        convertedFxRate: '1.0200',
      })
      expect(convertedTransactionAmount(AMOUNT_SEK, '10.5', RATE_MAP, 'EUR')).toEqual({
        convertedAmount: '9.7650',
        convertedCurrency: 'EUR',
        convertedFxRate: '0.9300',
      })
    })

    it('does NOT re-derive from the SEK columns — a row can carry a rate but no SEK amount', () => {
      // `Number(null)` would be 0, silently; `ledgerAmount` multiplies the
      // token amount for exactly this reason.
      expect(convertedTransactionAmount(null, '10.5', RATE_MAP, 'USD')).toEqual({
        convertedAmount: '10.7100',
        convertedCurrency: 'USD',
        convertedFxRate: '1.0200',
      })
    })

    it('yields null — never a SEK fallback — when the currency has no usable rate', () => {
      // Pre-082 rows and settlement-time price outages: the row is not ready
      // to convert, and a USD label on kronor is the one wrong answer.
      expect(convertedTransactionAmount(AMOUNT_SEK, AMOUNT_TOKEN, null, 'USD')).toEqual({
        convertedAmount: null,
        convertedCurrency: 'USD',
        convertedFxRate: null,
      })
      expect(convertedTransactionAmount(AMOUNT_SEK, AMOUNT_TOKEN, {}, 'EUR').convertedAmount).toBeNull()
    })

    it('refuses a junk or non-positive rate from the stored map', () => {
      expect(convertedTransactionAmount(AMOUNT_SEK, AMOUNT_TOKEN, { USD: 'not-a-number' }, 'USD').convertedAmount).toBeNull()
      expect(convertedTransactionAmount(AMOUNT_SEK, AMOUNT_TOKEN, { USD: 0 }, 'USD').convertedAmount).toBeNull()
      expect(convertedTransactionAmount(AMOUNT_SEK, AMOUNT_TOKEN, { USD: -1 }, 'USD').convertedAmount).toBeNull()
    })

    it('accepts a numeric-string rate the way the whole-map normaliser does', () => {
      // JSONB can hand back a string rate; accounting's normalizeLedgerRates
      // accepts numeric strings, so a stored map written that way converts
      // instead of silently nulling.
      const out = convertedTransactionAmount(AMOUNT_SEK, '10.5', { USD: '1.02' }, 'USD')
      expect(out.convertedAmount).toBe('10.7100')
    })

    it('yields null when the token amount itself is unusable (mirrors ledgerAmount)', () => {
      // Negative and unparseable stay not-ready; zero converts (the SEK
      // path serves `0.0000` for a zero-value payment too).
      expect(convertedTransactionAmount(AMOUNT_SEK, 'n/a', RATE_MAP, 'USD').convertedAmount).toBeNull()
      expect(convertedTransactionAmount(AMOUNT_SEK, null, RATE_MAP, 'USD').convertedAmount).toBeNull()
      expect(convertedTransactionAmount(AMOUNT_SEK, '-1', RATE_MAP, 'USD').convertedAmount).toBeNull()
      expect(convertedTransactionAmount(AMOUNT_SEK, '0', RATE_MAP, 'USD').convertedAmount).toBe('0.0000')
    })
  })
})

describe('the offered currency set (#3127)', () => {
  it('offers SEK — the served default — alongside USD and EUR', () => {
    expect(TRANSACTION_CURRENCIES).toEqual(['SEK', 'USD', 'EUR'])
    expect(DEFAULT_TRANSACTION_CURRENCY).toBe('SEK')
  })

  it('the no-preference default is IN the offered set, so enum and serving agree', () => {
    expect(TRANSACTION_CURRENCIES).toContain(DEFAULT_TRANSACTION_CURRENCY)
  })

  it('transactionCurrencyOrDefault falls back to SEK on null and on junk', () => {
    expect(transactionCurrencyOrDefault(null)).toBe('SEK')
    expect(transactionCurrencyOrDefault(undefined)).toBe('SEK')
    expect(transactionCurrencyOrDefault('GBP')).toBe('SEK')
    expect(transactionCurrencyOrDefault('usd')).toBe('SEK') // case-sensitive column, no silent coercion
    expect(transactionCurrencyOrDefault('EUR')).toBe('EUR')
    expect(transactionCurrencyOrDefault('USD')).toBe('USD')
    expect(transactionCurrencyOrDefault('SEK')).toBe('SEK')
  })

  it('isTransactionCurrency accepts exactly the offered set', () => {
    for (const currency of TRANSACTION_CURRENCIES) {
      expect(isTransactionCurrency(currency)).toBe(true)
    }
    expect(isTransactionCurrency('GBP')).toBe(false)
    expect(isTransactionCurrency('')).toBe(false)
    expect(isTransactionCurrency(null)).toBe(false)
  })
})

import { getTokenPrice } from './prices.js'
import { type LedgerCurrency, SUPPORTED_LEDGER_CURRENCIES } from '../domain/ledger-currency.js'

export interface FiatValues {
  usd: number | null
  eur: number | null
}

export async function getFiatValuesForTokenAmount(
  tokenSymbol: string,
  amountHuman: string,
): Promise<FiatValues> {
  const amount = Number(amountHuman)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { usd: 0, eur: 0 }
  }

  try {
    const price = await getTokenPrice(tokenSymbol)
    return {
      usd: amount * price.usd,
      eur: amount * price.eur,
    }
  } catch {
    return { usd: null, eur: null }
  }
}

/** Where a captured FX rate came from. Spot at settlement for now (open Q #1). */
export const FX_SOURCE_SPOT = 'coingecko_spot'

export interface BookTimeSekValue {
  /** SEK value of the token amount at capture time. */
  amountSek: number
  /** token→SEK rate used. */
  fxRate: number
  /** Provenance string persisted alongside the value. */
  fxSource: string
}

/**
 * Book-time token→ledger-currency rates, one per currency that had a usable
 * quote. A currency missing from the map had no quote at settlement; the feed
 * for a connection booking in it stays unfed and backfillable, exactly as a
 * null SEK amount behaves.
 */
export interface BookTimeLedgerRates {
  rates: Partial<Record<LedgerCurrency, number>>
  fxSource: string
}

/**
 * The book-time SEK value of a settled token amount — captured once at
 * settlement and then frozen (see migration 026). Returns `null` when no usable
 * rate is available, so the caller persists nulls (backfillable) rather than a
 * bogus zero, and so a pricing outage never blocks settlement.
 */
export async function getBookTimeSekValue(
  tokenSymbol: string,
  amountHuman: string,
): Promise<BookTimeSekValue | null> {
  const amount = Number(amountHuman)
  if (!Number.isFinite(amount) || amount <= 0) return null

  try {
    const price = await getTokenPrice(tokenSymbol)
    if (!Number.isFinite(price.sek) || price.sek <= 0) return null
    return { amountSek: amount * price.sek, fxRate: price.sek, fxSource: FX_SOURCE_SPOT }
  } catch {
    return null
  }
}

/**
 * Book-time rates for EVERY supported ledger currency, captured in the same
 * call as the SEK value and frozen beside it (#2877).
 *
 * A map rather than one rate, because one settled payment can be fed to
 * connections that book in different currencies, and "capture once, never
 * recompute" has to survive that: the rate the feed uses is the one quoted at
 * settlement, whichever ledger asks for it later. Returns `null` on the same
 * terms as `getBookTimeSekValue` — no usable quote means nulls the caller
 * persists, never a bogus zero, and never a blocked settlement.
 */
export async function getBookTimeLedgerRates(tokenSymbol: string): Promise<BookTimeLedgerRates | null> {
  try {
    const price = await getTokenPrice(tokenSymbol)
    const rates: Partial<Record<LedgerCurrency, number>> = {}
    for (const currency of SUPPORTED_LEDGER_CURRENCIES) {
      const rate = price[currency.toLowerCase() as Lowercase<LedgerCurrency>]
      if (Number.isFinite(rate) && rate > 0) rates[currency] = rate
    }
    // A price response with no positive quote in ANY supported currency is the
    // same event as a pricing outage: nulls, backfillable.
    if (Object.keys(rates).length === 0) return null
    return { rates, fxSource: FX_SOURCE_SPOT }
  } catch {
    return null
  }
}

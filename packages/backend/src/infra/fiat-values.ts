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

/** One settlement-time capture: the SEK value and every ledger rate, one read. */
export interface BookTimeCapture extends BookTimeLedgerRates {
  /** Null when the SEK half was not usable (bad amount, or no SEK quote). */
  sek: BookTimeSekValue | null
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
 * The whole book-time capture for a settled payment: the SEK value and the
 * rate for every supported ledger currency, from ONE price read (#2877).
 *
 * One read, not two, because the two halves are persisted as one frozen
 * record: `fx_at` timestamps the capture and the map is the capture. Two
 * separate `getTokenPrice` awaits can straddle the 60 s cache boundary, so
 * one could succeed against a price the other never saw — and the row would
 * then carry a timestamp from one fetch and rates from another. Taking both
 * from the same `price` object makes that unrepresentable.
 *
 * Returns `null` only when NOTHING was usable — the same "nulls, and never a
 * bogus zero, and never a blocked settlement" contract the SEK capture has
 * had since migration 026.
 */
export async function getBookTimeCapture(
  tokenSymbol: string,
  amountHuman: string,
): Promise<BookTimeCapture | null> {
  const amount = Number(amountHuman)
  let price: Awaited<ReturnType<typeof getTokenPrice>>
  try {
    price = await getTokenPrice(tokenSymbol)
  } catch {
    return null
  }

  const rates: Partial<Record<LedgerCurrency, number>> = {}
  for (const currency of SUPPORTED_LEDGER_CURRENCIES) {
    const rate = price[currency.toLowerCase() as Lowercase<LedgerCurrency>]
    if (Number.isFinite(rate) && rate > 0) rates[currency] = rate
  }

  const sekUsable = Number.isFinite(amount) && amount > 0 && Number.isFinite(price.sek) && price.sek > 0
  const sek = sekUsable ? { amountSek: amount * price.sek, fxRate: price.sek, fxSource: FX_SOURCE_SPOT } : null

  if (!sek && Object.keys(rates).length === 0) return null
  return { sek, rates, fxSource: FX_SOURCE_SPOT }
}

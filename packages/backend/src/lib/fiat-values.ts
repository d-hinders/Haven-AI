import { getTokenPrice } from './prices.js'

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

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

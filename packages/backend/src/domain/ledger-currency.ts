/**
 * The currencies a connected ledger may book in (#2877, epic #2858).
 *
 * Lives in `domain/` because two layers that must not import each other need
 * the same list: `infra/prices.ts` quotes exactly these against the token, and
 * `modules/accounting/provider.ts` refuses a connect outside them. One list,
 * no drift — a currency the connect flow accepts but the price source cannot
 * quote would feed nothing, silently.
 *
 * The set is bounded on purpose. Every entry is a CoinGecko `vs_currencies`
 * value, so widening it is a one-line change here plus a rate that actually
 * arrives; refusing the rest AT CONNECT is what keeps the failure a clear
 * answer to the user instead of a row that never feeds.
 */

/** Supported ledger currencies, ISO-4217. SEK first: it is the default. */
export const SUPPORTED_LEDGER_CURRENCIES = ['SEK', 'EUR', 'USD', 'DKK', 'NOK', 'GBP'] as const

export type LedgerCurrency = (typeof SUPPORTED_LEDGER_CURRENCIES)[number]

/**
 * What a connection books in when the provider could not say (`base_currency`
 * null). SEK, because that is what every connection created before #2877
 * books in and what migration 080 wrote for the rows it carried over.
 */
export const DEFAULT_LEDGER_CURRENCY: LedgerCurrency = 'SEK'

export function isSupportedLedgerCurrency(value: string | null | undefined): value is LedgerCurrency {
  if (value == null) return false
  return (SUPPORTED_LEDGER_CURRENCIES as readonly string[]).includes(value.toUpperCase())
}

/**
 * The stored `base_currency` as a currency the feed can use. Null (provider
 * cannot say) and an unsupported value both fall back to the default — the
 * unsupported case is unreachable through connect, which refuses it, and the
 * fallback exists so a row written before this list can never crash a feed.
 */
export function ledgerCurrencyOrDefault(value: string | null | undefined): LedgerCurrency {
  return isSupportedLedgerCurrency(value) ? (value.toUpperCase() as LedgerCurrency) : DEFAULT_LEDGER_CURRENCY
}

/** The list as the user-facing sentence reads it: "SEK, EUR, USD, DKK, NOK and GBP". */
export function ledgerCurrencyList(): string {
  const all = [...SUPPORTED_LEDGER_CURRENCIES]
  const last = all.pop()
  return `${all.join(', ')} and ${last}`
}

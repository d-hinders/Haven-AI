/**
 * Serve-time ("at today's rate") fiat amounts for transaction-shaped rows
 * (#3824). The wire has carried book-time fiat only (`amountSek`, the
 * `converted` triple struck from the stored capture) — a row settled before
 * the preference existed, or priced at all, had no display figure. This
 * module adds the missing half WITHOUT touching the book-time provenance:
 * `convertedAmount` stays exactly what `currency.ts` struck it as, and the
 * approx amount is a separate, optional, clearly-named field.
 *
 * Pricing goes through `getServeTimeFiatValues` (`infra/fiat-values.ts`),
 * whose null-for-unknown semantics are the point: an unpriced token is
 * `null`, never `0`, so an inbound spam token cannot render "≈ 0".
 */
import { getServeTimeFiatValues } from '../../infra/fiat-values.js'
import {
  DEFAULT_TRANSACTION_CURRENCY,
  type TransactionCurrency,
} from '../../domain/transaction-currency.js'

/**
 * The serve-time amount for one token quantity, in `currency`, at the same
 * four-decimal scale every other fiat figure on the wire carries
 * (`NUMERIC(38,4)` / `toFixed(4)`). Null when the price read failed, the
 * token has no usable quote, or the amount is not a positive parseable
 * number — "unknown", never "zero".
 */
export async function serveTimeAmount(
  tokenSymbol: string | null | undefined,
  amountHuman: string | null | undefined,
  currency: TransactionCurrency = DEFAULT_TRANSACTION_CURRENCY,
): Promise<string | null> {
  const values = await getServeTimeFiatValues(tokenSymbol ?? '', amountHuman ?? '')
  const amount = values[currency.toLowerCase() as 'usd' | 'eur' | 'sek']
  return amount == null ? null : amount.toFixed(4)
}

/**
 * Stamp a converted amount and its provenance onto a transaction row (#3127).
 *
 * What a row carries, and where each half comes from:
 *
 * - `amountSek` / `fxRateSek` — the stored book-time SEK columns
 *   (`machine_payment_evidence.amount_sek` / `.fx_rate_sek`, migration 026),
 *   carried verbatim from the repository. Kept on the wire untouched: they
 *   are the additive-window originals (#2871/#2885) and the CSV export's
 *   fixed-reporting-currency branch reads them.
 * - `fxRates` — the per-row book-time rate map
 *   (`machine_payment_evidence.fx_rates`, migration 082), now SELECTed
 *   alongside the SEK columns. It freezes a rate for every supported ledger
 *   currency at settlement — that is where a USD or EUR conversion comes
 *   from, not from a fresh price read.
 * - `convertedAmount` / `convertedCurrency` / `convertedFxRate` — the NEW
 *   triple: the amount in the user's preferred currency, that currency named
 *   in a field, and the token→currency rate struck at. Computed HERE, at the
 *   enrichment boundary, from those stored figures — never recomputed at
 *   serve time.
 *
 * The arithmetic and scale deliberately mirror `modules/accounting/
 * feed-transaction.ts`'s `ledgerAmount` — the one computation this codebase
 * already owns for "a settled payment in a chosen currency": the SEK half is
 * answered from the stored columns, every other currency multiplies the TOKEN
 * amount (`valueFormatted`) by the rate frozen at settlement, at `toFixed(4)`
 * scale (the `NUMERIC(38,4)` scale `amount_sek` has always carried), so a
 * converted figure is shape-identical to a stored one and the two
 * computations cannot drift. This file deliberately does NOT import that
 * helper (or accounting's `normalizeLedgerRates`): a transactions→accounting
 * module edge would buy one multiplication, and the map here is read for ONE
 * key the type system already bounds, not normalised whole.
 *
 * Null semantics, per currency (mirroring `ledgerAmount`):
 * - SEK is answered from the SEK columns, not from the map — they are the
 *   value every pre-082 row carries, and re-deriving SEK from the map would
 *   change what existing users are served for no reason. `fxSource` already
 *   rides the row, so provenance needs no second field.
 * - Any other currency needs a usable rate in the map AND a parseable,
 *   non-negative token amount. A rate that never got captured (pre-082 rows,
 *   or a settlement-time price outage) yields null — NOT a fallback to SEK,
 *   which would hand a USD-preferring user kronor under a USD label, and NOT
 *   a serve-time spot rate, which would be a feed-time figure wearing a
 *   book-time label. Nulls are backfillable upstream; a wrong currency is
 *   not.
 */
import type { TransactionCurrency } from '../../domain/transaction-currency.js'

export interface ConvertedAmount {
  /** The token amount in `convertedCurrency`, at the feed's four-decimal scale. */
  convertedAmount: string | null
  /** Which currency `convertedAmount` is denominated in. */
  convertedCurrency: TransactionCurrency
  /** The token→`convertedCurrency` rate the amount was struck at. */
  convertedFxRate: string | null
}

/**
 * One defensive read of the stored rate map for the one currency being
 * served. The map is JSONB written by whatever build settled the row, so the
 * value is trusted only when it is a positive finite number (a numeric
 * string is accepted the way accounting's whole-map normaliser accepts one);
 * anything else — including a map from before migration 082, which is simply
 * absent — yields null, and null means "not ready", never "another currency".
 */
function usableRate(fxRates: unknown, currency: TransactionCurrency): number | null {
  if (fxRates == null || typeof fxRates !== 'object') return null
  const raw = (fxRates as Record<string, unknown>)[currency]
  const numeric = typeof raw === 'string' ? Number(raw) : raw
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

export function convertedTransactionAmount(
  amountSek: string | null | undefined,
  amountHuman: string | null | undefined,
  fxRates: unknown,
  currency: TransactionCurrency,
): ConvertedAmount {
  if (currency === 'SEK') {
    // The stored columns ARE the SEK answer — same value, same provenance,
    // same four-decimal scale. SEK comes with a rate already on the row
    // (`fxRateSek`); it is not restated here, so `convertedFxRate` stays
    // null on this path — DELIBERATE, and unlike the non-SEK branches
    // below, which return their rate. A consumer wanting the default
    // currency's rate reads the row's `fxRateSek`, same as the mirrored
    // `ledgerAmount` surface does; the asymmetry is documented rather than
    // silently bridged, because restating `fxRateSek` under a second name
    // would give the same figure two provenance stories.
    return {
      convertedAmount: amountSek ?? null,
      convertedCurrency: 'SEK',
      convertedFxRate: null,
    }
  }

  const rate = usableRate(fxRates, currency)
  if (rate == null) {
    return {
      convertedAmount: null,
      convertedCurrency: currency,
      convertedFxRate: null,
    }
  }

  // Mirror `ledgerAmount`: non-SEK amounts are the TOKEN amount times the
  // captured rate — never re-derived from the SEK columns, which a row can
  // lack entirely (no SEK quote at settlement) while still carrying a usable
  // USD/EUR rate. A zero amount converts (the SEK path serves `0.0000` too);
  // negative and unparseable stay not-ready.
  const tokenAmount = Number(amountHuman ?? NaN)
  if (!Number.isFinite(tokenAmount) || tokenAmount < 0) {
    return {
      convertedAmount: null,
      convertedCurrency: currency,
      convertedFxRate: null,
    }
  }

  return {
    convertedAmount: (tokenAmount * rate).toFixed(4),
    convertedCurrency: currency,
    convertedFxRate: rate.toFixed(4),
  }
}

import { DEFAULT_LEDGER_CURRENCY, type LedgerCurrency } from '../../domain/ledger-currency.js'
import type { AccountingEntry } from './entry.js'

/**
 * Non-asserting transaction shape for the reporting feed (epic #491, P1 #495).
 *
 * Derived from the canonical `AccountingEntry` but **stripped of asserted
 * accounting judgment**: no `vatTreatment`, no posted debit/credit lines, no
 * chosen BAS account. It carries only what a source-document feed needs so the
 * accountant codes and confirms. Making the type itself omit those fields makes
 * it structurally impossible to feed asserted VAT/accounts downstream.
 *
 * Book-time SEK / FX is reused verbatim from the entry (frozen at settlement,
 * #467) — never recomputed.
 *
 * Since #2877 the amount a connector actually pushes is `amountLedger` in
 * `ledgerCurrency` — the destination's own booking currency, converted with
 * the rate frozen at settlement. For a SEK ledger that is the same number
 * `amountSek` has always carried, from the same captured rate; `amountSek`
 * stays on the shape because the SEK columns are what every pre-#2877 row and
 * the receipt underlag hold.
 */
export interface FeedTransaction {
  paymentId: string
  settledAt: string
  direction: 'out' | 'in'
  counterparty: { address: string | null; name: string | null }
  resourceUrl: string | null
  token: string
  amountAtomic: string
  amountSek: string | null
  /** The destination ledger's booking currency (#2877). */
  ledgerCurrency: LedgerCurrency
  /**
   * The amount in `ledgerCurrency`, from the rate frozen at settlement. Null
   * when no rate for that currency was captured — the row is then not ready to
   * feed and stays backfillable, exactly as a null `amountSek` behaves.
   */
  amountLedger: string | null
  /**
   * The token→`ledgerCurrency` rate used for `amountLedger`. For a SEK ledger
   * this is `fxRate` — same captured value, same provenance.
   */
  fxRateLedger: string | null
  fxRate: string | null
  fxSource: string | null
  fxAt: string | null
  /** The underlag to attach (verifiable receipt / evidence). */
  receiptRef: string
  /** The merchant's own receipt when captured (#956) — attached as a second file. */
  merchantReceipt?: { url: string | null; inlineJson: unknown | null } | null
  /** A *suggestion* only (the user's per-merchant override) — never an asserted account. */
  suggestedAccount?: string | null
}

/**
 * Normalize a pg timestamptz passthrough (Date at runtime despite the string
 * type) to ISO. Tolerant: an unparseable value passes through as-is — fxAt is
 * provenance metadata and must never be able to crash the feed.
 */
function toIso(value: string | null): string | null {
  if (value == null) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
}

/**
 * The amount to push, in the destination's booking currency (#2877).
 *
 * SEK is answered from the SEK columns rather than from the rate map, on
 * purpose: those columns are the value every row settled before migration 082
 * carries, and re-deriving a SEK amount from a newer map would change what a
 * SEK ledger is fed for reasons that have nothing to do with this change.
 *
 * Every other currency multiplies the token amount by the rate frozen at
 * settlement. No rate for that currency means null — not a fallback to SEK,
 * which would push Swedish kronor into a Danish ledger as though they were
 * Danish, and not a recomputed spot rate, which would silently be a rate from
 * feed time wearing a book-time label.
 *
 * The arithmetic is float, and deliberately kept to the same precision the SEK
 * path has always used: the amount is a source-document figure an accountant
 * confirms, not a posted balance.
 */
function ledgerAmount(entry: AccountingEntry, currency: LedgerCurrency): { amount: string | null; rate: string | null } {
  if (currency === DEFAULT_LEDGER_CURRENCY) return { amount: entry.amountSek, rate: entry.fxRate }
  const rate = entry.fxRates?.[currency]
  if (rate == null) return { amount: entry.amountSek, rate: entry.fxRate }
  const tokenAmount = Number(entry.amountHuman ?? NaN)
  // A zero amount is fed, not withheld: `amount_sek` stores 0.0000 for one and
  // the SEK path pushes it, so withholding it here would make a zero-value
  // payment feed to a Swedish ledger and hang forever — unclaimed, unfeedable,
  // re-evaluated by every sweep — for a Danish one. Negative and unparseable
  // stay not-ready; neither is a state a settled payment reaches.
  if (!Number.isFinite(tokenAmount) || tokenAmount < 0) return { amount: null, rate: null }
  return { amount: toLedgerScale(tokenAmount * rate), rate: toLedgerScale(rate) }
}

/**
 * A money figure at the scale the SEK column has always used.
 *
 * `amount_sek` is `NUMERIC(38,4)` (migration 026), so every SEK figure the
 * feed has ever pushed came back from Postgres fixed at four decimals. A
 * computed currency has no column to round it, and raw float stringification
 * puts `11.462000000000002` — or, under 1e-6, `9.2e-7` — straight onto a
 * supplier invoice: 15 junk decimals a provider may reject, and exponent
 * notation no accounting system reads as a number. Fixing the scale here is
 * what makes a computed amount indistinguishable in shape from a stored one.
 *
 * The no-exponent property holds below 1e21, where `toFixed` switches to
 * exponent form regardless. Nothing a budget-constrained settlement can reach,
 * and `NUMERIC(38,4)` would be out of range there too — recorded because the
 * sentence above would otherwise read as unconditional.
 */
function toLedgerScale(value: number): string {
  return value.toFixed(LEDGER_SCALE)
}

/** Decimals on a fed money figure — `amount_sek`'s own scale (migration 026). */
const LEDGER_SCALE = 4

/**
 * Reduce a canonical entry to the non-asserting feed shape.
 *
 * `suggestedAccount` (#2867): the entry's per-merchant override wins; the
 * connection's `settings.suggested_account` is the fallback for everything
 * else. Either way it lands in the SAME field — a suggestion the connector
 * may surface only as its non-asserting hint (Fortnox: `YourReference`),
 * never as an `Account` key; `assertNonAsserting` is the guard on that.
 */
export function toFeedTransaction(
  entry: AccountingEntry,
  opts: { connectionSuggestedAccount?: string | null; ledgerCurrency: LedgerCurrency },
): FeedTransaction {
  const { ledgerCurrency } = opts
  const ledger = ledgerAmount(entry, ledgerCurrency)
  return {
    paymentId: entry.paymentId,
    // The type says ISO string, but the entry builder hands through pg's
    // timestamptz values, which arrive as Date objects at runtime — found
    // live on the first real feed (tx.settledAt.slice is not a function).
    // Normalize at this boundary so every connector downstream gets the
    // contract the type promises. fxAt is the same passthrough (mpe.fx_at,
    // rendered on the #498 receipt underlag) — same normalization.
    settledAt: new Date(entry.settledAt).toISOString(),
    direction: entry.direction,
    counterparty: { address: entry.counterparty.address, name: entry.counterparty.name },
    resourceUrl: entry.resourceUrl,
    token: entry.token,
    amountAtomic: entry.amountAtomic,
    amountSek: entry.amountSek,
    ledgerCurrency,
    amountLedger: ledger.amount,
    fxRateLedger: ledger.rate,
    fxRate: entry.fxRate,
    fxSource: entry.fxSource,
    fxAt: toIso(entry.fxAt),
    receiptRef: entry.receiptRef,
    merchantReceipt: entry.merchantReceipt ?? null,
    suggestedAccount: entry.account ?? opts.connectionSuggestedAccount ?? null,
  }
}

import type { AccountingEntry } from '../accounting-entry.js'

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
 */
export interface ReportingTransaction {
  paymentId: string
  settledAt: string
  direction: 'out' | 'in'
  counterparty: { address: string | null; name: string | null }
  resourceUrl: string | null
  token: string
  amountAtomic: string
  amountSek: string | null
  fxRate: string | null
  fxSource: string | null
  fxAt: string | null
  /** The underlag to attach (verifiable receipt / evidence). */
  receiptRef: string
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

/** Reduce a canonical entry to the non-asserting feed shape. */
export function toReportingTransaction(entry: AccountingEntry): ReportingTransaction {
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
    fxRate: entry.fxRate,
    fxSource: entry.fxSource,
    fxAt: toIso(entry.fxAt),
    receiptRef: entry.receiptRef,
    suggestedAccount: entry.account ?? null,
  }
}

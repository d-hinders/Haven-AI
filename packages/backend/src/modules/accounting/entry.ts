// dep-lint-exempt: both statements assemble their WHERE/LIMIT at runtime around the shared ENTRY_SOURCE_SQL join fragment, so there is no fixed statement for db-schema-smoke to PREPARE; extraction needs the fragment redesigned first (beyond #999's ~100-line budget)
import pool from '../../db.js'
import { isSupportedLedgerCurrency, type LedgerCurrency } from '../../domain/ledger-currency.js'
import { vatTreatmentForCountry } from '../../domain/vat.js'

/**
 * Canonical accounting record for bookkeeping-ready export (epic #462, P0 #463).
 *
 * One entry per settled machine payment, derived from settlement evidence plus
 * the book-time FX captured at settlement (migration 026). This is the single
 * shape every exporter (CSV, SIE 4I, Fortnox) reads — see
 * `docs/research/bookkeeping-ready-export.md` §5.
 *
 * Monetary fields are kept as strings (NUMERIC from Postgres) to avoid float
 * rounding in records an accountant will file.
 */
export type VatTreatment = 'none' | 'reverse_charge' | 'standard'

/** Book-time token→currency rates, one entry per currency quoted at settlement. */
export type LedgerRates = Partial<Record<LedgerCurrency, number>>

/**
 * Read `fx_rates` defensively: it is JSONB written by an older or newer build,
 * so anything that is not a positive finite rate for a currency this build
 * supports is dropped rather than trusted. A stored currency Haven no longer
 * supports therefore disappears instead of reaching a payload.
 */
export function normalizeLedgerRates(value: unknown): LedgerRates | null {
  if (value == null || typeof value !== 'object') return null
  const out: LedgerRates = {}
  for (const [currency, rate] of Object.entries(value as Record<string, unknown>)) {
    if (!isSupportedLedgerCurrency(currency)) continue
    const numeric = typeof rate === 'string' ? Number(rate) : rate
    if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) continue
    out[currency.toUpperCase() as LedgerCurrency] = numeric
  }
  return Object.keys(out).length > 0 ? out : null
}

export interface AccountingEntry {
  paymentId: string
  txHash: string
  chainId: number
  settledAt: string
  /** out = expense (agent payment), in = income/refund. */
  direction: 'out' | 'in'
  counterparty: {
    address: string | null
    name: string | null
    /** Supplier country, for VAT treatment. Not resolved yet — P3. */
    country: string | null
  }
  token: string
  amountAtomic: string
  /**
   * The token amount in human decimals (`machine_payment_evidence.amount_human`).
   * Carried since #2877 because a non-SEK ledger amount is this figure times
   * the rate frozen at settlement; the SEK amount is a stored column and needs
   * no such multiplication.
   */
  amountHuman: string | null
  /** Book-time SEK value + provenance; null when no rate was captured. */
  amountSek: string | null
  fxRate: string | null
  fxSource: string | null
  fxAt: string | null
  /**
   * Book-time token→currency rates for every supported ledger currency that
   * had a usable quote at settlement (#2877). Frozen with the row; the feed
   * reads the destination's currency out of it and never recomputes. Null on
   * rows settled before migration 082, and on a settlement-time price outage.
   */
  fxRates: LedgerRates | null
  /** Haven fee in SEK. Null until the fee ledger (#386) lands. */
  feeSek: string | null
  /** Merchant category from the catalog; feeds the BAS account map. */
  category: string | null
  /** Explicit per-merchant BAS account override (P3); null = use the map. */
  account: string | null
  vatTreatment: VatTreatment
  resourceUrl: string | null
  /** Underlag: the settlement evidence backing this entry. */
  receiptRef: string
  /** The merchant's OWN receipt when the agent captured one (#956); absent/null = none. */
  merchantReceipt?: { url: string | null; inlineJson: unknown | null } | null
}

/** Shape selected from `machine_payment_evidence` for one settled payment. */
export interface AccountingEntrySourceRow {
  id: string
  payment_intent_id: string | null
  approval_request_id: string | null
  tx_hash: string
  chain_id: number
  merchant_address: string | null
  token_symbol: string
  amount_raw: string
  amount_human: string | null
  amount_sek: string | null
  fx_rate_sek: string | null
  fx_source: string | null
  fx_at: string | null
  /** `machine_payment_evidence.fx_rates` (migration 082); pg hands back parsed JSONB. */
  fx_rates: LedgerRates | null
  resource_url: string | null
  confirmed_at: string | null
  created_at: string
  /** From the merchant catalog (LEFT JOIN). */
  category: string | null
  /** Supplier country (ISO-2) from the merchant catalog; drives VAT treatment. */
  country: string | null
  /** From the user's per-merchant account overrides (LEFT JOIN). */
  override_account: string | null
  /** Haven fee in SEK from the fee ledger (LEFT JOIN); null while fees are dark. */
  fee_sek: string | null
  /** Merchant-issued receipt (LEFT JOIN merchant_receipts, #956). */
  merchant_receipt_url?: string | null
  merchant_receipt_json?: unknown
}

/**
 * Pure mapping evidence row → canonical entry. Kept separate from the query so
 * the accounting judgment (direction, VAT default) is unit-testable.
 *
 * VAT treatment is derived from the supplier country (#466): SE → standard
 * (domestic), everything else / unknown → reverse charge (the dominant foreign
 * agent-spend case). The EU-vs-non-EU purchase account is resolved at booking
 * time. It remains a flagged treatment the accountant confirms.
 */
export function toAccountingEntry(row: AccountingEntrySourceRow): AccountingEntry {
  return {
    paymentId: row.payment_intent_id ?? row.approval_request_id ?? row.id,
    txHash: row.tx_hash,
    chainId: row.chain_id,
    settledAt: row.confirmed_at ?? row.created_at,
    direction: 'out',
    counterparty: { address: row.merchant_address, name: null, country: row.country ?? null },
    token: row.token_symbol,
    amountAtomic: row.amount_raw,
    amountHuman: row.amount_human,
    amountSek: row.amount_sek,
    fxRate: row.fx_rate_sek,
    fxSource: row.fx_source,
    fxAt: row.fx_at,
    fxRates: normalizeLedgerRates(row.fx_rates),
    feeSek: row.fee_sek ?? null,
    category: row.category ?? null,
    account: row.override_account ?? null,
    vatTreatment: vatTreatmentForCountry(row.country),
    resourceUrl: row.resource_url,
    receiptRef: row.id,
    merchantReceipt:
      row.merchant_receipt_url != null || row.merchant_receipt_json != null
        ? { url: row.merchant_receipt_url ?? null, inlineJson: row.merchant_receipt_json ?? null }
        : null,
  }
}

/** Shared column + join body for the canonical entry source. */
const ENTRY_SOURCE_SQL = `
  mpe.id, mpe.payment_intent_id, mpe.approval_request_id, mpe.tx_hash, mpe.chain_id,
  mpe.merchant_address, mpe.token_symbol, mpe.amount_raw, mpe.amount_human,
  mpe.amount_sek, mpe.fx_rate_sek, mpe.fx_source, mpe.fx_at, mpe.fx_rates,
  mpe.resource_url, mpe.confirmed_at, mpe.created_at,
  mc.category AS category,
  mc.country AS country,
  mao.bas_account AS override_account,
  pf.fee_sek AS fee_sek,
  mr.url AS merchant_receipt_url,
  mr.inline_json AS merchant_receipt_json
  FROM machine_payment_evidence mpe
  LEFT JOIN LATERAL (
    SELECT category, country FROM merchant_catalog
    WHERE resource_url = mpe.resource_url AND status != 'delisted'
    LIMIT 1
  ) mc ON TRUE
  LEFT JOIN merchant_account_overrides mao
    ON mao.user_id = mpe.user_id AND mao.resource_url = mpe.resource_url
  LEFT JOIN payment_fees pf
    ON pf.payment_id = COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT)
  LEFT JOIN merchant_receipts mr
    ON mr.evidence_id = mpe.id`

export interface BuildAccountingEntriesOptions {
  userId: string
  /** ISO timestamps; inclusive lower / exclusive upper bound on settlement. */
  from?: string
  to?: string
  limit?: number
}

/** Build the canonical accounting entry for a single settled payment. */
export async function buildAccountingEntryForPayment(
  userId: string,
  paymentId: string,
): Promise<AccountingEntry | null> {
  const result = await pool.query<AccountingEntrySourceRow>(
    `SELECT ${ENTRY_SOURCE_SQL}
     WHERE mpe.user_id = $1
       AND COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT) = $2
     LIMIT 1`,
    [userId, paymentId],
  )
  const row = result.rows[0]
  return row ? toAccountingEntry(row) : null
}

/** Build the canonical accounting entries for a user over a period. */
export async function buildAccountingEntries(
  opts: BuildAccountingEntriesOptions,
): Promise<AccountingEntry[]> {
  const params: unknown[] = [opts.userId]
  let where = 'mpe.user_id = $1'
  if (opts.from) {
    params.push(opts.from)
    where += ` AND COALESCE(mpe.confirmed_at, mpe.created_at) >= $${params.length}`
  }
  if (opts.to) {
    params.push(opts.to)
    where += ` AND COALESCE(mpe.confirmed_at, mpe.created_at) < $${params.length}`
  }
  params.push(opts.limit ?? 1000)
  const limitParam = `$${params.length}`

  const result = await pool.query<AccountingEntrySourceRow>(
    `SELECT ${ENTRY_SOURCE_SQL}
     WHERE ${where}
     ORDER BY COALESCE(mpe.confirmed_at, mpe.created_at) DESC
     LIMIT ${limitParam}`,
    params,
  )

  return result.rows.map(toAccountingEntry)
}

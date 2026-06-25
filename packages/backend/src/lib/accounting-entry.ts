import pool from '../db.js'
import { vatTreatmentForCountry } from './vat.js'

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
  /** Book-time SEK value + provenance; null when no rate was captured. */
  amountSek: string | null
  fxRate: string | null
  fxSource: string | null
  fxAt: string | null
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
  amount_sek: string | null
  fx_rate_sek: string | null
  fx_source: string | null
  fx_at: string | null
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
    amountSek: row.amount_sek,
    fxRate: row.fx_rate_sek,
    fxSource: row.fx_source,
    fxAt: row.fx_at,
    feeSek: row.fee_sek ?? null,
    category: row.category ?? null,
    account: row.override_account ?? null,
    vatTreatment: vatTreatmentForCountry(row.country),
    resourceUrl: row.resource_url,
    receiptRef: row.id,
  }
}

/** Shared column + join body for the canonical entry source. */
const ENTRY_SOURCE_SQL = `
  mpe.id, mpe.payment_intent_id, mpe.approval_request_id, mpe.tx_hash, mpe.chain_id,
  mpe.merchant_address, mpe.token_symbol, mpe.amount_raw,
  mpe.amount_sek, mpe.fx_rate_sek, mpe.fx_source, mpe.fx_at,
  mpe.resource_url, mpe.confirmed_at, mpe.created_at,
  mc.category AS category,
  mc.country AS country,
  mao.bas_account AS override_account,
  pf.fee_sek AS fee_sek
  FROM machine_payment_evidence mpe
  LEFT JOIN LATERAL (
    SELECT category, country FROM merchant_catalog
    WHERE resource_url = mpe.resource_url AND status != 'delisted'
    LIMIT 1
  ) mc ON TRUE
  LEFT JOIN merchant_account_overrides mao
    ON mao.user_id = mpe.user_id AND mao.resource_url = mpe.resource_url
  LEFT JOIN payment_fees pf
    ON pf.payment_id = COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT)`

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

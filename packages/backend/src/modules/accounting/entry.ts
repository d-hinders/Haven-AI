// dep-lint-exempt: both statements assemble their WHERE/LIMIT at runtime around the shared ENTRY_SOURCE_SQL join fragment, so there is no fixed statement for db-schema-smoke to PREPARE; extraction needs the fragment redesigned first (beyond #999's ~100-line budget)
import pool from '../../db.js'
import { isSupportedLedgerCurrency, type LedgerCurrency } from '../../domain/ledger-currency.js'
import { vatTreatmentForCountry } from '../../domain/vat.js'
// dep-lint-exempt: the transactions barrel re-exports transactions/accounting.ts, which imports the accounting barrel, so importing toCanonicalAddress through it closes an accounting ↔ transactions cycle; normalize.ts is a zero-import leaf (#4379)
import { toCanonicalAddress } from '../transactions/normalize.js'
import {
  deriveTransactionKind,
  transactionDescription,
  type TransactionKind,
} from './transaction-kind.js'
import {
  DIRECT_PAYMENT_OUTSIDE_ADDRESS_SQL,
  DIRECT_PAYMENT_RAIL_SQL,
} from '../../infra/repositories/direct-payment-accounting.js'

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
  /**
   * #2960: our own side of the entry — `machine_payment_evidence.payer_address`,
   * which is `parties.treasury_account` on every other surface (written from
   * `intent.account_address` at settlement, `modules/mpp/evidence.ts`). Named
   * explicitly rather than left implicit: before #2960 this feed booked ONLY
   * the merchant (`counterparty` below) and never stated which address was
   * "our side" anywhere in code — see `docs/operations/accounting-feed.md`.
   */
  treasuryAccount: string | null
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
  /**
   * #3767: the hash the accounting surfaces BOOK — the verified merchant
   * settlement when one is recorded (or is pinned from the payment's first
   * claim), else the funding hash, labelled as funding. Null on retired /
   * legacy rails, whose rendering stays exactly as it was.
   */
  bookedTxHash: string | null
  /** True when `bookedTxHash` is the eip3009 FUNDING leg (the fallback after the window). */
  bookedTxHashIsFunding: boolean
  /** The funding leg, shown as secondary reference when a settlement hash is booked (eip3009). */
  fundingTxHash: string | null
  /** `payment_intents.machine_metadata->>'settlement_scheme'`; null on scheme-less rows. */
  settlementScheme: string | null
  /** The on-chain-verified merchant settlement hash, read at entry-build time; null when none recorded. */
  verifiedSettlementTxHash: string | null
  /** The booked-hash pin written at the payment's first claim (#3767 B2); null when unpinned. */
  pinnedBookedTxHash: string | null
  pinnedBookedTxKind: 'settlement' | 'funding' | null
  /** Merchant category from the catalog; feeds the BAS account map. */
  category: string | null
  /** Explicit per-merchant BAS account override (P3); null = use the map. */
  account: string | null
  vatTreatment: VatTreatment
  resourceUrl: string | null
  /** Underlag: the settlement evidence backing this entry. */
  receiptRef: string
  /**
   * #4532: what KIND of transaction this is, derived server-side from the
   * payment record (`transaction-kind.ts`) — never asserted by an agent, and
   * never guessed: a payment with no derivable signal is `unknown`.
   */
  transactionKind: TransactionKind
  /**
   * #4532: the accountant-facing one-line description that carries the kind,
   * e.g. `api.bitrefill.com - invoice/pay (purchase)`. Rendered on the receipt
   * underlag and carried on the feed payload beside the kind.
   */
  transactionDescription: string
  /**
   * #4534: the purchase correlation key. `purchaseGroupId` is the merchant's
   * own invoice/order id (or an agent-supplied group key) shared by every
   * payment of one purchase; `parentReceiptRef` is the purchase's receipt
   * (evidence) id — the `receiptRef` of the purchase leg a fee call paid for,
   * NOT a payment id. Both null on an ungrouped payment — which is fed exactly
   * as before, never withheld.
   *
   * #4577: named `parentReceiptRef` to match `receiptRef`, which is what it
   * joins to. The stored column stays `parent_payment_id` (no migration).
   */
  purchaseGroupId: string | null
  parentReceiptRef: string | null
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
  /** #2960: our own side — `parties.treasury_account` on every other surface. */
  payer_address: string | null
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
  /** #4534: the purchase correlation key (migration 123). */
  purchase_group_id?: string | null
  parent_payment_id?: string | null
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
  /**
   * #4532: the deliverable the agent named with the x402 outcome
   * (`machine_payment_evidence.delivery_reference`, migration 107 / #3778) —
   * one of the transaction-kind signals.
   */
  delivery_reference?: string | null
  /**
   * #4532: the MCP tool the payment called
   * (`payment_intents.machine_metadata->'mcp_call_context'->>'toolName'`,
   * #1307) — the route signal for an MCP purchase, whose resource URL is the
   * merchant's single endpoint and names nothing.
   */
  mcp_tool_name?: string | null
  /**
   * #4578: which branch of `ENTRY_SOURCE_SQL` produced this row — `TRUE` on
   * the `payment_intents` (direct-payment) branch, `FALSE` on the
   * `machine_payment_evidence` branch. A literal the SQL writes, never an
   * intent column, so no agent-written metadata can set it. Optional in the
   * TYPE only because test fixtures predate the column; the SQL always
   * selects it.
   */
  is_direct_payment?: boolean | null
  /**
   * The intent-side fields (#3767). Optional in the TYPE only because test
   * fixtures predate the join; the SQL always selects them (null without an
   * intent row).
   */
  settlement_scheme?: string | null
  /** The on-chain-verified merchant settlement hash (#3475), via the same join. */
  verified_settlement_tx_hash?: string | null
  /** The #3767 booked-hash pin, via the same join. */
  pinned_booked_tx_hash?: string | null
  pinned_booked_tx_kind?: string | null
  /**
   * #4533: the DIRECT-payment branch's book-time fiat capture, written by
   * `confirmSubmittedIntent` (`payment_intents.usd_value`/`eur_value`/
   * `sek_value`). Absent on the evidence branch, which carries `fx_rates`
   * instead — see `ledgerRatesFromFiatValues`.
   */
  usd_value?: string | null
  eur_value?: string | null
  sek_value?: string | null
}

/**
 * #4533: recover a token→currency rate map from the three fiat values a direct
 * payment froze at settlement.
 *
 * A direct payment has no `machine_payment_evidence` row, so it has no
 * `fx_rates` map — but `confirmSubmittedIntent` wrote the same book-time
 * capture to the intent (`usd_value`/`eur_value`/`sek_value`, migrations 005
 * and 090). Dividing each by the token amount recovers the rate it was
 * computed from, so a non-SEK ledger can book a direct payment exactly as it
 * books an x402 one. Currencies the intent never priced (DKK/NOK/GBP) stay
 * absent, which the feed reads as not-ready — never as a recomputed spot rate.
 *
 * Returns null when there is no usable capture, so the caller falls back to
 * `normalizeLedgerRates(row.fx_rates)`'s own null.
 */
export function ledgerRatesFromFiatValues(
  row: Pick<AccountingEntrySourceRow, 'amount_human' | 'usd_value' | 'eur_value' | 'sek_value'>,
): LedgerRates | null {
  const amount = Number(row.amount_human)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const out: LedgerRates = {}
  const pairs: Array<[LedgerCurrency, string | null | undefined]> = [
    ['SEK', row.sek_value],
    ['USD', row.usd_value],
    ['EUR', row.eur_value],
  ]
  for (const [currency, value] of pairs) {
    const numeric = value == null ? Number.NaN : Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) continue
    out[currency] = numeric / amount
  }
  return Object.keys(out).length > 0 ? out : null
}

/** A 0x-prefixed 32-byte transaction hash — the same recognizer evidence.ts applies. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * #3767: which hash the accounting surfaces book, and how it is labelled.
 *
 * - **erc7710** settles in ONE transaction (`tx_hash` IS the settlement) — it
 *   is booked as before, never deferred (#3763's rule).
 * - **eip3009** is a two-leg bridge: the verified merchant settlement
 *   (`machine_metadata.merchant_settlement_tx_hash`, written only after
 *   on-chain verification — reported by the agent (#3475), detected from the
 *   chain by the #3888 settlement sweep, or recorded by the #4319 proof
 *   ladder (Tier 1 signed header; Tier 2 receipt hash under the flag and its
 *   seven limits)) is THE payment — the same hash #3763's Haven UI and the
 *   explorer headline. A PINNED hash (written at the payment's first feed claim) wins
 *   over anything recorded since, so retries render identical bytes (B2).
 *   With neither, the funding hash is booked and LABELLED as funding.
 * - **Retired / scheme-less rails are unchanged**: `bookedTxHash` null and
 *   every rendering falls back to the raw `tx_hash`, exactly as before this
 *   contract existed (characterization-tested).
 */
export function bookedHashForEntry(row: AccountingEntrySourceRow): {
  bookedTxHash: string | null
  bookedTxHashIsFunding: boolean
  fundingTxHash: string | null
} {
  if (row.settlement_scheme === 'erc7710') {
    return { bookedTxHash: row.tx_hash, bookedTxHashIsFunding: false, fundingTxHash: null }
  }
  if (row.settlement_scheme !== 'eip3009') {
    return { bookedTxHash: null, bookedTxHashIsFunding: false, fundingTxHash: null }
  }
  if (row.pinned_booked_tx_hash && TX_HASH_RE.test(row.pinned_booked_tx_hash)) {
    return {
      bookedTxHash: row.pinned_booked_tx_hash.toLowerCase(),
      bookedTxHashIsFunding: row.pinned_booked_tx_kind === 'funding',
      fundingTxHash: null,
    }
  }
  if (row.verified_settlement_tx_hash && TX_HASH_RE.test(row.verified_settlement_tx_hash)) {
    return {
      bookedTxHash: row.verified_settlement_tx_hash.toLowerCase(),
      bookedTxHashIsFunding: false,
      fundingTxHash: row.tx_hash,
    }
  }
  return { bookedTxHash: row.tx_hash, bookedTxHashIsFunding: true, fundingTxHash: null }
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
  const booked = bookedHashForEntry(row)
  // #4533: the evidence branch carries `fx_rates`; the direct branch carries
  // the three fiat values instead. One entry shape either way.
  const fxRates = normalizeLedgerRates(row.fx_rates) ?? ledgerRatesFromFiatValues(row)
  // #4532: the transaction kind, derived from the stored payment record — the
  // direction, the direct-payment rail, the x402 route, the intent's MCP tool,
  // the merchant's own document and the delivery reference. Nothing here is
  // agent-asserted: the agent can report a document or a deliverable, never a
  // kind.
  const direction = 'out' as const
  // #4578: which branch produced this row. A literal the SQL writes, so no
  // agent-written metadata can set it.
  const directPayment = row.is_direct_payment === true
  const kind = deriveTransactionKind({
    direction,
    directPayment,
    resourceUrl: row.resource_url,
    mcpToolName: row.mcp_tool_name ?? null,
    merchantReceiptJson: row.merchant_receipt_json ?? null,
    deliveryReference: row.delivery_reference ?? null,
  })
  // #3129: the same canonical form the transaction feed emits. Before that
  // change both were lowercase and agreed by accident; normalising only the
  // feed would have made ONE payment read `0xabcd…1234` on its bookkeeping
  // underlag and `0xAbCd…1234` in the transaction it documents. Both sides of
  // the entry go through it, and #4578's description label reuses the
  // counterparty's canonical form so the two lines cannot disagree.
  const counterpartyAddress = toCanonicalAddress(row.merchant_address)
  return {
    paymentId: row.payment_intent_id ?? row.approval_request_id ?? row.id,
    txHash: row.tx_hash,
    bookedTxHash: booked.bookedTxHash,
    bookedTxHashIsFunding: booked.bookedTxHashIsFunding,
    fundingTxHash: booked.fundingTxHash,
    settlementScheme: row.settlement_scheme ?? null,
    verifiedSettlementTxHash: row.verified_settlement_tx_hash ?? null,
    pinnedBookedTxHash: row.pinned_booked_tx_hash ?? null,
    pinnedBookedTxKind:
      row.pinned_booked_tx_kind === 'funding' || row.pinned_booked_tx_kind === 'settlement'
        ? row.pinned_booked_tx_kind
        : null,
    chainId: row.chain_id,
    settledAt: row.confirmed_at ?? row.created_at,
    direction,
    // #2960: our own side — `parties.treasury_account` on every other surface.
    treasuryAccount: toCanonicalAddress(row.payer_address ?? null),
    counterparty: {
      address: counterpartyAddress,
      name: null,
      country: row.country ?? null,
    },
    token: row.token_symbol,
    amountAtomic: row.amount_raw,
    amountHuman: row.amount_human,
    amountSek: row.amount_sek,
    fxRate: row.fx_rate_sek,
    fxSource: row.fx_source,
    fxAt: row.fx_at,
    fxRates,
    feeSek: row.fee_sek ?? null,
    category: row.category ?? null,
    account: row.override_account ?? null,
    vatTreatment: vatTreatmentForCountry(row.country),
    resourceUrl: row.resource_url,
    receiptRef: row.id,
    // #4532: the kind and the line that carries it. The merchant label is the
    // counterparty's name when the entry has one — it does not today, so the
    // resource host renders, the same host on every receipt of one merchant.
    // #4578: a direct payment has no resource host, so its label is the
    // counterparty's canonical address — the same form the underlag's
    // `Counterparty` line prints — and the line reads `<address> (transfer)`.
    transactionKind: kind.kind,
    transactionDescription: transactionDescription(
      kind.kind,
      directPayment ? counterpartyAddress : null,
      row.resource_url,
      kind.route,
    ),
    // #4534: the purchase correlation key, read straight off the evidence row.
    // #4577: the column is `parent_payment_id`; the entry names it for what it
    // holds — the parent purchase's `receiptRef`.
    purchaseGroupId: row.purchase_group_id ?? null,
    parentReceiptRef: row.parent_payment_id ?? null,
    merchantReceipt:
      row.merchant_receipt_url != null || row.merchant_receipt_json != null
        ? { url: row.merchant_receipt_url ?? null, inlineJson: row.merchant_receipt_json ?? null }
        : null,
  }
}

/**
 * Shared column + join body for the canonical entry source.
 *
 * TWO sources, one shape (#4533). The first is `machine_payment_evidence` —
 * protocol payments (x402/mpp/spt), the only source before #4533. The second
 * is `payment_intents` itself, for a settled DIRECT payment, which never gets
 * an evidence row (the rail gate refuses it, and `resource_url` is NOT NULL
 * there). Both branches emit the same columns so every caller — the
 * single-payment build, the period build, and the feed — reads one shape.
 *
 * `payment_id` and `settled_at` are computed per branch because the outer
 * statements filter and order on them; `user_id` is carried for the tenant
 * scope. The three fiat values are the direct branch's book-time capture
 * (`confirmSubmittedIntent` writes them); the evidence branch has none.
 *
 * The branches are disjoint by rail — an evidence row exists only for a
 * protocol rail, and the direct branch requires `direct` — so `UNION ALL`
 * cannot duplicate a payment.
 */
const ENTRY_SOURCE_SQL = `
  SELECT
    mpe.id::TEXT AS id,
    mpe.payment_intent_id::TEXT AS payment_intent_id,
    mpe.approval_request_id::TEXT AS approval_request_id,
    mpe.tx_hash, mpe.chain_id,
    mpe.merchant_address, mpe.payer_address, mpe.token_symbol, mpe.amount_raw, mpe.amount_human,
    mpe.amount_sek, mpe.fx_rate_sek, mpe.fx_source, mpe.fx_at, mpe.fx_rates,
    mpe.resource_url, mpe.confirmed_at, mpe.created_at,
    mpe.delivery_reference,
    -- #4578: the direct-payment signal. FALSE here by construction — this
    -- branch selects only a machine_payment_evidence row, and the rail gate
    -- refuses a direct payment. Typed so the UNION ALL unifies.
    FALSE::BOOLEAN AS is_direct_payment,
    mpe.purchase_group_id, mpe.parent_payment_id,
    pi.machine_metadata->>'settlement_scheme' AS settlement_scheme,
    pi.machine_metadata->>'merchant_settlement_tx_hash' AS verified_settlement_tx_hash,
    pi.machine_metadata->>'accounting_booked_tx_hash' AS pinned_booked_tx_hash,
    pi.machine_metadata->>'accounting_booked_tx_kind' AS pinned_booked_tx_kind,
    pi.machine_metadata->'mcp_call_context'->>'toolName' AS mcp_tool_name,
    mc.category AS category,
    mc.country AS country,
    mao.bas_account AS override_account,
    pf.fee_sek AS fee_sek,
    mr.url AS merchant_receipt_url,
    mr.inline_json AS merchant_receipt_json,
    mpe.user_id,
    COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT) AS payment_id,
    COALESCE(mpe.confirmed_at, mpe.created_at) AS settled_at,
    NULL::NUMERIC AS usd_value,
    NULL::NUMERIC AS eur_value,
    NULL::NUMERIC AS sek_value
  FROM machine_payment_evidence mpe
  LEFT JOIN payment_intents pi ON pi.id = mpe.payment_intent_id
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
    ON mr.evidence_id = mpe.id
  UNION ALL
  SELECT
    pi.id::TEXT AS id,
    pi.id::TEXT AS payment_intent_id,
    NULL::TEXT AS approval_request_id,
    pi.tx_hash, pi.chain_id,
    pi.to_address AS merchant_address,
    pi.account_address AS payer_address,
    pi.token_symbol, pi.amount_raw, pi.amount_human,
    -- The feed's SEK figure has always been NUMERIC(38,4) (migration 026);
    -- payment_intents.sek_value is NUMERIC(20,6). Cast so a direct payment
    -- is fed at the same scale as every other SEK figure, not with two extra
    -- decimals no other row carries.
    pi.sek_value::NUMERIC(38,4) AS amount_sek,
    NULL::NUMERIC AS fx_rate_sek,
    NULL::TEXT AS fx_source,
    NULL::TIMESTAMPTZ AS fx_at,
    NULL::JSONB AS fx_rates,
    NULL::TEXT AS resource_url,
    pi.confirmed_at, pi.created_at,
    -- No evidence row, so no delivery reference (#4532's signal).
    NULL::TEXT AS delivery_reference,
    -- #4578: this branch IS the direct payment, so the signal is a literal
    -- TRUE — never an intent column, so no agent-written metadata can set it.
    TRUE::BOOLEAN AS is_direct_payment,
    -- #4534: the purchase correlation key lives on machine_payment_evidence
    -- only (migration 123), so a direct payment is ungrouped by construction.
    -- Typed NULLs, not bare ones: the UNION resolves against the evidence
    -- branch, where parent_payment_id is UUID.
    NULL::TEXT AS purchase_group_id,
    NULL::UUID AS parent_payment_id,
    pi.machine_metadata->>'settlement_scheme' AS settlement_scheme,
    pi.machine_metadata->>'merchant_settlement_tx_hash' AS verified_settlement_tx_hash,
    pi.machine_metadata->>'accounting_booked_tx_hash' AS pinned_booked_tx_hash,
    pi.machine_metadata->>'accounting_booked_tx_kind' AS pinned_booked_tx_kind,
    pi.machine_metadata->'mcp_call_context'->>'toolName' AS mcp_tool_name,
    NULL::TEXT AS category,
    NULL::TEXT AS country,
    NULL::TEXT AS override_account,
    pf.fee_sek AS fee_sek,
    NULL::TEXT AS merchant_receipt_url,
    NULL::JSONB AS merchant_receipt_json,
    pi.user_id,
    pi.id::TEXT AS payment_id,
    -- Same fallback the evidence branch uses: a confirmed intent always has
    -- confirmed_at, but ordering and the feed-from floor must never see a
    -- NULL settlement time.
    COALESCE(pi.confirmed_at, pi.created_at) AS settled_at,
    pi.usd_value, pi.eur_value, pi.sek_value
  FROM payment_intents pi
  LEFT JOIN payment_fees pf ON pf.payment_id = pi.id::TEXT
  WHERE ${DIRECT_PAYMENT_RAIL_SQL}
    AND ${DIRECT_PAYMENT_OUTSIDE_ADDRESS_SQL}`

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
    `SELECT * FROM (${ENTRY_SOURCE_SQL}) src
     WHERE src.user_id = $1
       AND src.payment_id = $2
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
  let where = 'src.user_id = $1'
  if (opts.from) {
    params.push(opts.from)
    where += ` AND src.settled_at >= $${params.length}`
  }
  if (opts.to) {
    params.push(opts.to)
    where += ` AND src.settled_at < $${params.length}`
  }
  params.push(opts.limit ?? 1000)
  const limitParam = `$${params.length}`

  const result = await pool.query<AccountingEntrySourceRow>(
    `SELECT * FROM (${ENTRY_SOURCE_SQL}) src
     WHERE ${where}
     ORDER BY src.settled_at DESC
     LIMIT ${limitParam}`,
    params,
  )

  return result.rows.map(toAccountingEntry)
}

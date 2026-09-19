/**
 * Shared shapes for the transactions module (#992). `routes/transactions.ts`
 * imports these (and only these + the functions in `index.ts`) — see the
 * `no-deep-cross-module-import` dependency-cruiser rule.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { TransactionAccountRow } from '../../infra/repositories/transaction-history.js'
import type { TransactionCurrency } from '../../domain/transaction-currency.js'

export interface Transaction {
  hash: string
  type: 'native' | 'erc20' | 'internal'
  from: string
  to: string
  value: string
  valueFormatted: string
  asset: string
  decimals: number
  direction: 'in' | 'out'
  timestamp: number
  /**
   * #3132: where `timestamp` came from — never a silent substitution. `block`
   * on explorer-derived rows (the block's timestamp); on an x402-synthesized
   * row `confirmed_at` when the intent carries one, else `created_at` (the
   * intent's creation time, NOT a settlement time). A consumer that needs
   * "when this settled" reads `confirmedAt` and treats `created_at` here as
   * "not confirmed at a known time".
   */
  timestampSource: 'block' | 'confirmed_at' | 'created_at'
  /**
   * #3132: the recorded confirmation time (ISO 8601) of an x402-synthesized
   * row, `null` when the intent has none — the same nullable value the
   * receipts view reports as `confirmed_at`, so the two views can no longer
   * disagree on whether a payment has a confirmation time. Absent on
   * explorer-derived rows.
   */
  confirmedAt?: string | null
  /**
   * On-chain block, or `null` when this row has none recorded (#3129).
   *
   * Explorer-derived rows always carry a real block. `null` is the
   * x402-synthesized row, built from a payment intent: no block number is
   * stored anywhere (no migration defines a `block_number` column), so the
   * field is genuinely unknown. It was `0` until #3129, which reads as a real
   * block — a zero that means "missing" is worse than an absent value,
   * especially beside a `hash` that IS a real settlement transaction.
   */
  blockNumber: number | null
  isError: boolean
  tokenAddress?: string
  tokenSymbol?: string
  source?: string
  x402ResourceUrl?: string | null
  x402MerchantAddress?: string | null
  paymentId?: string
  paymentProofStatus?: string | null
  paymentFlowStatus?: string | null
  paymentAttentionReason?: string | null
  activityType?: 'delegate_sweep'
  /** Book-time SEK value (P0 #463); null for non-machine / unpriced transactions. */
  amountSek?: string | null
  /**
   * The book-time FX rate `amountSek` was struck at, and where it came from —
   * `machine_payment_evidence.fx_rate_sek` / `.fx_source` (#463, migration
   * 026), surfaced for the CSV export (#2871). Null wherever `amountSek` is:
   * they are written by the same pricing step, so a row never carries an
   * amount without its rate.
   */
  fxRateSek?: string | null
  fxSource?: string | null
  /**
   * The stored book-time rate map (`machine_payment_evidence.fx_rates`,
   * migration 082) — a rate per supported ledger currency, frozen at
   * settlement. Present only on the machine-payment rows whose evidence row
   * has one; absent for raw transfers and pre-082 rows. Feeds the converted
   * triple below and rides the wire declared (`fxRates` on the spec) for
   * auditability: `convertedFxRate` names the one rate the served amount was
   * struck at, the map shows the whole frozen capture. (#3127)
   */
  fxRates?: Record<string, number> | null
  /**
   * The converted amount in the user's preferred currency, that currency
   * named as a FIELD, and the rate it was struck at (#3127). Before #3127 the
   * currency lived only in field names (`amountSek`), so a consumer had to
   * parse an identifier to know what it was reading, and the user's
   * `currency_preference` was never consulted.
   *
   * Provenance stays auditable: the figure is struck from the SAME stored
   * book-time capture as `amountSek` — the SEK columns, or the `fx_rates`
   * map frozen at settlement — never a serve-time price read, so a book-time
   * figure cannot silently become a fetch-time one.
   *
   * Null semantics follow the currency: SEK mirrors `amountSek` exactly
   * (null for non-machine / unpriced rows). USD/EUR additionally need a
   * usable rate in the row's `fx_rates` map — pre-082 rows and price-outage
   * rows yield null there. Null is "not ready to convert", never another
   * currency. The triple is always present TOGETHER (or null together) so a
   * consumer can branch on the amount alone.
   */
  convertedAmount?: string | null
  convertedCurrency?: TransactionCurrency
  convertedFxRate?: string | null
  /**
   * Who initiated the money movement that produced this row — recorded by
   * the backend (#2097), never derived in the frontend.
   *
   * - `'agent'`: the row carries agent attribution — confirmed x402 payment
   *   intents, delegate sweeps, and raw explorer / Safe-service transfers
   *   matched to a confirmed intent or sweep during enrichment
   *   (`enrichTransactionsWithAgents`).
   * - `'human'`: reserved. Nothing populates it today — no
   *   dashboard-initiated send path exists (the mpp demo and `/send` were
   *   retired), so no row can currently claim a human initiator.
   * - `'unknown'`: an OUTBOUND raw transfer that stayed unattributed — no
   *   matched intent or sweep.
   *
   * Absent (undefined) for inbound (`direction: 'in'`) rows, which have no
   * initiator record at all.
   */
  initiatedBy?: 'agent' | 'human' | 'unknown'
  /**
   * Accounting-feed state for this payment (#2870), joined from the sync
   * ledger by `paymentId`. PRESENT only when the feed is available to the
   * account, the user has a provider connection, AND a sync row exists;
   * otherwise the key is absent (never null). No `booked` field: the ledger
   * stores no verify result. See `accounting.ts`.
   */
  accounting?: TransactionAccounting
}

/** The `accounting` object on a transaction row (#2870). */
export interface TransactionAccounting {
  /** Ledger provider key, e.g. `'fortnox'`. The UI maps it to a display name. */
  provider: string
  status: 'pending' | 'pushed' | 'failed' | 'skipped'
  /** Provider-side reference (`fortnox:supplierinvoice:<n>`) once pushed. */
  externalRef: string | null
  /** Failure / skip reason, or the #498 non-fatal note on a pushed row. */
  error: string | null
}

/**
 * #3132 (owner decision 3 on #3130): what population a list row came from and
 * what narrowed it, as two separate values — one value cannot say both.
 * `source: 'wallet'` (the aggregated feed: every account's explorer window
 * plus synthesized confirmed intents; sweeps and funding legs included) or
 * `'agent'` (the receipts view: this agent's evidence rows only). `filter`
 * names the query-time narrowing applied on top, or `null`. `agentId` on the
 * wallet feed NARROWS a wallet-scoped query; it does not make it the
 * receipts view — the populations and row classes still differ.
 */
export interface ListScope {
  source: 'wallet' | 'agent'
  filter: 'agent' | 'account' | 'account+agent' | null
}

export interface EnrichedTransaction extends Transaction {
  /** #3132: present on every `GET /transactions` row. */
  scope?: ListScope
  chainId: number
  accountId: string
  accountAddress: string
  accountName: string
  agentId?: string
  agentName?: string
  /**
   * Which settlement branch moved the money — `'eip3009' | 'erc7710'` — read
   * from the intent's `machine_metadata` JSONB (#1705, epic #1704).
   *
   * NOT `source` (the payment protocol) and NOT the account's
   * `execution_rail` (account architecture); the three axes stay unmerged.
   *
   * Null/absent whenever nothing was recorded: non-machine rows, and every
   * legacy-rail row — that rail is structurally EIP-3009 and never stamps the
   * key, so null-in-null-out leaves it blank rather than inferring a value.
   * Typed as the open `string | null` the wire carries; the spec's enum is the
   * contract. Populated by #1706.
   *
   * Note for #1706: this file's `Transaction` / `EnrichedTransaction` split
   * does NOT mirror the spec's `TransactionBase` / `Transaction` split
   * field-for-field. The field sits here, on the enriched shape, because that
   * is what enrichment maps over — the same placement `agentName` already
   * uses despite also living on the spec's `TransactionBase`.
   */
  settlementScheme?: string | null
}

/** Re-exported so route/module callers share one name for the Safe projection. */
export type SmartAccountRow = TransactionAccountRow

export interface FetchAccountTransactionsParams {
  accountId: string
  accountAddress: string
  chainId: number
  log: FastifyBaseLogger
  fresh?: boolean
}

export interface FetchAccountTransactionsResult {
  transactions: Transaction[]
  hadFailures: boolean
  /**
   * At least one explorer leg came back at its window, so this account's
   * history is cut off rather than complete (#2882). Independent of
   * `hadFailures`: a read can be truncated without failing, and can fail
   * without being truncated.
   */
  truncated: boolean
}

export interface ParsedTokenFilter {
  chainId: number
  address: string | null
}

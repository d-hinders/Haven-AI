/**
 * Data access for the agent-activity read model — the payment/approval history
 * behind `GET /agents/:id/activity` and `GET /activity/feed`, plus the spend
 * aggregates behind `GET /agents/:id/stats`.
 *
 * Extracted verbatim from `routes/agent-activity.ts` (#1167) so
 * `scripts/db-schema-smoke.ts` can PREPARE every statement against the real
 * schema. Convention: `README.md` in this directory.
 *
 * Read-only by construction: nothing in this file writes. It is a PROJECTION
 * over `payment_intents` / `approval_requests` / the machine-payment evidence
 * tables, not the owner of any of them — the writes live in
 * `payment-intents.ts`, `approval-requests.ts` and `machine-payments.ts`.
 *
 * Invariants a reader must not break:
 *
 * - **Nothing here is tenant-scoped in SQL.** Every statement filters by
 *   `agent_id`, and the route MUST establish that the agent belongs to the
 *   caller first (`agentExistsForUser`, or the feed's own `user_id`-scoped
 *   agent list). Adding a caller that skips that check turns these into a
 *   cross-tenant read of another user's payment history. Since #1179 there is
 *   no exception in this file: the one `user_id`-scoped statement moved to
 *   `approval-requests.ts`, where the aggregate that owns it lives.
 * - Account identity is joined on the payment's STORED `account_address` + chain,
 *   not through `agents.account_id`. A payment keeps the account it was made
 *   from even after the agent is re-pointed or the Safe unlinked; joining
 *   through the agent would silently re-label historical rows.
 * - The evidence joins are LEFT and narrowly filtered (`status = 'open'`, one
 *   event type), so a payment with no machine-payment evidence still appears
 *   — with nulls the caller's lifecycle mapping reads as "no attention
 *   needed", never as a missing row.
 *
 * **The SQL here is verbatim from the route.** Anything that looked improvable
 * was left alone and reported in the pull request instead.
 */

import { DEFAULT_CHAIN_ID } from '@haven_ai/core'
import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface ActivityPaymentRow {
  id: string
  account_id: string | null
  account_address: string | null
  account_name: string | null
  chain_id: number
  token_symbol: string
  token_address: string
  amount_raw: string
  amount_human: string
  to_address: string
  status: string
  tx_hash: string | null
  /**
   * #3763: `machine_metadata.merchant_settlement_tx_hash` — the merchant's
   * own settlement transaction when an agent reported one or the #3888
   * settlement sweep detected it on-chain, and it verified on-chain (#3475).
   * `null` is "not recorded", never "failed". `tx_hash` keeps its funding
   * meaning.
   */
  settlement_tx_hash: string | null
  /** #3763: `machine_metadata.settlement_scheme` (#1705) — no scheme selected before this read. */
  settlement_scheme: string | null
  /** #4319: the stored proof state the `settlement_tracking`/`settlement_proof` wire fields derive from. */
  settlement_proof_label: string | null
  settlement_nonce_bound: boolean | null
  settlement_nonce_derived: boolean | null
  receipt_verdict: string | null
  has_stored_header: boolean | null
  source: string | null
  x402_resource_url: string | null
  x402_merchant_address: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  payment_proof_status: string | null
  /** `machine_payment_evidence.delivery_reference` (migration 107, #3778). */
  delivery_reference: string | null
  payment_reconciliation_event_type: string | null
  execution_rail: string | null
  delegation_hash: string | null
  created_at: string
  confirmed_at: string | null
}

/** The feed variants carry the owning agent so the caller can label each row. */
export type FeedPaymentRow = ActivityPaymentRow & { agent_id: string }

export interface AgentSpendStatsRow {
  token_symbol: string
  total_spent: string
  tx_count: string
}

// ── Single-agent activity ────────────────────────────────────────────────────

export const LIST_AGENT_PAYMENTS_SQL = `SELECT pi.id,
              us.id AS account_id,
              COALESCE(us.account_address, pi.account_address) AS account_address,
              us.name AS account_name,
              COALESCE(pi.chain_id, us.chain_id, ${DEFAULT_CHAIN_ID}) AS chain_id,
              pi.token_symbol,
              pi.token_address,
              pi.amount_raw,
              pi.amount_human,
              pi.to_address,
              pi.status,
              pi.tx_hash,
              pi.machine_metadata->>'merchant_settlement_tx_hash' AS settlement_tx_hash,
              pi.machine_metadata->>'settlement_scheme' AS settlement_scheme,
              pi.machine_metadata->>'merchant_settlement_proof' AS settlement_proof_label,
              (pi.machine_metadata->>'merchant_settlement_nonce_bound')::boolean AS settlement_nonce_bound,
              (pi.machine_metadata->>'merchant_settlement_nonce_derived')::boolean AS settlement_nonce_derived,
              pi.machine_metadata->>'merchant_settlement_receipt_verdict' AS receipt_verdict,
              (mpe.payment_proof_header IS NOT NULL) AS has_stored_header,
              COALESCE(pi.payment_rail, pi.source, 'direct') AS source,
              COALESCE(pi.payment_resource_url, pi.x402_resource_url) AS x402_resource_url,
              COALESCE(pi.merchant_address, pi.x402_merchant_address) AS x402_merchant_address,
              mpe.proof_status AS payment_proof_status,
              mpe.delivery_reference AS delivery_reference,
              pi.payment_rail,
              pi.payment_resource_url,
              pi.merchant_address,
              pi.execution_rail,
              pi.delegation_hash,
              pi.created_at,
              pi.confirmed_at,
              mpre.event_type AS payment_reconciliation_event_type
       FROM payment_intents pi
       LEFT JOIN smart_accounts us
         ON us.user_id = pi.user_id
        AND LOWER(us.account_address) = LOWER(pi.account_address)
        AND pi.chain_id IS NOT NULL
        AND us.chain_id = pi.chain_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
       LEFT JOIN machine_payment_reconciliation_events mpre
         ON mpre.payment_intent_id = pi.id
        AND mpre.status = 'open'
        AND mpre.event_type = 'merchant_retry_rejected_after_payment'
       WHERE pi.agent_id = $1
       ORDER BY pi.created_at DESC
       LIMIT $2 OFFSET $3`

// ── Single-agent activity, filtered (#4229) ──────────────────────────────────
//
// The same population as `LIST_AGENT_PAYMENTS_SQL` under an OPTIONAL filter
// set: every predicate is `($n IS NULL OR …)`, so one fixed-shape statement
// serves every combination — a runtime-assembled WHERE is a statement
// `db-schema-smoke` cannot PREPARE (see the spend-stats note below). The
// unfiltered read stays on `LIST_AGENT_PAYMENTS_SQL` verbatim, so omitting
// the filters serves today's byte-identical response.

/**
 * The `status` filter's derived arm: `needs_attention` is NOT a
 * `payment_intents` status — it is `machinePaymentLifecycle`'s derived state,
 * which is set exactly when a machine rail's confirmed payment carries an
 * open `merchant_retry_rejected_after_payment` reconciliation event. The
 * route supplies the rails set (`MACHINE_PAYMENT_RAILS`) as $3 so the SQL
 * mirrors the domain derivation without restating it here.
 */
export const LIST_AGENT_PAYMENTS_FILTERED_SQL = `SELECT pi.id,
              us.id AS account_id,
              COALESCE(us.account_address, pi.account_address) AS account_address,
              us.name AS account_name,
              COALESCE(pi.chain_id, us.chain_id, ${DEFAULT_CHAIN_ID}) AS chain_id,
              pi.token_symbol,
              pi.token_address,
              pi.amount_raw,
              pi.amount_human,
              pi.to_address,
              pi.status,
              pi.tx_hash,
              pi.machine_metadata->>'merchant_settlement_tx_hash' AS settlement_tx_hash,
              pi.machine_metadata->>'settlement_scheme' AS settlement_scheme,
              pi.machine_metadata->>'merchant_settlement_proof' AS settlement_proof_label,
              (pi.machine_metadata->>'merchant_settlement_nonce_bound')::boolean AS settlement_nonce_bound,
              (pi.machine_metadata->>'merchant_settlement_nonce_derived')::boolean AS settlement_nonce_derived,
              pi.machine_metadata->>'merchant_settlement_receipt_verdict' AS receipt_verdict,
              (mpe.payment_proof_header IS NOT NULL) AS has_stored_header,
              COALESCE(pi.payment_rail, pi.source, 'direct') AS source,
              COALESCE(pi.payment_resource_url, pi.x402_resource_url) AS x402_resource_url,
              COALESCE(pi.merchant_address, pi.x402_merchant_address) AS x402_merchant_address,
              mpe.proof_status AS payment_proof_status,
              mpe.delivery_reference AS delivery_reference,
              pi.payment_rail,
              pi.payment_resource_url,
              pi.merchant_address,
              pi.execution_rail,
              pi.delegation_hash,
              pi.created_at,
              pi.confirmed_at,
              mpre.event_type AS payment_reconciliation_event_type
       FROM payment_intents pi
       LEFT JOIN smart_accounts us
         ON us.user_id = pi.user_id
        AND LOWER(us.account_address) = LOWER(pi.account_address)
        AND pi.chain_id IS NOT NULL
        AND us.chain_id = pi.chain_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
       LEFT JOIN machine_payment_reconciliation_events mpre
         ON mpre.payment_intent_id = pi.id
        AND mpre.status = 'open'
        AND mpre.event_type = 'merchant_retry_rejected_after_payment'
       WHERE pi.agent_id = $1
         AND ($2::text IS NULL
              OR pi.status = $2
              OR ($2 = 'pending' AND pi.status IN ('pending_signature', 'submitted'))
              OR ($2 = 'needs_attention' AND mpre.event_type IS NOT NULL
                  AND COALESCE(pi.payment_rail, pi.source, 'direct') = ANY($3::text[])
                  AND pi.status IN ('confirmed', 'executed')))
         AND ($4::text IS NULL OR pi.created_at >= $4::timestamptz)
         AND ($5::text IS NULL OR pi.created_at < $5::timestamptz)
         AND ($6::text IS NULL OR pi.x402_resource_url ILIKE '%' || $6 || '%'
              OR pi.merchant_address ILIKE '%' || $6 || '%'
              OR pi.to_address ILIKE '%' || $6 || '%'
              OR EXISTS (SELECT 1 FROM contacts c
                         WHERE c.user_id = pi.user_id
                           AND LOWER(c.address) = LOWER(pi.to_address)
                           AND c.name ILIKE '%' || $6 || '%'))
         AND ($7::uuid IS NULL OR pi.id = $7::uuid)
         AND ($8::text IS NULL OR LOWER(pi.token_address) = LOWER($8::text))
       ORDER BY pi.created_at DESC
       LIMIT $9 OFFSET $10`

/**
 * The filtered population's total — the COUNT twin of
 * `LIST_AGENT_PAYMENTS_FILTERED_SQL` with the same predicates minus the
 * page. A separate statement rather than `COUNT(*) OVER ()` on the page
 * query: an offset past the end returns zero rows, and the total must
 * survive that (`hasMore` is computed from it).
 */
export const COUNT_AGENT_PAYMENTS_FILTERED_SQL = `SELECT COUNT(*)
       FROM payment_intents pi
       LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
       LEFT JOIN machine_payment_reconciliation_events mpre
         ON mpre.payment_intent_id = pi.id
        AND mpre.status = 'open'
        AND mpre.event_type = 'merchant_retry_rejected_after_payment'
       WHERE pi.agent_id = $1
         AND ($2::text IS NULL
              OR pi.status = $2
              OR ($2 = 'pending' AND pi.status IN ('pending_signature', 'submitted'))
              OR ($2 = 'needs_attention' AND mpre.event_type IS NOT NULL
                  AND COALESCE(pi.payment_rail, pi.source, 'direct') = ANY($3::text[])
                  AND pi.status IN ('confirmed', 'executed')))
         AND ($4::text IS NULL OR pi.created_at >= $4::timestamptz)
         AND ($5::text IS NULL OR pi.created_at < $5::timestamptz)
         AND ($6::text IS NULL OR pi.x402_resource_url ILIKE '%' || $6 || '%'
              OR pi.merchant_address ILIKE '%' || $6 || '%'
              OR pi.to_address ILIKE '%' || $6 || '%'
              OR EXISTS (SELECT 1 FROM contacts c
                         WHERE c.user_id = pi.user_id
                           AND LOWER(c.address) = LOWER(pi.to_address)
                           AND c.name ILIKE '%' || $6 || '%'))
         AND ($7::uuid IS NULL OR pi.id = $7::uuid)
         AND ($8::text IS NULL OR LOWER(pi.token_address) = LOWER($8::text))`

/**
 * The optional filter set behind `GET /agent-activity/:id/activity?kind=…`.
 * `status` is the ROUTE's translated value: `'confirmed'` for the UI's
 * `sent`, the derived `'needs_attention'` for attention, or a raw
 * `payment_intents` status. `rails` is `MACHINE_PAYMENT_RAILS` as an array.
 * `from`/`to` are ISO bounds — inclusive `from`, exclusive `to`. `q` is the
 * trimmed search term (merchant resource URL, merchant/recipient address, or
 * the owner's contact name for the recipient). `paymentId` narrows to one.
 * `token` is the ERC-20 contract address, compared case-insensitively
 * (#4226's Activity-tab Token facet — the tab's population is the agent's own
 * payments, which the transactions feed's `tokenKey` cannot reach).
 */
export interface AgentPaymentActivityFilter {
  status: string | null
  rails: string[]
  from: string | null
  to: string | null
  q: string | null
  paymentId: string | null
  token: string | null
}

function filteredPaymentArgs(agentId: string, filter: AgentPaymentActivityFilter): unknown[] {
  return [
    agentId,
    filter.status,
    filter.rails,
    filter.from,
    filter.to,
    filter.q,
    filter.paymentId,
    filter.token,
  ]
}

/**
 * NOT tenant-scoped — see the file header. The caller must have confirmed the
 * agent belongs to the requesting user before calling this.
 */
export async function listAgentPaymentsFiltered(
  agentId: string,
  filter: AgentPaymentActivityFilter,
  limit: number,
  offset: number,
  db: Executor = pool,
): Promise<ActivityPaymentRow[]> {
  const result = await db.query<ActivityPaymentRow>(LIST_AGENT_PAYMENTS_FILTERED_SQL, [
    ...filteredPaymentArgs(agentId, filter),
    limit,
    offset,
  ])
  return result.rows
}

/** Same gating contract as `listAgentPaymentsFiltered`. Returns the filtered population's total. */
export async function countAgentPaymentsFiltered(
  agentId: string,
  filter: AgentPaymentActivityFilter,
  db: Executor = pool,
): Promise<number> {
  const result = await db.query<{ count: string }>(COUNT_AGENT_PAYMENTS_FILTERED_SQL, [
    ...filteredPaymentArgs(agentId, filter),
  ])
  return Number(result.rows[0]?.count ?? 0)
}

// #2055: `LIST_AGENT_APPROVALS_SQL` / `listAgentApprovals` are gone with
// `approval_requests` — the activity feed is payments + tool invocations.

/**
 * NOT tenant-scoped — see the file header. The caller must have confirmed the
 * agent belongs to the requesting user before calling this.
 */
export async function listAgentPayments(
  agentId: string,
  limit: number,
  offset: number,
  db: Executor = pool,
): Promise<ActivityPaymentRow[]> {
  const result = await db.query<ActivityPaymentRow>(LIST_AGENT_PAYMENTS_SQL, [
    agentId,
    limit,
    offset,
  ])
  return result.rows
}


// ── All-agent feed ───────────────────────────────────────────────────────────

export const LIST_FEED_PAYMENTS_SQL = `SELECT pi.id,
              pi.agent_id,
              us.id AS account_id,
              COALESCE(us.account_address, pi.account_address) AS account_address,
              us.name AS account_name,
              COALESCE(pi.chain_id, us.chain_id, ${DEFAULT_CHAIN_ID}) AS chain_id,
              pi.token_symbol,
              pi.token_address,
              pi.amount_raw,
              pi.amount_human,
              pi.to_address,
              pi.status,
              pi.tx_hash,
              pi.machine_metadata->>'merchant_settlement_tx_hash' AS settlement_tx_hash,
              pi.machine_metadata->>'settlement_scheme' AS settlement_scheme,
              pi.machine_metadata->>'merchant_settlement_proof' AS settlement_proof_label,
              (pi.machine_metadata->>'merchant_settlement_nonce_bound')::boolean AS settlement_nonce_bound,
              (pi.machine_metadata->>'merchant_settlement_nonce_derived')::boolean AS settlement_nonce_derived,
              pi.machine_metadata->>'merchant_settlement_receipt_verdict' AS receipt_verdict,
              (mpe.payment_proof_header IS NOT NULL) AS has_stored_header,
              COALESCE(pi.payment_rail, pi.source, 'direct') AS source,
              COALESCE(pi.payment_resource_url, pi.x402_resource_url) AS x402_resource_url,
              COALESCE(pi.merchant_address, pi.x402_merchant_address) AS x402_merchant_address,
              mpe.proof_status AS payment_proof_status,
              mpe.delivery_reference AS delivery_reference,
              pi.payment_rail,
              pi.payment_resource_url,
              pi.merchant_address,
              pi.execution_rail,
              pi.delegation_hash,
              pi.created_at,
              pi.confirmed_at,
              mpre.event_type AS payment_reconciliation_event_type
       FROM payment_intents pi
       LEFT JOIN smart_accounts us
         ON us.user_id = pi.user_id
        AND LOWER(us.account_address) = LOWER(pi.account_address)
        AND pi.chain_id IS NOT NULL
        AND us.chain_id = pi.chain_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
       LEFT JOIN machine_payment_reconciliation_events mpre
         ON mpre.payment_intent_id = pi.id
        AND mpre.status = 'open'
        AND mpre.event_type = 'merchant_retry_rejected_after_payment'
       WHERE pi.agent_id = ANY($1)
       ORDER BY pi.created_at DESC
       LIMIT $2 OFFSET $3`

// #2055: `LIST_FEED_APPROVALS_SQL` / `listFeedApprovals` are gone with
// `approval_requests` (see the per-agent note above).

/**
 * NOT tenant-scoped — `agentIds` must come from a `user_id`-filtered agent
 * read. Handing it ids from anywhere else reads another tenant's payments.
 */
export async function listFeedPayments(
  agentIds: string[],
  limit: number,
  offset: number,
  db: Executor = pool,
): Promise<FeedPaymentRow[]> {
  const result = await db.query<FeedPaymentRow>(LIST_FEED_PAYMENTS_SQL, [agentIds, limit, offset])
  return result.rows
}


// ── Spend stats ──────────────────────────────────────────────────────────────

/**
 * The two spend buckets are separate verbatim statements, not one statement
 * with a parameterised window: they differ in their time predicate, and the
 * all-time bucket has none at all. A runtime-assembled WHERE is a statement
 * `db-schema-smoke` cannot PREPARE.
 *
 * Both count CONFIRMED intents only — a pending or failed intent is not
 * spend.
 */
export const SUM_AGENT_SPEND_ALL_TIME_SQL = `SELECT token_symbol,
                SUM(CAST(amount_human AS NUMERIC)) as total_spent,
                COUNT(*) as tx_count
         FROM payment_intents
         WHERE agent_id = $1 AND status = 'confirmed'
         GROUP BY token_symbol`

/**
 * #3977: "today" is the CALLER's local day. The route derives the day's
 * bounds in the validated `tz` from its own (injectable) clock and passes
 * them as parameters, so nothing here leans on the database session's time
 * zone — `CURRENT_DATE` before #3977 read the server default (UTC on our
 * images), which put local midnight at 01:00/02:00 for a Stockholm user.
 * Counts on `confirmed_at`, the same column the dashboard's spend windows
 * count (#3803 §4): a payment created before local midnight and confirmed
 * after belongs to the day it was CONFIRMED in.
 */
export const SUM_AGENT_SPEND_TODAY_SQL = `SELECT token_symbol,
                SUM(CAST(amount_human AS NUMERIC)) as total_spent,
                COUNT(*) as tx_count
         FROM payment_intents
         WHERE agent_id = $1 AND status = 'confirmed'
           AND confirmed_at >= $2 AND confirmed_at < $3
         GROUP BY token_symbol`

/** Same gating contract as `listAgentPayments`. */
export async function sumAgentSpendAllTime(
  agentId: string,
  db: Executor = pool,
): Promise<AgentSpendStatsRow[]> {
  const result = await db.query<AgentSpendStatsRow>(SUM_AGENT_SPEND_ALL_TIME_SQL, [agentId])
  return result.rows
}

/** Same gating contract as `listAgentPayments`. */
export async function sumAgentSpendToday(
  agentId: string,
  /** Inclusive ISO start of the caller's local day (from `localDayBounds`). */
  windowStartIso: string,
  /** Exclusive ISO end of the caller's local day. */
  windowEndIso: string,
  db: Executor = pool,
): Promise<AgentSpendStatsRow[]> {
  const result = await db.query<AgentSpendStatsRow>(SUM_AGENT_SPEND_TODAY_SQL, [
    agentId,
    windowStartIso,
    windowEndIso,
  ])
  return result.rows
}

// ── Approval counters — RETIRED (#2055) ─────────────────────────────────────
// `COUNT_PENDING_APPROVALS_FOR_AGENT_SQL` / `countPendingApprovalsForAgent`
// are gone with `approval_requests`; the pending count is structurally zero
// and hardcoded at the route.

/** `userId` is REQUIRED — this one IS tenant-scoped. */

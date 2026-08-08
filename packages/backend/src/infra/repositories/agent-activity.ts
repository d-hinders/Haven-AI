/**
 * Data access for the agent-activity read model — the payment/approval history
 * behind `GET /agents/:id/activity` and `GET /activity/feed`, plus the four
 * spend aggregates behind `GET /agents/:id/stats`.
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
 *   cross-tenant read of another user's payment history. The one exception is
 *   `countActionableApprovalsForUser`, which is scoped by `user_id` directly.
 * - Safe identity is joined on the payment's STORED `safe_address` + chain,
 *   not through `agents.safe_id`. A payment keeps the account it was made
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
  safe_id: string | null
  safe_address: string | null
  safe_name: string | null
  chain_id: number
  token_symbol: string
  token_address: string
  amount_raw: string
  amount_human: string
  to_address: string
  status: string
  tx_hash: string | null
  source: string | null
  x402_resource_url: string | null
  x402_merchant_address: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  payment_proof_status: string | null
  payment_reconciliation_event_type: string | null
  execution_rail: string | null
  session_permission_id: string | null
  delegation_hash: string | null
  created_at: string
  confirmed_at: string | null
}

export interface ActivityApprovalRow {
  id: string
  safe_id: string | null
  safe_address: string | null
  safe_name: string | null
  chain_id: number
  token_symbol: string
  token_address: string
  amount_human: string
  to_address: string
  reason: string | null
  source: string | null
  x402_resource_url: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  payment_proof_status: string | null
  payment_reconciliation_event_type: string | null
  status: string
  tx_hash: string | null
  created_at: string
}

/** The feed variants carry the owning agent so the caller can label each row. */
export type FeedPaymentRow = ActivityPaymentRow & { agent_id: string }
export type FeedApprovalRow = ActivityApprovalRow & { agent_id: string }

export interface AgentSpendStatsRow {
  token_symbol: string
  total_spent: string
  tx_count: string
}

// ── Single-agent activity ────────────────────────────────────────────────────

export const LIST_AGENT_PAYMENTS_SQL = `SELECT pi.id,
              us.id AS safe_id,
              COALESCE(us.safe_address, pi.safe_address) AS safe_address,
              us.name AS safe_name,
              COALESCE(pi.chain_id, us.chain_id, ${DEFAULT_CHAIN_ID}) AS chain_id,
              pi.token_symbol,
              pi.token_address,
              pi.amount_raw,
              pi.amount_human,
              pi.to_address,
              pi.status,
              pi.tx_hash,
              COALESCE(pi.payment_rail, pi.source, 'direct') AS source,
              COALESCE(pi.payment_resource_url, pi.x402_resource_url) AS x402_resource_url,
              COALESCE(pi.merchant_address, pi.x402_merchant_address) AS x402_merchant_address,
              mpe.proof_status AS payment_proof_status,
              pi.payment_rail,
              pi.payment_resource_url,
              pi.merchant_address,
              pi.execution_rail,
              pi.session_permission_id,
              pi.delegation_hash,
              pi.created_at,
              pi.confirmed_at,
              mpre.event_type AS payment_reconciliation_event_type
       FROM payment_intents pi
       LEFT JOIN user_safes us
         ON us.user_id = pi.user_id
        AND LOWER(us.safe_address) = LOWER(pi.safe_address)
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

export const LIST_AGENT_APPROVALS_SQL = `SELECT ar.id,
              us.id AS safe_id,
              COALESCE(us.safe_address, ar.safe_address) AS safe_address,
              us.name AS safe_name,
              COALESCE(ar.chain_id, us.chain_id, ${DEFAULT_CHAIN_ID}) as chain_id,
              ar.token_symbol,
              ar.token_address,
              ar.amount_human,
              ar.to_address,
              ar.reason,
              COALESCE(ar.payment_rail, ar.source, 'direct') AS source,
              COALESCE(ar.payment_resource_url, ar.x402_resource_url) AS x402_resource_url,
              ar.payment_rail,
              ar.payment_resource_url,
              ar.merchant_address,
              ar.status, ar.tx_hash, ar.created_at,
              mpe.proof_status AS payment_proof_status,
              mpre.event_type AS payment_reconciliation_event_type
       FROM approval_requests ar
       LEFT JOIN user_safes us
         ON us.user_id = ar.user_id
        AND LOWER(us.safe_address) = LOWER(ar.safe_address)
        AND ar.chain_id IS NOT NULL
        AND us.chain_id = ar.chain_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.approval_request_id = ar.id
       LEFT JOIN machine_payment_reconciliation_events mpre
         ON mpre.approval_request_id = ar.id
        AND mpre.status = 'open'
        AND mpre.event_type = 'merchant_retry_rejected_after_payment'
       WHERE ar.agent_id = $1
       ORDER BY ar.created_at DESC
       LIMIT $2 OFFSET $3`

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

/** Same gating contract as `listAgentPayments`. */
export async function listAgentApprovals(
  agentId: string,
  limit: number,
  offset: number,
  db: Executor = pool,
): Promise<ActivityApprovalRow[]> {
  const result = await db.query<ActivityApprovalRow>(LIST_AGENT_APPROVALS_SQL, [
    agentId,
    limit,
    offset,
  ])
  return result.rows
}

// ── All-agent feed ───────────────────────────────────────────────────────────

export const LIST_FEED_PAYMENTS_SQL = `SELECT pi.id,
              pi.agent_id,
              us.id AS safe_id,
              COALESCE(us.safe_address, pi.safe_address) AS safe_address,
              us.name AS safe_name,
              COALESCE(pi.chain_id, us.chain_id, ${DEFAULT_CHAIN_ID}) AS chain_id,
              pi.token_symbol,
              pi.token_address,
              pi.amount_raw,
              pi.amount_human,
              pi.to_address,
              pi.status,
              pi.tx_hash,
              COALESCE(pi.payment_rail, pi.source, 'direct') AS source,
              COALESCE(pi.payment_resource_url, pi.x402_resource_url) AS x402_resource_url,
              COALESCE(pi.merchant_address, pi.x402_merchant_address) AS x402_merchant_address,
              mpe.proof_status AS payment_proof_status,
              pi.payment_rail,
              pi.payment_resource_url,
              pi.merchant_address,
              pi.execution_rail,
              pi.session_permission_id,
              pi.delegation_hash,
              pi.created_at,
              pi.confirmed_at,
              mpre.event_type AS payment_reconciliation_event_type
       FROM payment_intents pi
       LEFT JOIN user_safes us
         ON us.user_id = pi.user_id
        AND LOWER(us.safe_address) = LOWER(pi.safe_address)
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

export const LIST_FEED_APPROVALS_SQL = `SELECT ar.id,
              ar.agent_id,
              us.id AS safe_id,
              COALESCE(us.safe_address, ar.safe_address) AS safe_address,
              us.name AS safe_name,
              COALESCE(ar.chain_id, us.chain_id, ${DEFAULT_CHAIN_ID}) as chain_id,
              ar.token_symbol,
              ar.token_address,
              ar.amount_human,
              ar.to_address,
              ar.reason,
              COALESCE(ar.payment_rail, ar.source, 'direct') AS source,
              COALESCE(ar.payment_resource_url, ar.x402_resource_url) AS x402_resource_url,
              ar.payment_rail,
              ar.payment_resource_url,
              ar.merchant_address,
              ar.status, ar.tx_hash, ar.created_at,
              mpe.proof_status AS payment_proof_status,
              mpre.event_type AS payment_reconciliation_event_type
       FROM approval_requests ar
       LEFT JOIN user_safes us
         ON us.user_id = ar.user_id
        AND LOWER(us.safe_address) = LOWER(ar.safe_address)
        AND ar.chain_id IS NOT NULL
        AND us.chain_id = ar.chain_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.approval_request_id = ar.id
       LEFT JOIN machine_payment_reconciliation_events mpre
         ON mpre.approval_request_id = ar.id
        AND mpre.status = 'open'
        AND mpre.event_type = 'merchant_retry_rejected_after_payment'
       WHERE ar.agent_id = ANY($1)
       ORDER BY ar.created_at DESC
       LIMIT $2 OFFSET $3`

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

/** Same gating contract as `listFeedPayments`. */
export async function listFeedApprovals(
  agentIds: string[],
  limit: number,
  offset: number,
  db: Executor = pool,
): Promise<FeedApprovalRow[]> {
  const result = await db.query<FeedApprovalRow>(LIST_FEED_APPROVALS_SQL, [agentIds, limit, offset])
  return result.rows
}

// ── Spend stats ──────────────────────────────────────────────────────────────

/**
 * The three spend buckets are separate verbatim statements, not one statement
 * with a parameterised window: they differ in their `created_at` predicate,
 * and the all-time bucket has none at all. A runtime-assembled WHERE is a
 * statement `db-schema-smoke` cannot PREPARE.
 *
 * All three count CONFIRMED intents only — a pending or failed intent is not
 * spend.
 */
export const SUM_AGENT_SPEND_ALL_TIME_SQL = `SELECT token_symbol,
                SUM(CAST(amount_human AS NUMERIC)) as total_spent,
                COUNT(*) as tx_count
         FROM payment_intents
         WHERE agent_id = $1 AND status = 'confirmed'
         GROUP BY token_symbol`

export const SUM_AGENT_SPEND_TODAY_SQL = `SELECT token_symbol,
                SUM(CAST(amount_human AS NUMERIC)) as total_spent,
                COUNT(*) as tx_count
         FROM payment_intents
         WHERE agent_id = $1 AND status = 'confirmed'
           AND created_at >= CURRENT_DATE
         GROUP BY token_symbol`

export const SUM_AGENT_SPEND_WEEK_SQL = `SELECT token_symbol,
                SUM(CAST(amount_human AS NUMERIC)) as total_spent,
                COUNT(*) as tx_count
         FROM payment_intents
         WHERE agent_id = $1 AND status = 'confirmed'
           AND created_at >= CURRENT_DATE - interval '7 days'
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
  db: Executor = pool,
): Promise<AgentSpendStatsRow[]> {
  const result = await db.query<AgentSpendStatsRow>(SUM_AGENT_SPEND_TODAY_SQL, [agentId])
  return result.rows
}

/** Same gating contract as `listAgentPayments`. */
export async function sumAgentSpendThisWeek(
  agentId: string,
  db: Executor = pool,
): Promise<AgentSpendStatsRow[]> {
  const result = await db.query<AgentSpendStatsRow>(SUM_AGENT_SPEND_WEEK_SQL, [agentId])
  return result.rows
}

// ── Approval counters ────────────────────────────────────────────────────────

/**
 * The per-AGENT approval counter — "what is this agent waiting on". Its
 * per-user twin ("what is waiting on me") lived here too until #1179 found
 * `dashboard.ts` asking the identical question with its own constant; the
 * shared one now lives with the aggregate, in `approval-requests.ts`, and both
 * surfaces call it.
 */
export const COUNT_PENDING_APPROVALS_FOR_AGENT_SQL = `SELECT COUNT(*) as count FROM approval_requests
         WHERE agent_id = $1 AND status IN ('pending', 'approved')`

/** Same gating contract as `listAgentPayments`. */
export async function countPendingApprovalsForAgent(
  agentId: string,
  db: Executor = pool,
): Promise<number> {
  const result = await db.query<{ count: string }>(COUNT_PENDING_APPROVALS_FOR_AGENT_SQL, [agentId])
  return Number(result.rows[0].count)
}

/** `userId` is REQUIRED — this one IS tenant-scoped. */

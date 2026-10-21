/**
 * Data access for the agent tool-invocation audit trail (#999, epic #980).
 *
 * One aggregate: `agent_tool_invocations` — the per-request audit rows the
 * MCP tool-audit hook (`middleware/agentToolAudit.ts`) writes. Extracted
 * verbatim from that hook so `scripts/db-schema-smoke.ts` can PREPARE the
 * insert against the real schema. Convention: `README.md` in this directory.
 *
 * Invariant a reader must not break: writing here is BEST-EFFORT from the
 * caller's perspective — the hook catches and logs failures because the
 * user-visible response has already been sent. This function itself throws
 * normally; the swallow belongs to the hook, not the repository.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export const INSERT_AGENT_TOOL_INVOCATION_SQL = `INSERT INTO agent_tool_invocations
           (agent_id, user_id, tool_name, payment_id, result_status, next_action, error_code, status_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

export interface AgentToolInvocationInput {
  agentId: string
  /** REQUIRED — the tenant scope of the audit row. */
  userId: string
  toolName: string
  paymentId: string | null
  resultStatus: 'ok' | 'error' | 'denied'
  nextAction: string | null
  errorCode: string | null
  statusCode: number
}

export async function insertAgentToolInvocation(
  input: AgentToolInvocationInput,
  db: Executor = pool,
): Promise<void> {
  await db.query(INSERT_AGENT_TOOL_INVOCATION_SQL, [
    input.agentId,
    input.userId,
    input.toolName,
    input.paymentId,
    input.resultStatus,
    input.nextAction,
    input.errorCode,
    input.statusCode,
  ])
}

// ── Reads (moved from routes/agent-activity.ts, #1167) ───────────────────────

/**
 * The audit rows as the activity surfaces render them. Note these do NOT
 * select `user_id`: neither statement is tenant-scoped in SQL, so the caller
 * must have established that the agent(s) belong to the requesting user before
 * calling — see `agent-activity.ts` for the same contract on the payment side.
 */
export interface AgentToolInvocationRow {
  id: string
  tool_name: string
  payment_id: string | null
  result_status: string
  next_action: string | null
  error_code: string | null
  status_code: number | null
  created_at: string
}

export type FeedAgentToolInvocationRow = AgentToolInvocationRow & { agent_id: string }

export const LIST_TOOL_INVOCATIONS_FOR_AGENT_SQL = `SELECT id, tool_name, payment_id, result_status, next_action, error_code,
              status_code, created_at
       FROM agent_tool_invocations
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`

export const LIST_TOOL_INVOCATIONS_FOR_AGENTS_SQL = `SELECT id, agent_id, tool_name, payment_id, result_status, next_action,
              error_code, status_code, created_at
       FROM agent_tool_invocations
       WHERE agent_id = ANY($1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`

// ── Filtered single-agent read (#4229) ───────────────────────────────────────
//
// Same population as `LIST_TOOL_INVOCATIONS_FOR_AGENT_SQL` under the OPTIONAL
// filter set of the `kind=tool_calls` read. Fixed shape with `($n IS NULL OR
// …)` predicates so `db-schema-smoke` can PREPARE it; `q` searches the tool
// name and the error code.

export const LIST_TOOL_INVOCATIONS_FOR_AGENT_FILTERED_SQL = `SELECT id, tool_name, payment_id, result_status, next_action, error_code,
              status_code, created_at
       FROM agent_tool_invocations
       WHERE agent_id = $1
         AND ($2::text IS NULL OR result_status = $2)
         AND ($3::text IS NULL OR created_at >= $3::timestamptz)
         AND ($4::text IS NULL OR created_at < $4::timestamptz)
         AND ($5::text IS NULL OR tool_name ILIKE '%' || $5 || '%'
              OR error_code ILIKE '%' || $5 || '%')
         AND ($6::uuid IS NULL OR payment_id = $6::uuid)
       ORDER BY created_at DESC
       LIMIT $7 OFFSET $8`

/**
 * The filtered population's totals: `total_count` counts EVERY filter
 * (status included — the page's `total`), while `error_count` counts the
 * population WITHOUT the status filter — the summary-line number stays
 * stable while the caller flips the status selection. One round trip
 * serves both.
 */
export const COUNT_TOOL_INVOCATIONS_FOR_AGENT_FILTERED_SQL = `SELECT COUNT(*) FILTER (WHERE $2::text IS NULL OR result_status = $2) AS total_count,
              COUNT(*) FILTER (WHERE result_status = 'error') AS error_count
       FROM agent_tool_invocations
       WHERE agent_id = $1
         AND ($3::text IS NULL OR created_at >= $3::timestamptz)
         AND ($4::text IS NULL OR created_at < $4::timestamptz)
         AND ($5::text IS NULL OR tool_name ILIKE '%' || $5 || '%'
              OR error_code ILIKE '%' || $5 || '%')
         AND ($6::uuid IS NULL OR payment_id = $6::uuid)`

/**
 * The optional filter set behind `kind=tool_calls`. `status` is a raw
 * `result_status` ('ok' | 'error' | 'denied'). `from`/`to` are ISO bounds —
 * inclusive `from`, exclusive `to`. `q` is the trimmed search term (tool
 * name, error code). `paymentId` narrows to the calls of one payment.
 */
export interface AgentToolInvocationFilter {
  status: string | null
  from: string | null
  to: string | null
  q: string | null
  paymentId: string | null
}

function filteredInvocationArgs(agentId: string, filter: AgentToolInvocationFilter): unknown[] {
  return [agentId, filter.status, filter.from, filter.to, filter.q, filter.paymentId]
}

/** The count statement has no WHERE status arm — $2 is the status FILTER for the page total. */
function invocationCountArgs(agentId: string, filter: AgentToolInvocationFilter): unknown[] {
  return filteredInvocationArgs(agentId, filter)
}

/** NOT tenant-scoped — the caller must have verified agent ownership. */
export async function listToolInvocationsForAgentFiltered(
  agentId: string,
  filter: AgentToolInvocationFilter,
  limit: number,
  offset: number,
  db: Executor = pool,
): Promise<AgentToolInvocationRow[]> {
  const result = await db.query<AgentToolInvocationRow>(
    LIST_TOOL_INVOCATIONS_FOR_AGENT_FILTERED_SQL,
    [...filteredInvocationArgs(agentId, filter), limit, offset],
  )
  return result.rows
}

/**
 * Same gating contract as `listToolInvocationsForAgentFiltered`. Returns the
 * filtered population's total and its error count WITHOUT the status filter
 * (the summary-line number — see `COUNT_TOOL_INVOCATIONS_FOR_AGENT_FILTERED_SQL`).
 */
export async function countToolInvocationsForAgentFiltered(
  agentId: string,
  filter: AgentToolInvocationFilter,
  db: Executor = pool,
): Promise<{ total: number; errorCount: number }> {
  const result = await db.query<{ total_count: string; error_count: string }>(
    COUNT_TOOL_INVOCATIONS_FOR_AGENT_FILTERED_SQL,
    invocationCountArgs(agentId, filter),
  )
  return {
    total: Number(result.rows[0]?.total_count ?? 0),
    errorCount: Number(result.rows[0]?.error_count ?? 0),
  }
}

/** NOT tenant-scoped — the caller must have verified agent ownership. */
export async function listToolInvocationsForAgent(
  agentId: string,
  limit: number,
  offset: number,
  db: Executor = pool,
): Promise<AgentToolInvocationRow[]> {
  const result = await db.query<AgentToolInvocationRow>(LIST_TOOL_INVOCATIONS_FOR_AGENT_SQL, [
    agentId,
    limit,
    offset,
  ])
  return result.rows
}

/** NOT tenant-scoped — `agentIds` must come from a `user_id`-filtered read. */
export async function listToolInvocationsForAgents(
  agentIds: string[],
  limit: number,
  offset: number,
  db: Executor = pool,
): Promise<FeedAgentToolInvocationRow[]> {
  const result = await db.query<FeedAgentToolInvocationRow>(
    LIST_TOOL_INVOCATIONS_FOR_AGENTS_SQL,
    [agentIds, limit, offset],
  )
  return result.rows
}

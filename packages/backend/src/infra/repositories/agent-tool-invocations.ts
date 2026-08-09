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

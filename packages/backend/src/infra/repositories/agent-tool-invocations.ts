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

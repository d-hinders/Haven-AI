import type { PoolClient } from 'pg'

export const version = '015_agent_tool_invocations'

/**
 * Audit log for MCP (and future agent-runtime) tool invocations.
 *
 * Every API call that arrives with an `X-Haven-MCP-Tool: <tool_name>` header
 * produces one row here. The row is correlated to a payment_intent when the
 * tool created or affected one, but the audit log exists independently so
 * read-only tool calls (`haven_get_agent`, `haven_get_allowances`,
 * `haven_get_payment_status`, …) also leave a trail.
 *
 * The agent activity feed UI surfaces rows from this table alongside the
 * payment/approval streams so the wallet owner can see exactly what an
 * agent runtime asked Haven to do, regardless of whether it spent.
 *
 * Scopes are intentionally out of scope (see issue #163 follow-up): the
 * on-chain Safe AllowanceModule remains the policy primitive. This table
 * answers "what did the agent do," not "what was it authorized to do."
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_tool_invocations (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_name       VARCHAR(64) NOT NULL,
      payment_id      UUID REFERENCES payment_intents(id) ON DELETE SET NULL,
      result_status   VARCHAR(16) NOT NULL,
      next_action     VARCHAR(64),
      error_code      VARCHAR(64),
      status_code     INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_agent_tool_invocations_agent_created
      ON agent_tool_invocations(agent_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_agent_tool_invocations_user_created
      ON agent_tool_invocations(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_agent_tool_invocations_payment
      ON agent_tool_invocations(payment_id)
      WHERE payment_id IS NOT NULL;
  `)
}

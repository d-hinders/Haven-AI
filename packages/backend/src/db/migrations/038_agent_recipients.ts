import type { PoolClient } from 'pg'

export const version = '038_agent_recipients'

/**
 * Per-agent recipient allowlist (#784 decision: alternative A).
 *
 * The session rail's on-chain policy binds each session to ONE recipient
 * (Smart Sessions ParamRules AND together — #744), so an agent's recipients
 * must be stored per-agent for the schedule wiring (#769) to recompute the
 * deterministic session matrix (N recipients × M periods) statelessly.
 * Mirrors how allowances are modeled: one row per (agent, token, recipient).
 *
 * Budget semantics (the sharp edge from the #784 analysis): a budget CANNOT
 * aggregate across recipient-sessions on-chain — each session carries its own
 * cumulative limit. `budget_amount` NULL means the row inherits the agent's
 * full token allowance (`agent_allowances.allowance_amount`) — the common
 * single-recipient case is unchanged. With multiple recipients the owner
 * splits the budget by setting it per row; the on-chain truth is always the
 * per-row figure, never an aggregate.
 *
 * Additive and default-empty: an agent with NO rows keeps today's behavior
 * (no recipient restriction beyond the session policy it already has).
 * Legacy-rail agents are unaffected entirely — the AllowanceModule path does
 * not read this table.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_recipients (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      token_address     VARCHAR(42) NOT NULL,
      recipient_address VARCHAR(42) NOT NULL,
      label             VARCHAR(255),
      -- Per-recipient session budget in atomic units. NULL = inherit the
      -- agent's full token allowance (single-recipient common case).
      budget_amount     VARCHAR(78),
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent_id, token_address, recipient_address)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_recipients_agent
      ON agent_recipients(agent_id);
  `)
}

/**
 * Best-effort structural reverse (#1139) — mirrors what up() created. The
 * runner never calls down(); this exists for operator rollback tooling only.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS agent_recipients`)
}

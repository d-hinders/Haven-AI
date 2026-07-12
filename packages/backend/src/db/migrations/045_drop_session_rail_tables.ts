import type { PoolClient } from 'pg'

export const version = '045_drop_session_rail_tables'

/**
 * Drop the retired session-rail storage (#880, follow-up to #834).
 *
 * With the session rail retired (#834) and its route/lib deleted (#880),
 * two pieces of storage are dead — nothing reads or writes them:
 *
 * - `agent_recipients` (#784): session-rail recipient allowlist. The
 *   delegation rail pins recipients in the delegation itself; the legacy
 *   AllowanceModule path never read this table; the frontend card that wrote
 *   it (AgentRecipientsCard) was deleted in #834.
 * - `agents.session_schedule_from_period` / `session_schedule_period_count`
 *   (039): the pre-approved-window state the deleted schedule machinery
 *   managed.
 *
 * Dev-pilot data only; nothing external references it. Destructive → GitHub
 * code-owner review (the migrations CODEOWNERS gate).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS agent_recipients;

    ALTER TABLE agents
      DROP COLUMN IF EXISTS session_schedule_from_period,
      DROP COLUMN IF EXISTS session_schedule_period_count;
  `)
}

/**
 * Best-effort structural restore for reversibility. The DATA is gone (this is
 * a retirement, not a migration), but the shapes come back so a rollback
 * doesn't break older code paths — matches 038/039's definitions.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_recipients (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      token_address     VARCHAR(42) NOT NULL,
      recipient_address VARCHAR(42) NOT NULL,
      label             VARCHAR(255),
      budget_amount     VARCHAR(78),
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent_id, token_address, recipient_address)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_recipients_agent
      ON agent_recipients(agent_id);

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS session_schedule_from_period INTEGER,
      ADD COLUMN IF NOT EXISTS session_schedule_period_count INTEGER;
  `)
}

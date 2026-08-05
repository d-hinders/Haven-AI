import type { PoolClient } from 'pg'

export const version = '052_agent_connection_setup_passport'

/**
 * Carry the L0 Agent Passport opt-in (#972) through the Connect Agent 2 flow
 * (#1072). `POST /agents` already accepts `issue_passport` at creation time,
 * but the connector path creates its agent row inside `POST
 * /agent-connection-setups/register` — long after the setup (and its opt-in
 * checkbox) was created, and before an `agents` row exists to hang the flag
 * on. This column is where the choice waits in between.
 *
 * Defaults to false: absence of the flag is the normal case, identical to
 * today's connector flow, exactly like `issue_passport` on `POST /agents`.
 * Additive and non-destructive.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_connection_setups
      ADD COLUMN IF NOT EXISTS issue_passport BOOLEAN NOT NULL DEFAULT false;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_connection_setups
      DROP COLUMN IF EXISTS issue_passport;
  `)
}

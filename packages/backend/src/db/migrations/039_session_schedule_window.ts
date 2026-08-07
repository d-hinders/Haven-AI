import type { PoolClient } from 'pg'

export const version = '039_session_schedule_window'

/**
 * The enabled schedule window per agent (#769 wiring, epic #733).
 *
 * The pre-signed budget schedule enables N time-locked sessions in one owner
 * signature (lib/session-schedule.ts). Everything about those sessions is
 * deterministic — recomputable from (agent id, policy, period index) — so the
 * ONLY state worth storing is WHICH window the owner enabled: the first
 * period index and how many periods. From that plus the agent's stored policy
 * (agent_recipients #784 + agent_allowances) the authorize path recomputes
 * the current period's permissionId statelessly and lazy-rolls the recorded
 * session over with no signature (the owner already signed every session).
 *
 * NULL = no schedule enabled (fail-closed): the agent stays on single-session
 * behavior (#734 manual rotation), exactly as today. Additive; legacy-rail
 * agents never read these.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS session_schedule_from_period INTEGER,
      ADD COLUMN IF NOT EXISTS session_schedule_period_count INTEGER;
  `)
}

/**
 * Best-effort structural reverse (#1139) — mirrors what up() created. The
 * runner never calls down(); this exists for operator rollback tooling only.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agents
      DROP COLUMN IF EXISTS session_schedule_period_count,
      DROP COLUMN IF EXISTS session_schedule_from_period
  `)
}

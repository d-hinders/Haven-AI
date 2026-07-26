import type { PoolClient } from 'pg'

export const version = '050_agent_passport_revocation_index'

/**
 * Re-point the revocation sweep's index at the query that actually runs (#973).
 *
 * Migration 049 created:
 *
 *   ON agent_passports (revocation_next_attempt_at) WHERE revocation_status = 'pending'
 *
 * which matched the sweep as written *then*. The sweep was since redefined by
 * the INVARIANT rather than the flag — `p.status = 'anchored' AND
 * a.status = 'revoked' AND p.revocation_status <> 'confirmed'` — so that an
 * agent revoked mid-anchor (never enqueued, so never `pending`) is still picked
 * up. That fix silently orphaned the index: Postgres will only use a partial
 * index when the query's WHERE clause IMPLIES the index predicate, and
 * `<> 'confirmed'` does not imply `= 'pending'`. Both the retry sweep and the
 * stuck-revoke alarm degraded to a full scan of `agent_passports ⋈ agents`,
 * every five minutes, forever.
 *
 * Nothing caught it, and nothing could: `db:schema-smoke` only PREPAREs each
 * query, which validates that it parses and plans — not which plan it gets.
 * Invisible at today's row counts and steadily more expensive as they grow.
 *
 * The new predicate is exactly the passport-side half of both queries'
 * invariant, so it is implied by them and usable. The `a.status = 'revoked'`
 * half stays on the join, resolved through `agents`' primary key — correct,
 * because there are far fewer anchored passports than agents, so driving from
 * this index is the plan we want anyway.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_passports_revocation_due_idx
      ON agent_passports (revocation_next_attempt_at)
      WHERE status = 'anchored' AND revocation_status <> 'confirmed';
  `)

  // The 049 index is now dead weight — it can serve no query in the codebase,
  // and an unusable index still costs every write to this table.
  await client.query(`
    DROP INDEX IF EXISTS agent_passports_revocation_pending_idx;
  `)
}

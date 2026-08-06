import type { PoolClient } from 'pg'

export const version = '049_agent_passport_revocation'

/**
 * L0 Agent Passport revocation state (#973, epic #970).
 *
 * ## The consistency model this table encodes
 *
 * **Haven's DB is AUTHORITATIVE for "is this agent authorized right now?"** —
 * `agents.status = 'revoked'` IS the revocation, effective the instant it is
 * written. The EAS anchor is **eventually consistent**: a convenience anchor,
 * never the authority.
 *
 * That asymmetry is deliberate and it is the whole point of the seam (v6 review
 * point 1). An on-chain revoke is a transaction — it can lag, fail, or sit
 * unmined. If the chain were authoritative, a merchant checking on-chain during
 * that window would serve an agent Haven has already revoked. So the columns
 * below track only the ANCHOR's progress; they never gate the answer.
 *
 *   none      → no passport anchored, or nothing to revoke
 *   pending   → revoked in the DB, EAS revoke not yet confirmed
 *   confirmed → the on-chain flag agrees with the DB
 *
 * A failed anchor RETRIES with backoff until the two agree (owner decision
 * 2026-07-24) — a revoked agent whose on-chain flag never flipped is exactly
 * the divergence this issue exists to prevent. `revocation_next_attempt_at`
 * carries the backoff schedule, and a row left pending past a threshold is an
 * operational incident, queryable rather than silent.
 *
 * Additive and non-destructive.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_passports
      ADD COLUMN IF NOT EXISTS revocation_status TEXT NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS revocation_requested_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS revocation_confirmed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS revocation_tx_hash TEXT,
      ADD COLUMN IF NOT EXISTS revocation_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS revocation_last_error TEXT,
      ADD COLUMN IF NOT EXISTS revocation_next_attempt_at TIMESTAMPTZ;
  `)

  await client.query(`
    ALTER TABLE agent_passports
      DROP CONSTRAINT IF EXISTS agent_passport_revocation_status_valid;
  `)
  await client.query(`
    ALTER TABLE agent_passports
      ADD CONSTRAINT agent_passport_revocation_status_valid
      CHECK (revocation_status IN ('none', 'pending', 'confirmed'));
  `)

  // A confirmed revocation MUST carry its tx — "confirmed" is a claim about the
  // chain, and one with no transaction to point at is unfalsifiable. Same
  // discipline as the anchored-requires-UID constraint in 048.
  await client.query(`
    ALTER TABLE agent_passports
      DROP CONSTRAINT IF EXISTS agent_passport_revocation_confirmed_has_tx;
  `)
  await client.query(`
    ALTER TABLE agent_passports
      ADD CONSTRAINT agent_passport_revocation_confirmed_has_tx
      CHECK (revocation_status <> 'confirmed' OR revocation_tx_hash IS NOT NULL);
  `)

  // The reconciliation sweep and the stuck-revoke alarm both scan for pending
  // revocations that are due; index exactly that shape.
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_passports_revocation_pending_idx
      ON agent_passports (revocation_next_attempt_at)
      WHERE revocation_status = 'pending';
  `)
}

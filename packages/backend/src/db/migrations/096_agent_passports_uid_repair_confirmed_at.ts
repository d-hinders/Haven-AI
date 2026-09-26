import type { PoolClient } from 'pg'

/**
 * 096 — the anchor-UID repair sweep's confirmed-repair marker (#3342).
 *
 * #3294's repair selector ordered by `anchored_at ASC` with an hourly
 * `updated_at` re-visit guard, and a repaired phantom became one of the
 * permanent oldest rows: the batch of `limit` ticks re-read the same ten rows
 * every five minutes forever (the real-DB stall measured in #3342: 3 ticks,
 * 0 repaired, a live agent's phantom behind them never reached). Merely
 * stamping `updated_at` on a confirm read cannot fix that — the re-visit guard
 * would just roll the round-robin forward, and at 120+ rows the sweep
 * saturates at 5,760 receipt reads a day again.
 *
 * So a confirmed repair gets its own durable marker:
 * `uid_repair_confirmed_at` is set by `repairAnchoredUid` when the stored UID
 * already matches the receipt's, and the selector then excludes the row. A
 * healthy row costs the batch ONE read across its lifetime — reads per tick
 * stay bounded independent of how many healthy rows precede a phantom in the
 * queue, which is the acceptance criterion `updated_at` churn cannot meet.
 *
 * The marker is CANCELLED on every state change that invalidates the evidence
 * it recorded — a new anchor, a re-anchor reset, a revoke confirmation — so a
 * row that re-enters any anchored lifecycle is re-checked from scratch. It is
 * never read as "verified" anywhere else: `FIND_BY_AGENT_ADDRESS_SQL` keeps
 * breaking ties with `updated_at DESC`, and the merchant verifier's answer
 * does not churn.
 *
 * Nullable with no default: every existing row reads as unconfirmed and the
 * sweep re-reads it once, exactly once — the pre-marker population self-heals
 * onto the bounded queue on its first post-deploy tick.
 */
export const version = '096_agent_passports_uid_repair_confirmed_at'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_passports
      ADD COLUMN IF NOT EXISTS uid_repair_confirmed_at TIMESTAMPTZ
  `)
}

/**
 * Structural down (#1139): drops exactly what this migration created. No
 * index: the selector already filters on `status`, `tx_hash`,
 * `revocation_status` and `updated_at`, and a marker predicate rides that
 * same scan — a dedicated index would serve only this one qualifier.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_passports
      DROP COLUMN IF EXISTS uid_repair_confirmed_at
  `)
}

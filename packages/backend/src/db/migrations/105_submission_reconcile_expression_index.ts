import type { PoolClient } from 'pg'

export const version = '105_submission_reconcile_expression_index'

/**
 * 105 — expression index for the submission reconciler's candidate scan
 * (#3564).
 *
 * Pure performance; **no behaviour change** — the same guard as migration
 * 072's own header states for its two indexes. An index cannot alter which
 * rows a WHERE clause matches, so `FIND_OUTCOME_PENDING_INTENTS_SQL` admits
 * exactly the rows it did before. The repository suites are the proof of
 * that and stay green unchanged.
 *
 * ## The access path the index serves
 *
 * The reconciler tick runs every 60 s forever and selects the outcome-pending
 * population with `status = 'submitted' AND tx_hash IS NULL AND
 * machine_metadata->>'submission_outcome' = 'unknown' AND
 * machine_metadata->>'user_op_hash' IS NOT NULL`, ordered by `signed_at`.
 * That population is receipts-unconfirmed submits ONLY — normally ZERO rows.
 * Without this index the tick's plan is migration 072's sweeper index (or the
 * plain status index) reading every open submit and discarding all of them on
 * the metadata conjuncts: a per-minute scan whose cost is bounded by the
 * number of open submits, not by what the query actually wants. With it, the
 * plan is an index scan over an (almost always) empty set.
 *
 * This is the mirror of 072's rejected "narrower index" — there, the extra
 * key was a jsonb string literal the sweep's own predicate does not imply;
 * here the expression index IS the tick's own predicate, so the coupling runs
 * the safe direction: renaming the metadata key reddens the query tests this
 * migration's predicate is written from, rather than silently reverting the
 * plan to a scan.
 *
 * Ordinary btree; the runner cannot run CONCURRENTLY (migration 072's
 * operational note — the migrate runner wraps every migration in a
 * transaction, and Postgres refuses CONCURRENTLY inside one). The population
 * is near-empty on every environment, so the write cost is index-bloat-free
 * (rows without the metadata carry NULL for both expressions and take no
 * entry) and the build takes its lock over nothing.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_payment_intents_submission_outcome_pending
      ON payment_intents (signed_at)
      WHERE status = 'submitted'
        AND tx_hash IS NULL
        AND (machine_metadata->>'submission_outcome') = 'unknown'
        AND (machine_metadata->>'user_op_hash') IS NOT NULL
  `)
}

import type { PoolClient } from 'pg'

export const version = '072_payment_intents_settlement_indexes'

/**
 * Two indexes for the erc7710 settlement path on `payment_intents` (#2095).
 *
 * Pure performance; **no behaviour change**. An index cannot alter which rows
 * a `WHERE` clause matches, so every guard on this path — the replay guard,
 * the ambiguity guard, the CAS — refuses and admits exactly what it did
 * before. The #2092/#2094 repository suites are the proof of that and stay
 * green unchanged.
 *
 * ## Why two, and not the one the issue asked for
 *
 * #2095 was filed against #2092's replay guard alone. Two later changes
 * landed on the same rows and changed the access pattern, so the index set
 * was chosen against the tree as it is now, not as it was then:
 *
 * - **#2094 (PR #2129)** made the settlement child intent-unique.
 * - **#2117 (PR #2135)** added a passive settlement sweeper — a periodic,
 *   leader-gated job whose candidate query (`FIND_SWEEPABLE_ERC7710_INTENTS_SQL`)
 *   filters on `status` + rail + a `created_at` window and does **not**
 *   mention `tx_hash` except as `IS NULL`. It is a second, differently
 *   shaped reader of these rows, and the tx-hash index does nothing for it.
 *
 * Both were measured on the real-DB harness against a 200 000-row
 * `payment_intents` (92 MB heap; 140 000 rows carrying a hash, 20 000
 * `submitted`), with `EXPLAIN (ANALYZE, BUFFERS)` on the production SQL
 * itself rather than a paraphrase of it. A plan captured against a handful of
 * rows proves nothing — the planner ignores an index on a tiny table.
 *
 * ### 1. `idx_payment_intents_tx_hash_lower` — the replay guard
 *
 * `CONFIRM_SETTLEMENT_OBSERVED_SQL`'s first `NOT EXISTS` (one settlement
 * transaction may confirm at most one intent) plans as an **InitPlan over the
 * whole table**, and it was the dominant cost of the confirm, not merely its
 * correctness-critical part:
 *
 * ```
 * before: Seq Scan on payment_intents other — 200 000 rows, 11 796 buffers, 224.6 ms
 * after:  Index Scan using idx_payment_intents_tx_hash_lower —      3 buffers,   0.035 ms
 * whole UPDATE: 231.9 ms / 11 864 buffers  →  5.1 ms / 82 buffers
 * ```
 *
 * The expression and the partial predicate mirror the query's `LOWER(...)`
 * and `IS NOT NULL` exactly; anything else and the planner will not use it.
 *
 * **Partial, deliberately — for the write side, not for size.** At the
 * measured 70 % non-null the partial index is only 3 % smaller than the plain
 * expression index (13 238 272 B vs 13 656 064 B; a NULL btree entry is
 * cheap), so the issue's "most rows never carry one" premise does not hold as
 * a size argument. What does hold: **every** payment intent is INSERTed with
 * `tx_hash NULL` and only ever acquires one later, so under the partial
 * predicate the common write — the insert — touches this index not at all.
 * The plans are identical either way, so the partial form is never worse and
 * its advantage grows if the unconfirmed fraction does.
 *
 * A **unique** index is still deliberately not used, for #2095's original
 * reason: it would retroactively constrain historical rows. The replay guard
 * stays a query-level `NOT EXISTS` under the advisory lock
 * `confirmObservedSettlement` already takes.
 *
 * ### 2. `idx_payment_intents_open_submitted_created_at` — the sweeper
 *
 * The sweeper's candidate query could only reach its rows through
 * `idx_payment_intents_status`, which selects every `submitted` row on the
 * table and then discards ~95 % of them from the heap:
 *
 * ```
 * before: Bitmap Heap Scan (idx_payment_intents_status) + top-N sort
 *           — 20 000 rows scanned for 958 candidates, 11 812 buffers, 24.7 ms
 * after:  Index Scan using idx_payment_intents_open_submitted_created_at
 *           — 372 buffers, 1.7 ms, no sort node
 * ```
 *
 * The index key is `created_at`, so the `ORDER BY created_at ASC` is
 * satisfied by the scan and `LIMIT 200` terminates it early: the tick's cost
 * becomes a function of the batch size instead of the table size. That is the
 * property worth buying on a job that runs forever — the *time* saved today
 * is 23 ms, which alone would not justify an index; the *shape* change is
 * what does, because the old plan read ~92 MB of heap through shared buffers
 * on every tick and grows without bound.
 *
 * Its predicate is `status = 'submitted' AND tx_hash IS NULL` — the two
 * columns that define "an open intent" — and not the fuller rail/scheme
 * conjunction. A narrower index (adding `execution_rail`, `delegation_hash`
 * and `machine_metadata->>'settlement_scheme'`) was measured too and is
 * faster still (0.37 ms, 203 buffers, 168 KB vs 456 KB), but it buys 1.3 ms
 * by hard-coding a jsonb string literal into the schema: rename the scheme,
 * or add a rail to the sweep, and the predicate silently stops being implied
 * and the plan silently reverts to the scan above. Both forms are already
 * O(batch); only one of them cannot quietly stop working.
 *
 * ## Operational note for the reviewer — this build takes a lock
 *
 * The issue's suggested SQL used `CREATE INDEX CONCURRENTLY`. **This runner
 * cannot run it:** `migrate.ts` wraps every migration in `BEGIN`/`COMMIT`,
 * and Postgres refuses `CONCURRENTLY` inside a transaction block
 * (verified on the harness: SQLSTATE `25001`). So these are ordinary
 * `CREATE INDEX` statements, which hold a `SHARE` lock on `payment_intents`
 * and block writes to it for the duration of the build — measured at ~6.0 s
 * for the tx-hash index on the 200 000-row harness table.
 *
 * If that stall is unacceptable at production size, the escape needs no code
 * change: build both indexes by hand with `CREATE INDEX CONCURRENTLY` using
 * these exact names and definitions, and this migration's `IF NOT EXISTS`
 * makes it a no-op on the next boot.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_payment_intents_tx_hash_lower
      ON payment_intents (LOWER(tx_hash))
      WHERE tx_hash IS NOT NULL;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_payment_intents_open_submitted_created_at
      ON payment_intents (created_at)
      WHERE status = 'submitted' AND tx_hash IS NULL;
  `)
}

/**
 * Drop both indexes. Fully reversible and lossless: an index holds no data of
 * its own, so `down()` restores the exact pre-migration schema and the only
 * consequence is that the two queries above return to their previous plans.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_payment_intents_open_submitted_created_at;`)
  await client.query(`DROP INDEX IF EXISTS idx_payment_intents_tx_hash_lower;`)
}

import type { PoolClient } from 'pg'

export const version = '077_setup_run_mode'

/**
 * How the connector was run (#2528, B6 of the agent-first epic #2519).
 *
 * `run_mode` is `'json'` or `'prose'` — whether the connector was invoked with
 * `--json`. The connector knows this about itself and nothing else does: the
 * request arrives over the same HTTP call either way, so there is no header,
 * user agent or timing signal that recovers it. Together with `via`
 * (migration 076) and `source` (074) it answers the question D1 (#2529) is
 * built to ask — how much of the funnel an agent actually drove, and whether
 * the machine-readable path converts differently from the human one.
 *
 * ONE column, not two. The issue asked for `run_mode text` and `runtime text`;
 * **`runtime` has existed since migration 017** (`VARCHAR(80)` on this table)
 * and is already written by `markSetupRegistered`, so adding it again would
 * create a second, always-null column shadowing a populated one. Pinned by the
 * characterization test in `routes/__tests__/agent-connection-setups.test.ts`
 * that asserts `runtime` reaches the existing UPDATE today.
 *
 * Sanitised to the two-value enum at the route, exactly as `via` is, and for
 * the same reason: a free-text column on a segmenting metric lets whoever
 * calls the endpoint write anything into the dimension. Unknown values are
 * refused with 400 rather than stored.
 *
 * Nullable, no default. Absence means an older connector that predates this
 * field — identical to every row written before this migration, and the
 * register path accepts it unchanged. Additive and non-destructive: no
 * existing row is read or rewritten.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_connection_setups
      ADD COLUMN IF NOT EXISTS run_mode TEXT;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_connection_setups
      DROP COLUMN IF EXISTS run_mode;
  `)
}

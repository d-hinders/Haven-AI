import type { PoolClient } from 'pg'

export const version = '067_agents_mcp_server_name'

/**
 * #1878 (epic #1694): record which MCP server pair an agent was wired as, so
 * the dashboard can tell two agents in one harness apart.
 *
 * One runtime config can hold several Haven agents, each as its own
 * hosted+signer MCP pair keyed by server name (#1695). Until now that name
 * was LOCAL-ONLY — derived by `packages/connect/src/server-names.ts`, written
 * into the per-agent credential sidecar, and never sent to Haven. A user
 * looking at three agents in the dashboard had no way to map any of them to
 * an entry in their MCP config.
 *
 * ## Why the resolved NAME and not the slug
 *
 * The obvious column is the `--name` slug, with NULL meaning the unnamed
 * bare pair. That does not survive contact with #1696, which shipped `--name`
 * before this: named agents already exist with no recorded slug, so NULL has
 * to mean two different things —
 *
 *   'haven'         the bare pair, reported by a slug-aware connector
 *   'haven-<slug>'  a named pair, reported
 *   NULL            never reported (every agent predating this change, plus
 *                   anyone on an older connector)
 *
 * — and rendering that last case as the bare pair would mislabel exactly the
 * `--name`d agents multi-agent wiring exists to serve. Storing the resolved
 * hosted name distinguishes all three with one column and no sentinel, and it
 * is the exact string a user pastes into an MCP config. The signer half stays
 * derived (`serverNamesFor`), so the pair rule keeps one home.
 *
 * ## This is a display aid, never identity
 *
 * The value is SELF-REPORTED by the connector at registration and nothing may
 * key off it: no authority, no lookup, no authorization decision, and
 * deliberately NO UNIQUE constraint. Two agents can legitimately claim the
 * same name — on different machines, that is not even a conflict — and a
 * uniqueness error here would fail a registration over a label. If you are
 * reading this because you want to resolve an agent BY this column: don't.
 * `agents.id` and the API key are the identity.
 *
 * Nullable is not a soft option. Every agent that exists today has no name
 * and never will; backfilling a guess would be worse than the gap.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS mcp_server_name TEXT
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE agents DROP COLUMN IF EXISTS mcp_server_name`)
}

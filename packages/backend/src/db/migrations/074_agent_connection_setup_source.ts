import type { PoolClient } from 'pg'

export const version = '074_agent_connection_setup_source'

/**
 * Discovery-source attribution for the connect funnel (#2302, Agent Discovery
 * GTM track). Records WHERE a connection setup came from — a registry listing,
 * the /402 page, a starter template, a skill — so "attributed connects" is a
 * queryable fact instead of a guess.
 *
 * A dedicated column rather than `connector_context` because that JSONB is
 * OVERWRITTEN wholesale by the connector's own context at /register
 * (`MARK_SETUP_REGISTERED_SQL` sets `connector_context = $8::jsonb`), and the
 * source is known at CREATE time in the dashboard — it has to survive the
 * hop to registration, where it is echoed into the `agent_created` funnel
 * event's metadata for TTFP segmentation.
 *
 * Nullable, no default: absence means "organic / untagged", which is the
 * normal case and identical to every setup created before this migration.
 * Values are sanitized at the route (lowercase slug, max 32 chars) and an
 * unusable value degrades to NULL — attribution must never block a connect.
 * Additive and non-destructive.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_connection_setups
      ADD COLUMN IF NOT EXISTS source TEXT;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_connection_setups
      DROP COLUMN IF EXISTS source;
  `)
}

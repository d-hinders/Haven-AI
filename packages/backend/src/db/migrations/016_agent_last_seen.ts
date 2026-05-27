import type { PoolClient } from 'pg'

export const version = '016_agent_last_seen'

/**
 * Track when an agent last talked to Haven.
 *
 * Updated (throttled, best-effort) by `agentAuthMiddleware` on every
 * API-key-authenticated request, so the dashboard can show a live
 * "Connected · last seen N ago" indicator for each agent (see the hosted MCP
 * connect flow — docs/architecture/06-hosted-mcp-connect-flow.md). Nullable:
 * an agent that has been created but has never connected has no last_seen_at.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
  `)
}

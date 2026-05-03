import type { PoolClient } from 'pg'

export const version = '004_simplify_policy'

/**
 * Collapse agent policy onto the on-chain AllowanceModule.
 *
 * Drops the recipient allowlist (DB-only) and per-allowance approval_threshold.
 * The remaining policy lives entirely on-chain: token, amount, reset period.
 * Payments that exceed the on-chain remaining allowance are auto-queued for
 * manual approval by the payments routes.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS agent_allowed_recipients;
    DROP TABLE IF EXISTS self_sign_agent_recipients;

    ALTER TABLE agents               DROP COLUMN IF EXISTS restrict_recipients;
    ALTER TABLE self_sign_agents     DROP COLUMN IF EXISTS restrict_recipients;

    ALTER TABLE agent_allowances           DROP COLUMN IF EXISTS approval_threshold;
    ALTER TABLE self_sign_agent_allowances DROP COLUMN IF EXISTS approval_threshold;

    ALTER TABLE agents DROP COLUMN IF EXISTS monthly_limit;
    ALTER TABLE agents DROP COLUMN IF EXISTS per_tx_limit;
    ALTER TABLE agents DROP COLUMN IF EXISTS allowed_assets;
    ALTER TABLE agents DROP COLUMN IF EXISTS recipient_address;
  `)
}

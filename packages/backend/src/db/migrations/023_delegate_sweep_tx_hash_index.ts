import type { PoolClient } from 'pg'

export const version = '023_delegate_sweep_tx_hash_index'

/**
 * Transaction history enriches explorer rows with submitted sweep metadata by
 * user + tx hash. Keep that lookup indexed without bloating writes for
 * prepared/expired/failed sweeps that never appear as completed activity.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_delegate_sweeps_submitted_user_tx
      ON delegate_sweeps (user_id, lower(tx_hash))
      WHERE status = 'submitted' AND tx_hash IS NOT NULL;
  `)
}

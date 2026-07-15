import type { PoolClient } from 'pg'

export const version = '046_single_signer_waiver'

/**
 * Record the single-signer risk waiver for delegation-rail accounts (#908).
 *
 * The mainnet launch gate (recorded by #890, security model §6–7) says no
 * mainnet delegation-rail account may operate with fewer than two enrolled
 * signers unless the owner has EXPLICITLY acknowledged that losing their only
 * device loses the account. "Recorded, signed-off" needs durable storage:
 * this column is set (NOW()) exactly when a provisioning request on a
 * value-bearing chain carried `single_signer_waiver: { acknowledged: true }`
 * — and read back by grant activation, which refuses to activate budgets for
 * an under-floor mainnet account without it (lib/mainnet-gate.ts).
 *
 * NULL for every account that never needed a waiver: all testnet accounts,
 * and mainnet accounts provisioned with ≥2 signers. Additive, non-destructive.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE user_safes
      ADD COLUMN IF NOT EXISTS single_signer_waiver_at TIMESTAMPTZ;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE user_safes
      DROP COLUMN IF EXISTS single_signer_waiver_at;
  `)
}

import type { PoolClient } from 'pg'

export const version = '041_hybrid_accounts'

/**
 * Hybrid DeleGator accounts + the delegation rail value (#825, epic #821
 * Phase 1).
 *
 * New Haven accounts are MetaMask Hybrid DeleGator smart accounts (RFC #791
 * decision 6, spike #820). The account row is the existing user_safes table —
 * the address column is just an address — distinguished by `account_type`:
 *
 * - 'safe'             — every existing row (default; nothing changes)
 * - 'delegator_hybrid' — a Hybrid DeleGator (counterfactual until first op)
 *
 * The execution-rail CHECK widens to admit 'delegation'. FAIL-CLOSED BY
 * CONSTRUCTION at the time this migration shipped: resolveExecutionRail
 * matched 'session_key' explicitly and fell back to the legacy path for
 * everything else, so a 'delegation' row routed nowhere new — the value
 * existed so provisioning (#825) and the grant lifecycle (#828) could record
 * state, exactly the #745 dark-launch pattern. #829 later landed the payment
 * rail behind its own gate, which is when 'delegation' rows started routing.
 *
 * Additive and default-preserving; reversible by flipping values back.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE user_safes
      ADD COLUMN IF NOT EXISTS account_type VARCHAR(32) NOT NULL DEFAULT 'safe';

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_safes_account_type_check'
      ) THEN
        ALTER TABLE user_safes
          ADD CONSTRAINT user_safes_account_type_check
          CHECK (account_type IN ('safe', 'delegator_hybrid'));
      END IF;
    END $$;

    ALTER TABLE user_safes
      DROP CONSTRAINT IF EXISTS user_safes_execution_rail_check;
    ALTER TABLE user_safes
      ADD CONSTRAINT user_safes_execution_rail_check
      CHECK (execution_rail IN ('allowance_module', 'session_key', 'delegation'));
  `)
}

/**
 * Best-effort structural reverse (#1139) — mirrors what up() created. The
 * runner never calls down(); this exists for operator rollback tooling only.
 */
export async function down(client: PoolClient): Promise<void> {
  // Restore the pre-041 execution-rail CHECK (without 'delegation'), then
  // drop what up() added.
  await client.query(`ALTER TABLE user_safes DROP CONSTRAINT IF EXISTS user_safes_execution_rail_check`)
  await client.query(`
    ALTER TABLE user_safes
      ADD CONSTRAINT user_safes_execution_rail_check
      CHECK (execution_rail IN ('allowance_module', 'session_key'))
  `)
  await client.query(`ALTER TABLE user_safes DROP CONSTRAINT IF EXISTS user_safes_account_type_check`)
  await client.query(`ALTER TABLE user_safes DROP COLUMN IF EXISTS account_type`)
}

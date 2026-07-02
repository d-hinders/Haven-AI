import type { PoolClient } from 'pg'

export const version = '036_execution_rail'

/**
 * Per-account execution-rail state (epic #733, foundation #739 slice #745).
 *
 * The *execution* rail is which on-chain mechanism moves the money:
 * 'allowance_module' (today's Safe AllowanceModule + relayer path) or
 * 'session_key' (ERC-4337 Safe7579 + Smart Sessions, ADR #719 Stage 2). This
 * is a different axis from `payment_intents.payment_rail`, which is the
 * *protocol* rail (x402 / mpp / …) and is untouched here.
 *
 * Additive and default-legacy: every existing and new account stays on
 * 'allowance_module' until an operator explicitly migrates it — no account
 * silently switches. Reversible by flipping the column back; the #721-proven
 * migration is itself additive on-chain (the AllowanceModule path keeps
 * working on a migrated Safe), so rollback is a pure DB state change.
 *
 * - user_safes.execution_rail — which rail the Safe executes on. Set to
 *   'session_key' only after the Safe is provisioned to ERC-7579
 *   (safe7579-provisioning.ts) on that chain.
 * - agents.session_permission_id — the enabled Smart Sessions permissionId
 *   binding this agent's session key to its policy (session-policies.ts).
 *   NULL = no session; the agent stays on the legacy path even if its Safe
 *   is migrated (fail-closed, per-agent gradual rollout).
 * - payment_intents.execution_rail — pinned at authorize time so an intent is
 *   verified and executed on the rail whose hash the client signed, even if
 *   account state changes in between. NULL = legacy.
 * - payment_intents.session_permission_id — the permissionId pinned at
 *   authorize time (re-reading the agent at submit could race a session
 *   rotation and mismatch the signed hash).
 * - payment_intents.session_user_op — the prepared UserOperation (bigints
 *   serialized) whose hash the client signs; replayed verbatim at submit so
 *   hash and payload cannot drift.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE user_safes
      ADD COLUMN IF NOT EXISTS execution_rail VARCHAR(32) NOT NULL DEFAULT 'allowance_module';

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS session_permission_id VARCHAR(66);

    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS execution_rail VARCHAR(32),
      ADD COLUMN IF NOT EXISTS session_permission_id VARCHAR(66),
      ADD COLUMN IF NOT EXISTS session_user_op JSONB;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_safes_execution_rail_check'
      ) THEN
        ALTER TABLE user_safes
          ADD CONSTRAINT user_safes_execution_rail_check
          CHECK (execution_rail IN ('allowance_module', 'session_key'));
      END IF;
    END $$;
  `)
}

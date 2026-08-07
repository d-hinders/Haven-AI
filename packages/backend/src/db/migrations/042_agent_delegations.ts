import type { PoolClient } from 'pg'

export const version = '042_agent_delegations'

/**
 * Delegation lifecycle storage (#828, epic #821 Phase 2).
 *
 * One row per granted budget delegation. The signed delegation object is
 * spend-enabling ONLY together with the agent's delegate key (see the leak-
 * analysis table in docs/security/delegation-rail-security-model.md §3) and
 * is handled as api_key_hash-class data: platform-level encryption at rest,
 * never logged, never in error surfaces. An application-level envelope is a
 * documented hardening follow-up, not a blocker (the caveat stack bounds the
 * blast radius to one period budget regardless).
 *
 * Lifecycle: pending (built, awaiting the owner's offline signature) →
 * active → replaced | revoked. delegation_hash is the on-chain identity
 * (what disableDelegation targets); version feeds the #827 salt so every
 * replacement is a fresh identity (#813).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    -- Delegation-rail accounts need their owner identity for treasury ops
    -- (revoke = an owner-signed sponsored UserOp). NULL for Safe accounts,
    -- whose owners are read on-chain via getOwners().
    ALTER TABLE user_safes
      ADD COLUMN IF NOT EXISTS owner_address VARCHAR(42);

    CREATE TABLE IF NOT EXISTS agent_delegations (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      chain_id          INTEGER NOT NULL,
      token_address     VARCHAR(42) NOT NULL,
      recipient_address VARCHAR(42),
      delegation_hash   VARCHAR(66) NOT NULL UNIQUE,
      delegation_json   TEXT NOT NULL,
      version           INTEGER NOT NULL,
      status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'replaced', 'revoked')),
      budget_atomic     VARCHAR(78) NOT NULL,
      period_seconds    INTEGER NOT NULL,
      start_date        BIGINT NOT NULL,
      expires_at        BIGINT NOT NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT agent_delegations_lowercase_chk
        CHECK (token_address = LOWER(token_address)
               AND (recipient_address IS NULL OR recipient_address = LOWER(recipient_address)))
    );

    CREATE INDEX IF NOT EXISTS idx_agent_delegations_agent
      ON agent_delegations(agent_id, status);
  `)
}

/**
 * Best-effort structural reverse (#1139) — mirrors what up() created. The
 * runner never calls down(); this exists for operator rollback tooling only.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS agent_delegations`)
  await client.query(`ALTER TABLE user_safes DROP COLUMN IF EXISTS owner_address`)
}

import type { PoolClient } from 'pg'

export const version = '065_agent_rekeys'

/**
 * Re-key lineage and the ordering ledger (#1698, epic #1694).
 *
 * A re-key is not one call. Both the revoke and the issue are on-chain
 * operations the ACCOUNT OWNER signs, so the flow is necessarily several
 * round trips — and the ordering invariant has to survive between them:
 *
 * > "Revoke must precede issue, never the reverse. These are two on-chain
 * > operations and partial failure is possible in either direction.
 * > Revoke-then-issue fails to 'agent has no authority' — recoverable, and
 * > the correct posture when a key is lost. Issue-then-revoke fails to two
 * > simultaneously live keys." (#1694, owner)
 *
 * An invariant that only exists as the order of statements inside one request
 * handler cannot hold across requests: a client that skipped a call, retried
 * out of order, or raced itself would get whatever the handler happened to
 * do. So the ordering lives HERE, as a stage column with a CHECK constraint
 * and a partial unique index, and every route asserts the stage it requires
 * before doing anything. The stage is the guard; the handler order is just
 * how it is usually reached.
 *
 * ## Stages
 *
 * `preflight`  — opened. Rail checked, new delegate recorded, residual on the
 *                OLD delegate EOA read and dispositioned. Nothing retired.
 * `revoked`    — the owner-signed disableDelegation UserOp landed and the old
 *                delegations are marked revoked. The agent now has NO
 *                authority. This is the recoverable failure posture.
 * `metered`    — the frozen meter has been read and the carry snapshot
 *                persisted. Reading happens strictly AFTER `revoked`
 *                (amended by review on #1694: reading before leaves a window
 *                in which a payment lands and the carried remainder
 *                over-counts it; after the revoke the chain cannot move).
 * `issued`     — the new delegations are built and pending the owner's
 *                signature.
 * `completed`  — new delegations active, API key rotated, old-payer intents
 *                invalidated, `agents.delegate_address` swapped.
 * `abandoned`  — the owner gave up part-way. Recorded, not deleted: an
 *                abandoned re-key that reached `revoked` left an agent with
 *                no authority, and the dashboard has to be able to say so.
 *
 * Forward-only. There is deliberately no transition back to `preflight` from
 * `revoked` — the revoke happened on-chain and no row update can un-happen
 * it. Re-doing a re-key means abandoning this one and opening another.
 *
 * ## The carry snapshot
 *
 * `carry_snapshot` is JSONB rather than columns because it holds ONE ENTRY
 * PER REVOKED DELEGATION — an agent may hold several budgets (per token, per
 * recipient pin) and every one of them carries its own remainder and its own
 * boundary. A column set would model exactly one. It is written once, at the
 * `revoked` → `metered` transition, and read at issue; it is a frozen
 * measurement, so it is never updated in place.
 *
 * ## Custody note
 *
 * Nothing here holds key material, and that is structural rather than
 * incidental: `old_delegate_address` and `new_delegate_address` are PUBLIC
 * addresses. The new keypair is generated on the target machine and Haven
 * never receives the private half (#1694's non-custody invariant). The
 * rotated API key is stored as a hash on `agents`, exactly as before — this
 * table records THAT a rotation happened, never what it produced.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_rekeys (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id               UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      -- Owner-scoped by construction: re-key is authorised by the account
      -- owner, never by the agent (#1694 — "an agent can never re-key
      -- itself"). Recording the acting user makes that auditable rather than
      -- merely enforced at the route.
      initiated_by_user_id   UUID NOT NULL REFERENCES users(id),
      stage                  VARCHAR(16) NOT NULL DEFAULT 'preflight',
      old_delegate_address   VARCHAR(42) NOT NULL,
      new_delegate_address   VARCHAR(42) NOT NULL,
      -- Preflight: residual funds on the OLD delegate EOA. Recorded whether
      -- or not they are recoverable, because "unrecoverable" is the answer a
      -- lost-key re-key needs stated plainly rather than discovered later.
      residual_atomic        VARCHAR(78) NOT NULL DEFAULT '0',
      residual_token_address VARCHAR(42),
      residual_disposition   VARCHAR(24),
      -- Frozen meter, one entry per revoked delegation. Written once.
      carry_snapshot         JSONB,
      metered_at             TIMESTAMPTZ,
      revoke_tx_hash         VARCHAR(66),
      revoked_at             TIMESTAMPTZ,
      completed_at           TIMESTAMPTZ,
      abandoned_reason       TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT agent_rekeys_stage_check CHECK (
        stage IN ('preflight', 'revoked', 'metered', 'issued', 'completed', 'abandoned')
      ),
      CONSTRAINT agent_rekeys_residual_disposition_check CHECK (
        residual_disposition IS NULL
        OR residual_disposition IN ('none', 'swept', 'acknowledged_unrecoverable')
      ),
      -- The database's half of the ordering invariant: a row cannot claim to
      -- be metered without carrying the measurement, and cannot carry a
      -- measurement before the revoke that froze it. A route bug that wrote
      -- the snapshot early fails HERE rather than issuing a delegation
      -- against a meter that could still move.
      CONSTRAINT agent_rekeys_meter_after_revoke_check CHECK (
        (carry_snapshot IS NULL AND metered_at IS NULL)
        OR (carry_snapshot IS NOT NULL AND metered_at IS NOT NULL AND revoked_at IS NOT NULL
            AND metered_at >= revoked_at)
      ),
      CONSTRAINT agent_rekeys_metered_stage_check CHECK (
        stage NOT IN ('metered', 'issued', 'completed') OR carry_snapshot IS NOT NULL
      ),
      CONSTRAINT agent_rekeys_delegate_changes_check CHECK (
        LOWER(old_delegate_address) <> LOWER(new_delegate_address)
      )
    )
  `)

  // At most ONE re-key in flight per agent. Two concurrent re-keys would race
  // to revoke and issue against each other's snapshot, and the losing one
  // could resurrect authority the winner retired. Partial, so an agent's
  // completed/abandoned history is unbounded.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_rekeys_one_in_flight
      ON agent_rekeys (agent_id)
      WHERE stage IN ('preflight', 'revoked', 'metered', 'issued')
  `)

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_rekeys_agent_created
      ON agent_rekeys (agent_id, created_at DESC)
  `)

  // Lineage: which re-key produced this delegation. Nullable — every
  // delegation granted before this migration, and every ordinary owner
  // grant after it, has no re-key parent.
  await client.query(`
    ALTER TABLE agent_delegations
      ADD COLUMN IF NOT EXISTS rekey_id UUID REFERENCES agent_rekeys(id)
  `)
  await client.query(`
    ALTER TABLE agent_delegations
      ADD COLUMN IF NOT EXISTS carry_role VARCHAR(8)
  `)
  await client.query(`
    ALTER TABLE agent_delegations
      DROP CONSTRAINT IF EXISTS agent_delegations_carry_role_check
  `)
  await client.query(`
    ALTER TABLE agent_delegations
      ADD CONSTRAINT agent_delegations_carry_role_check
      CHECK (carry_role IS NULL OR carry_role IN ('carry', 'steady', 'reanchor'))
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_delegations_rekey
      ON agent_delegations (rekey_id) WHERE rekey_id IS NOT NULL
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_agent_delegations_rekey`)
  await client.query(
    `ALTER TABLE agent_delegations DROP CONSTRAINT IF EXISTS agent_delegations_carry_role_check`,
  )
  await client.query(`ALTER TABLE agent_delegations DROP COLUMN IF EXISTS carry_role`)
  await client.query(`ALTER TABLE agent_delegations DROP COLUMN IF EXISTS rekey_id`)
  await client.query(`DROP TABLE IF EXISTS agent_rekeys`)
}

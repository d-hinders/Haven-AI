import type { PoolClient } from 'pg'

/**
 * 095 — agent task budgets (#3329): a short-lived, self-delegated CHILD of an
 * agent's budget delegation, scoped to one task.
 *
 * Chain: `[task child, budget]` (leaf first). The child's delegate is the
 * agent's OWN delegate account (self-delegation) — never `ANY_BENEFICIARY` —
 * so it is a DIFFERENT typed-data class than a settlement child (whose
 * delegate is a facilitator/ANY_BENEFICIARY). `parent_delegation_hash` names
 * the `agent_delegations.delegation_hash` it was carved from; the child's own
 * identity lives in `delegation_hash` (UNIQUE — one row per on-chain child).
 *
 * `delegation_json` holds the UNSIGNED child while `status='pending'` and the
 * SIGNED child once `status='open'` — mirroring `agent_delegations` (#827).
 * `prepared_user_op` holds the unsigned close UserOp while `status='closing'`
 * (a `disableDelegation(child)` call from the agent's own delegate account,
 * owner decision #3329-2: close is authority-reducing only).
 *
 * "Expired" is DERIVED (`expires_at <= now`), never a stored status — the
 * same reasoning `agent_delegations` already applies to its own expiry: a
 * status column that must be kept in sync with the clock is a status column
 * that WILL drift. `is_expired` is computed on the wire by the repository/
 * service layer, not stored here.
 *
 * `payment_intents.task_budget_id` threads which task budget (if any)
 * authorized a payment, nullable — most payments carry none.
 */
export const version = '095_agent_task_budgets'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_task_budgets (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id               UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      chain_id               INTEGER NOT NULL,
      token_address          VARCHAR(42) NOT NULL,
      recipient_address      VARCHAR(42),
      parent_delegation_hash VARCHAR(66) NOT NULL,
      delegation_hash        VARCHAR(66) NOT NULL UNIQUE,
      delegation_json        TEXT NOT NULL,
      label                  VARCHAR(120),
      max_atomic             VARCHAR(78) NOT NULL,
      status                 VARCHAR(16) NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','open','closing','closed')),
      expires_at             BIGINT NOT NULL,
      prepared_user_op       TEXT,
      close_tx_hash          VARCHAR(66),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      opened_at  TIMESTAMPTZ,
      closed_at  TIMESTAMPTZ,
      CONSTRAINT agent_task_budgets_lowercase_chk CHECK (token_address = LOWER(token_address)
        AND (recipient_address IS NULL OR recipient_address = LOWER(recipient_address)))
    )
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_task_budgets_agent
      ON agent_task_budgets(agent_id, status)
  `)
  await client.query(`
    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS task_budget_id UUID REFERENCES agent_task_budgets(id)
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE payment_intents DROP COLUMN IF EXISTS task_budget_id`)
  await client.query(`DROP INDEX IF EXISTS idx_agent_task_budgets_agent`)
  await client.query(`DROP TABLE IF EXISTS agent_task_budgets`)
}

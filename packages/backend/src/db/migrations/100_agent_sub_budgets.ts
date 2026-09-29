import type { PoolClient } from 'pg'

/**
 * 100 — agent sub-budgets (#3330): an agent (A) re-delegates a narrower
 * budget to another agent (B) in the same account, as an ERC-7710 child of
 * A's OWN budget delegation.
 *
 * Two rows per tree, one table:
 *
 *   A's row   agent_id = A, parent_agent_id = A, parent_sub_budget_id NULL
 *             parent_delegation_hash = A's budget delegation
 *             (`agent_delegations.delegation_hash`) — the delegation A carves
 *             from, exactly what #3329's `parent_delegation_hash` named.
 *             Its child delegation is SELF-delegated (delegate === delegator
 *             === A's delegate account), narrowing A's budget to itself —
 *             the same shape class as a task-budget child.
 *
 *   B's row   agent_id = B, parent_agent_id = A,
 *             parent_sub_budget_id = A's row,
 *             parent_delegation_hash = A's CHILD's delegation_hash.
 *             Its child is delegated BY A's delegate account TO B's delegate
 *             account — a real grant between two accounts, never self.
 *
 * The redemption chain B walks is therefore `[B child, A child, A budget]` —
 * three links, leaf first, each link's `authority` naming the next — and the
 * DelegationManager enforces the caveats of ALL three hops in one redemption.
 *
 * `delegation_json` holds the UNSIGNED child while `status='pending'` and the
 * SIGNED child once `status='open'` — mirroring `agent_delegations` (#827)
 * and `agent_task_budgets` (#3329). The leaf's signature comes from the
 * delegating agent's delegate key (A signs both rows' children — owner
 * decision recorded in `docs/archive/decision-log.md` 2026-09-27).
 * `prepared_user_op` holds the unsigned close UserOp while
 * `status='closing'`.
 *
 * "Expired" is DERIVED (`expires_at <= now`), never a stored status — the
 * same reasoning migrations 095 (and `agent_delegations` itself) apply.
 *
 * `payment_intents.sub_budget_id` threads which sub-budget (if any)
 * authorized a payment, nullable — most payments carry none. v1 is
 * single-token only: a child is carved from a SINGLE-token budget
 * delegation; multi-token parents (`delegation-policy.ts`'s functionCall
 * scope) are out of scope (#3330 open question, answered in the slice).
 */
export const version = '100_agent_sub_budgets'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_sub_budgets (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id               UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      parent_agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      parent_sub_budget_id   UUID REFERENCES agent_sub_budgets(id) ON DELETE CASCADE,
      chain_id               INTEGER NOT NULL,
      token_address          VARCHAR(42) NOT NULL,
      recipient_address      VARCHAR(42),
      parent_delegation_hash VARCHAR(66) NOT NULL,
      delegation_hash        VARCHAR(66) NOT NULL UNIQUE,
      delegation_json        TEXT NOT NULL,
      label                  VARCHAR(120),
      period_amount_atomic   VARCHAR(78) NOT NULL,
      status                 VARCHAR(16) NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','open','closing','closed')),
      expires_at             BIGINT NOT NULL,
      prepared_user_op       TEXT,
      close_tx_hash          VARCHAR(66),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      opened_at  TIMESTAMPTZ,
      closed_at  TIMESTAMPTZ,
      CONSTRAINT agent_sub_budgets_lowercase_chk CHECK (token_address = LOWER(token_address)
        AND (recipient_address IS NULL OR recipient_address = LOWER(recipient_address))),
      CONSTRAINT agent_sub_budgets_self_parent_chk
        CHECK (parent_sub_budget_id IS NOT NULL OR parent_agent_id = agent_id)
    )
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_sub_budgets_agent
      ON agent_sub_budgets(agent_id, status)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_sub_budgets_parent_row
      ON agent_sub_budgets(parent_sub_budget_id)
  `)
  await client.query(`
    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS sub_budget_id UUID REFERENCES agent_sub_budgets(id)
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE payment_intents DROP COLUMN IF EXISTS sub_budget_id`)
  await client.query(`DROP INDEX IF EXISTS idx_agent_sub_budgets_parent_row`)
  await client.query(`DROP INDEX IF EXISTS idx_agent_sub_budgets_agent`)
  await client.query(`DROP TABLE IF EXISTS agent_sub_budgets`)
}

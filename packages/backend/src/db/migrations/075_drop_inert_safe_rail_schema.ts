import type { PoolClient } from 'pg'

export const version = '075_drop_inert_safe_rail_schema'

/**
 * Drop the inert Safe/session-rail schema and repoint the `execution_rail`
 * default at the one live rail (#2263, epic #1440).
 *
 * ## The default was the actual hazard
 *
 * `036_execution_rail.ts:40` created `user_safes.execution_rail` as
 * `NOT NULL DEFAULT 'allowance_module'`, and no later migration touched the
 * default — `041` dropped only the CHECK constraint. Nothing is broken TODAY
 * because the sole live insert (`routes/hybrid-accounts.ts`) hardcodes
 * `'delegation'`. But the default is what an insert gets when it says
 * nothing, and what it currently says is "put this account on a rail that
 * fail-closes at payment time" (#1986). The column is a ledgered keep — the
 * rail seam is deliberately reversible — while the default is not, and is
 * now actively wrong. Repointed at `'delegation'`.
 *
 * This is a default only: no row is rewritten. An existing
 * `allowance_module` or `session_key` row keeps its value, because the
 * retirement's contract is that a legacy account still READS in full and
 * still resolves to its own tombstone (`retired_allowance` /
 * `retired_session`), each with its own 410 body. Rewriting those rows would
 * silently promote retired accounts onto the live rail — the opposite of
 * fail-closed.
 *
 * ## The five inert objects
 *
 * Each verified by grep across `packages/` and `scripts/` before this change,
 * in both package-path and same-directory relative import forms, excluding
 * migrations:
 *
 * - `agent_allowances` — zero live SQL. Its last writer
 *   (`copySetupAllowancesToAgent`) was deleted by #2020; the agent
 *   `allowances` array has been projected from active `agent_delegations`
 *   since #1090. Every surviving mention is a comment asserting it is NOT
 *   read, or a test asserting the query is absent.
 *   `069_drop_safe_approver_metadata.ts:22` spared it citing "four live
 *   writers and five live readers" — true when written, falsified by #2020.
 * - `self_sign_agent_allowances` — created `000_initial.ts:220`, last touched
 *   by `004`, referenced nowhere outside migrations since. Its sibling
 *   `self_sign_agents` IS live and is deliberately untouched here.
 * - `agents.session_permission_id` — created `036:43` for the Smart Sessions
 *   rail retired by #834. Every `session_permission_id` grep hit in live
 *   code is on `payment_intents`, never on `agents`; `db-schema-smoke.ts`
 *   already notes that the real agent query dropped it.
 * - `payment_intents.session_user_op` — in the INSERT column list but bound
 *   as `sessionUserOp ?? null` with ZERO suppliers, so always NULL, and
 *   selected by nothing. Superseded by `prepared_user_op`
 *   (`043_delegation_intents.ts:16`), which is what the delegation rail
 *   actually replays.
 * - `payment_intents.session_permission_id` — the same no-supplier proof,
 *   but unlike the others it was PUBLISHED: selected in both
 *   `agent-activity.ts` feed queries and emitted on
 *   `GET /agents/:id/activity`. Always `null` for every row any account can
 *   create, since the only writer that ever supplied it was the session rail
 *   deleted by #834. Removed from the route, the OpenAPI spec and the
 *   generated `api-types` in this same change, so the wire shape and the
 *   schema move together.
 *
 * ## `payment_intents.allowance_nonce` — DECIDED: kept, wire-compat
 *
 * The issue asked for a decision rather than a third deferral. It is KEPT,
 * and the reasoning is recorded at the column's three writers and at its one
 * publication site rather than only here.
 *
 * It is inert in the same sense as the columns above — `NOT NULL` since
 * `000_initial.ts:83`, and all three live writers pass a literal `0`
 * (`routes/payments.ts`, `modules/x402/delegation-authorize.ts` ×2), so it
 * carries no information. But it differs on the one axis that matters here:
 * it is read back and published as `sign_data.components.nonce`
 * (`routes/payments.ts`), inside a block whose shape mirrors the
 * `executeAllowanceTransfer` argument list. Dropping it is therefore not a
 * schema cleanup but a change to a money-path RESPONSE shape, which needs
 * characterization tests over that surface and does not belong in a
 * CODEOWNERS-gated migration that is otherwise purely subtractive-and-inert.
 * Keeping a `NOT NULL DEFAULT`-less column that three writers fill with `0`
 * costs nothing at runtime and risks nothing; the reshape is separable and
 * can be taken on its own terms.
 *
 * Note the two different things a bare `grep allowance_nonce` conflates:
 * this COLUMN, kept here, and the `allowance_nonce_watermarks` TABLE, which
 * `071` already dropped.
 *
 * ## Destructive scope, and what is NOT deleted
 *
 * `DROP TABLE` without `CASCADE` and with no `DELETE FROM` first — the same
 * discipline `069`/`070`/`071` wrote down. Neither table has a child: nothing
 * in the schema declares `REFERENCES agent_allowances` or
 * `REFERENCES self_sign_agent_allowances`, so there are no cascading rows and
 * no evidence row is reachable from either. `agent_allowances` is itself a
 * CASCADE child of `agents`, which is the direction that is safe: dropping
 * the child cannot touch the parent.
 *
 * No evidence row is deleted. `machine_payment_evidence`,
 * `machine_payment_reconciliation_events` and `payment_intents` rows are all
 * untouched — this drops two tables that never held money-path evidence and
 * three columns that were always NULL or never read.
 *
 * Destructive → GitHub code-owner review (the `db/migrations/` CODEOWNERS
 * gate). Rollback: `down()` restores the SHAPE only — the two tables verbatim
 * as `004` left them (post-`approval_threshold`-drop), the three columns with
 * their `036` types, and the `execution_rail` default back to
 * `'allowance_module'`. The DATA is gone, and for these five objects that is
 * a non-event: the two tables are unread, and the three columns are NULL on
 * every row a live code path could have written.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE user_safes
      ALTER COLUMN execution_rail SET DEFAULT 'delegation';

    DROP TABLE IF EXISTS agent_allowances;
    DROP TABLE IF EXISTS self_sign_agent_allowances;

    ALTER TABLE agents
      DROP COLUMN IF EXISTS session_permission_id;

    ALTER TABLE payment_intents
      DROP COLUMN IF EXISTS session_user_op,
      DROP COLUMN IF EXISTS session_permission_id;
  `)
}

/**
 * Best-effort structural restore for reversibility. Table shapes are verbatim
 * from `000_initial.ts` as `004_simplify_policy.ts` left them (both lost
 * `approval_threshold` there); column types are verbatim from
 * `036_execution_rail.ts`. Data is not restored.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_allowances (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      token_address    VARCHAR(42) NOT NULL,
      token_symbol     VARCHAR(20) NOT NULL,
      allowance_amount VARCHAR(78) NOT NULL,
      reset_period_min INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent_id, token_address)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_allowances_agent_id ON agent_allowances(agent_id);

    CREATE TABLE IF NOT EXISTS self_sign_agent_allowances (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id         UUID NOT NULL REFERENCES self_sign_agents(id) ON DELETE CASCADE,
      token_address    VARCHAR(42) NOT NULL,
      token_symbol     VARCHAR(20) NOT NULL,
      allowance_amount VARCHAR(78) NOT NULL DEFAULT '0',
      reset_period_min INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent_id, token_address)
    );

    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS session_permission_id VARCHAR(66);

    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS session_permission_id VARCHAR(66),
      ADD COLUMN IF NOT EXISTS session_user_op JSONB;

    ALTER TABLE user_safes
      ALTER COLUMN execution_rail SET DEFAULT 'allowance_module';
  `)
}

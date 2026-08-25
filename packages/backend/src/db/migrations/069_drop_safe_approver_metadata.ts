import type { PoolClient } from 'pg'

export const version = '069_drop_safe_approver_metadata'

/**
 * Drop `safe_approver_metadata` — the retired Safe rail's approver-label
 * storage (epic #1440 slice 7, #1990).
 *
 * Nothing reads or writes this table. It had exactly one set of callers, the
 * approver routes, and #1988 deleted them; `infra/repositories/user-safes.ts`
 * and `routes/user-safes.ts` retain only prose comments about it. It was
 * always best-effort DECORATION — a label and an eoa/passkey type — never an
 * authority record: Safe owner membership was decided against the live
 * on-chain owner set, so no access-control answer ever depended on a row
 * here (024's own header says so).
 *
 * NOT dropped, deliberately, and each for its own reason:
 *
 * - `user_safes` rows and the `account_type` / `execution_rail` columns —
 *   owner decision on #1440 phase 5. Hybrid accounts live in the same table;
 *   readability and reversibility are the stated reasons.
 * - `agent_allowances` — still has four live writers and five live readers.
 *   `routes/agents.ts:95` reads it for ALL agent ids BEFORE the
 *   `account_type` branch, so it is on the hot path for pure delegation-rail
 *   users. Split out to #2020.
 * - `approval_requests` — dropping it contradicts #1440's own "accounts and
 *   history stay READABLE" and would break `GET /transactions` on every
 *   rail. Split out to #2021 as an owner DECISION, not a work item.
 *
 * ⚠️ For whoever writes #2021's migration, since this file is the precedent
 * they will copy: DO NOT `DELETE FROM` a table before dropping it.
 * `machine_payment_evidence.approval_request_id` is `ON DELETE CASCADE`
 * (018), so emptying `approval_requests` first silently destroys money-path
 * payment evidence. `DROP TABLE` drops dependent constraints, not child rows.
 * That hazard does not apply here — nothing references
 * `safe_approver_metadata`; its only foreign key points outward, at
 * `user_safes(id)`, and dropping the child leaves the parent untouched.
 *
 * Destructive → GitHub code-owner review (the `db/migrations/` CODEOWNERS
 * gate). Rollback: `down()` restores the SHAPE only, verbatim from 024. The
 * DATA is gone — this is a retirement, not a migration. Restoring the shape
 * means an older backend rolled back onto this schema finds the table it
 * expects, with every Safe owner simply showing up unlabelled, which is the
 * exact degradation 024 designed for ("a missing row just means an owner
 * shows up unlabelled").
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS safe_approver_metadata;
  `)
}

/**
 * Best-effort structural restore for reversibility — byte-for-byte the shape
 * 024 created, including the lower-cased unique index. Data is not restored.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS safe_approver_metadata (
      id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      safe_id     UUID         NOT NULL REFERENCES user_safes(id) ON DELETE CASCADE,
      address     VARCHAR(42)  NOT NULL,
      type        VARCHAR(16)  NOT NULL DEFAULT 'eoa' CHECK (type IN ('eoa', 'passkey')),
      label       VARCHAR(120),
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `)

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS safe_approver_metadata_safe_addr
      ON safe_approver_metadata (safe_id, LOWER(address))
  `)
}

import type { PoolClient } from 'pg'

export const version = '071_drop_allowance_nonce_watermarks'

/**
 * Drop `allowance_nonce_watermarks` — the retired Safe/AllowanceModule rail's
 * cross-replica nonce watermark (epic #1440 slice, #2084).
 *
 * **No control is removed, because this table was never one.** 055's own
 * header says what it held: a WATERMARK, "not a lock — nothing here
 * serialises anything". It was the shared half of a *liveness* fix (#692,
 * #718, #1196), never a safety one. Signing against an already-consumed
 * nonce was made SAFE by the #693 preflight, not by this table; what a stale
 * read cost was a failed-and-retried payment. So its absence cannot weaken a
 * guardrail — there is no double-spend it was standing between.
 *
 * It has been INERT since #1987, which deleted the coordinator
 * (`rails/allowance-nonce-coordinator.ts`), the repository
 * (`infra/repositories/allowance-nonce-watermarks.ts`), `readSharedWatermark`,
 * `waitForFreshAllowanceNonce`, the structural test policing the builders, all
 * four call sites, and `generateTransferHash` itself. Verified again here
 * rather than inherited: zero SQL statements in the repository name this table
 * in any clause. The remaining mentions are all prose — 055 itself, two
 * comments citing it as a precedent (repointed in this change),
 * `docs/operations/backend-scaling.md`, which keeps the multi-replica lesson
 * deliberately past-tense, and the dated CASP changelog shards, which are
 * frozen history. Note that the live `payment_intents.allowance_nonce`
 * COLUMN is a different thing entirely and is untouched — a bare
 * `grep allowance_nonce` conflates the two.
 *
 * **The 069/070 CASCADE hazard does not apply here, and that is by 055's
 * design rather than by luck.** Those two migrations carry a loud warning
 * about `DROP TABLE ... CASCADE` versus `DELETE FROM`, because
 * `machine_payment_evidence.approval_request_id` is `ON DELETE CASCADE` and
 * emptying the parent first would have destroyed money-path evidence. This
 * table has no foreign key in EITHER direction: 055 states it is
 * "Deliberately NOT foreign-keyed to `user_safes`/`agents`" precisely so it
 * could never fail a money-path write over referential drift. Nothing
 * references it and it references nothing, so no child rows exist to cascade.
 * The `DROP TABLE` below is still written the safe way — no `DELETE FROM`
 * first — so that this file cannot become the counter-precedent if it is the
 * one someone copies next.
 *
 * **Data loss is a non-event, and uniquely so among this epic's drops.** 055
 * called these rows disposable in as many words: losing the table "degrades
 * the system to the pre-#718 in-process behaviour, never to incorrectness".
 * Since #1987 there is not even that to degrade — no code reads or writes it,
 * so the rows are scratch state for a rail that no longer executes.
 *
 * Destructive → GitHub code-owner review (the `db/migrations/` CODEOWNERS
 * gate). Rollback: `down()` restores the SHAPE only, verbatim from 055,
 * including the four-column primary key. The DATA is gone. An older backend
 * rolled back onto this schema finds an empty table and rebuilds its
 * watermarks from the chain on the next confirmed transfer, which is the
 * same state a fresh deployment has always started in.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS allowance_nonce_watermarks;
  `)
}

/**
 * Best-effort structural restore for reversibility — byte-for-byte the shape
 * 055 created. Data is not restored.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS allowance_nonce_watermarks (
      chain_id INTEGER NOT NULL,
      safe_address TEXT NOT NULL,
      delegate_address TEXT NOT NULL,
      token_address TEXT NOT NULL,
      nonce BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chain_id, safe_address, delegate_address, token_address)
    )
  `)
}

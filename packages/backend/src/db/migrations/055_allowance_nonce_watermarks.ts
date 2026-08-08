import type { PoolClient } from 'pg'

export const version = '055_allowance_nonce_watermarks'

/**
 * Cross-replica allowance-nonce watermarks (#718).
 *
 * The AllowanceModule keeps ONE on-chain nonce per (safe, delegate, token).
 * When a transfer confirms, the next signature must target the incremented
 * nonce — but RPC reads lag, so #692 added a coordinator that waits for the
 * increment to become visible before signing. That coordinator was a
 * process-local `Map`, which is correct for exactly one backend replica.
 *
 * Scale the backend horizontally and the guarantee silently narrows: replica B
 * knows nothing about the transfer replica A just confirmed, reads a stale
 * nonce, and signs against an already-consumed one. The #693 preflight still
 * makes that SAFE — no double-spend — but payments start failing and retrying,
 * which is the failure #692 existed to remove.
 *
 * This table is the shared half of that memory: the highest nonce any replica
 * has observed after a confirmed transfer. It is a WATERMARK, not a lock —
 * nothing here serialises anything, and a row is only ever raised, never
 * lowered (`GREATEST`), because a lower value can only be a late write from a
 * replica that fell behind.
 *
 * Deliberately NOT foreign-keyed to `user_safes`/`agents`: the watermark is
 * about an address triple as the CHAIN sees it, and it must never be able to
 * fail a money-path write over referential drift. Rows are tiny and bounded by
 * the number of live (safe, delegate, token) triples; they are also disposable
 * — losing this table degrades the system to the pre-#718 in-process
 * behaviour, never to incorrectness.
 */
export async function up(client: PoolClient): Promise<void> {
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

/**
 * Structural down: the coordinator falls back to its in-process map when the
 * table is absent (the read is fail-open by design), so dropping this is a
 * capability rollback, never a data-integrity event.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS allowance_nonce_watermarks')
}

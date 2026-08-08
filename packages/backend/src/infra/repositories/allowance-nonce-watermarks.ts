/**
 * Data access for `allowance_nonce_watermarks` (#718) — the cross-replica half
 * of the #692 allowance-nonce coordinator.
 *
 * Convention: `README.md` in this directory. One deviation, deliberate and
 * load-bearing:
 *
 * **Both functions are FAIL-OPEN.** A read that errors returns `null` and a
 * write that errors is swallowed, because this table is an optimisation, not
 * an authority. Note what that does and does not cover: a REJECTION is handled
 * here, but a query that is slow and never settles is not — the coordinator
 * bounds the read with its own timeout for that, since nothing in the pool or
 * the HTTP layer would. It exists to avoid a revert-and-retry, and the #693 preflight
 * is what actually keeps the money safe. Letting a database hiccup here block
 * a payment would trade a rare retry for an outage — the wrong direction on a
 * money path. Callers therefore degrade to the pre-#718 in-process behaviour,
 * never to incorrectness.
 *
 * The watermark only ever RISES (`GREATEST` in the upsert): a lower incoming
 * value can only be a late write from a replica that fell behind, and honouring
 * it would re-open the stale-nonce window this table exists to close.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export const UPSERT_ALLOWANCE_NONCE_WATERMARK_SQL = `INSERT INTO allowance_nonce_watermarks
       (chain_id, safe_address, delegate_address, token_address, nonce, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (chain_id, safe_address, delegate_address, token_address)
     DO UPDATE SET nonce = GREATEST(allowance_nonce_watermarks.nonce, EXCLUDED.nonce),
                   updated_at = NOW()`

/**
 * Bounded by `updated_at`, and that bound is load-bearing (#718 review).
 *
 * `GREATEST` means a watermark can never come DOWN, and the write is backed by
 * a single confirmation — so a reorg, an RPC reporting a nonce from a dropped
 * block, or two environments sharing a database can persist a nonce the chain
 * never reaches. Unbounded, that row would then make every later authorize for
 * the triple poll to the full 15 s and burn ~10 RPC reads, forever, surviving
 * restarts, with nothing able to lower it.
 *
 * The window this tier closes is seconds-scale RPC lag, so a watermark older
 * than a few minutes carries no information anyway. Ignoring it caps the blast
 * radius of a bad row at minutes instead of permanently — without weakening
 * monotonicity, since a stale row is simply not consulted.
 */
export const WATERMARK_STALENESS_INTERVAL = '5 minutes'

export const FIND_ALLOWANCE_NONCE_WATERMARK_SQL = `SELECT nonce FROM allowance_nonce_watermarks
     WHERE chain_id = $1 AND safe_address = $2 AND delegate_address = $3 AND token_address = $4
       AND updated_at > NOW() - INTERVAL '${WATERMARK_STALENESS_INTERVAL}'`

/**
 * Raise the watermark for one (chain, safe, delegate, token) triple.
 *
 * The triple is lower-cased HERE rather than trusted to arrive that way. On a
 * primary key where casing splits the row — two rows for one triple, each
 * holding half the truth — that is worth making a property of the function
 * instead of an obligation on every caller. Same argument as fail-open.
 */
export async function raiseAllowanceNonceWatermark(
  chainId: number,
  safeAddress: string,
  delegateAddress: string,
  tokenAddress: string,
  nonce: number,
  db: Executor = pool,
): Promise<void> {
  try {
    await db.query(UPSERT_ALLOWANCE_NONCE_WATERMARK_SQL, [
      chainId,
      safeAddress.toLowerCase(),
      delegateAddress.toLowerCase(),
      tokenAddress.toLowerCase(),
      nonce,
    ])
  } catch {
    // Fail-open: see the file header. A lost watermark costs a retry, not money.
  }
}

/** The highest nonce any replica has seen confirmed, or `null` if unknown. */
export async function findAllowanceNonceWatermark(
  chainId: number,
  safeAddress: string,
  delegateAddress: string,
  tokenAddress: string,
  db: Executor = pool,
): Promise<number | null> {
  try {
    const result = await db.query<{ nonce: string }>(FIND_ALLOWANCE_NONCE_WATERMARK_SQL, [
      chainId,
      safeAddress.toLowerCase(),
      delegateAddress.toLowerCase(),
      tokenAddress.toLowerCase(),
    ])
    const raw = result.rows[0]?.nonce
    // BIGINT arrives as a string from pg; the nonce is far below Number's safe
    // integer range (it counts allowance transfers), so this is lossless.
    return raw === undefined ? null : Number(raw)
  } catch {
    return null
  }
}

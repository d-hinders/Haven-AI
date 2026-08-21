/**
 * Data access for a Hybrid DeleGator's signer set (#1081).
 *
 * `hybrid_account_passkeys` + `user_safes.owner_address` are what the deploy
 * and signing paths rebuild an account's owner config from (#885), so these
 * writes must track the chain exactly — they run only after a signer-change
 * UserOperation has actually landed.
 *
 * Lives here because `pg-only-in-infra` (rule 3,
 * `docs/architecture/10-module-boundaries.md`) reserves SQL for this
 * directory, and the shared signer-action core in `lib/` may not reach the
 * pool. Follows the conventions `agent-passports.ts` set for #985: explicit
 * `executor` last defaulting to the pool, domain-shaped arguments, and the
 * scoping key as a required parameter — `userSafeId` IS the tenant scope
 * here, so it is never defaulted or inferred.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

/** Record a newly enrolled passkey against the account. */
export async function addAccountPasskey(
  userSafeId: string,
  passkey: { keyId: string; x: string; y: string },
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `INSERT INTO hybrid_account_passkeys (user_safe_id, key_id, public_key_x, public_key_y)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [userSafeId, passkey.keyId, passkey.x, passkey.y],
  )
}

/** Drop a passkey that has been removed on-chain. */
export async function removeAccountPasskey(
  userSafeId: string,
  keyId: string,
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `DELETE FROM hybrid_account_passkeys WHERE user_safe_id = $1 AND LOWER(key_id) = LOWER($2)`,
    [userSafeId, keyId],
  )
}

/** Record the EOA owner an account has just transferred ownership to. */
export async function setAccountOwnerAddress(
  userSafeId: string,
  ownerAddress: string,
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `UPDATE user_safes SET owner_address = $1 WHERE id = $2`,
    [ownerAddress.toLowerCase(), userSafeId],
  )
}

/** Clear the EOA owner after an on-chain transferOwnership(address(0)) (#1087). */
export async function clearAccountOwnerAddress(
  userSafeId: string,
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `UPDATE user_safes SET owner_address = NULL WHERE id = $1`,
    [userSafeId],
  )
}

// ── Owner-config passkey set (moved from rails/hybrid-account-config.ts, #999)

export const LIST_ACCOUNT_PASSKEYS_SQL = `SELECT key_id, public_key_x, public_key_y, created_at
     FROM hybrid_account_passkeys
     WHERE user_safe_id = $1
     ORDER BY created_at ASC`

export interface AccountPasskeyRow {
  key_id: string
  public_key_x: string
  public_key_y: string
  /**
   * Enrollment time (#1679) — surfaced so the UI can label rows
   * "Passkey · added {date}". Optional defensively: mapping tolerates rows
   * without it (see passkeyEnrollmentDates).
   */
  created_at?: Date | string | null
}

/**
 * `userSafeId` IS the tenant scope here (see the header). Ordered by
 * enrollment time so the derived owner config is deterministic.
 */
export async function listAccountPasskeys(
  userSafeId: string,
  executor: Executor = pool,
): Promise<AccountPasskeyRow[]> {
  const result = await executor.query<AccountPasskeyRow>(LIST_ACCOUNT_PASSKEYS_SQL, [userSafeId])
  return result.rows
}

/**
 * key_id (lowercased) → enrollment time as an ISO string (#1679), for the
 * signer-set reads to join onto the owner config. Defensive on purpose: a row
 * with a missing or unparseable `created_at` is simply absent from the map —
 * the API then serves `created_at: null` and the UI falls back to ordinal
 * "Passkey N", never a fabricated date and never a 500.
 */
export function passkeyEnrollmentDates(rows: AccountPasskeyRow[]): Map<string, string> {
  const byKey = new Map<string, string>()
  for (const r of rows) {
    if (r.created_at === null || r.created_at === undefined) continue
    const date = new Date(r.created_at)
    if (Number.isNaN(date.getTime())) continue
    byKey.set(r.key_id.toLowerCase(), date.toISOString())
  }
  return byKey
}

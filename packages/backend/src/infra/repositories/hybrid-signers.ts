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

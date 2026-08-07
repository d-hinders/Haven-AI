/**
 * Data access for the user-passkeys aggregate (#999, epic #980).
 *
 * One aggregate: `user_passkeys` — the WebAuthn credentials users enroll as
 * Safe passkey signers (POC flow). Extracted verbatim from
 * `routes/passkeys.ts` and `routes/safe-exec.ts`. Convention: `README.md` in
 * this directory.
 *
 * Invariant a reader must not break: the insert deliberately does NOT verify
 * the attestation cryptographically (POC — a bad enrollment only harms the
 * enrolling user); the raw attestation is persisted for future verification.
 * Unique-violation mapping (per-chain and per-credential) stays in the route,
 * which owns the HTTP shape of those conflicts.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export interface UserPasskeyRow {
  id: string
  credential_id: string
  signer_address: string
  chain_id: number
  safe_address?: string | null
  created_at?: string
}

export const INSERT_USER_PASSKEY_SQL = `INSERT INTO user_passkeys (
           user_id, credential_id, public_key_x, public_key_y, signer_address, chain_id, raw_attestation
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, credential_id, signer_address, chain_id`

export const LIST_USER_PASSKEYS_SQL = `SELECT id, credential_id, signer_address, chain_id, safe_address, created_at
       FROM user_passkeys
       WHERE user_id = $1
       ORDER BY created_at ASC`

export const FIND_PASSKEY_FOR_SAFE_SQL = `SELECT public_key_x, public_key_y, signer_address
       FROM user_passkeys
       WHERE user_id = $1
         AND LOWER(safe_address) = LOWER($2)
         AND chain_id = $3`

export interface StoredPasskeySafeRow {
  public_key_x: Buffer
  public_key_y: Buffer
  signer_address: string
}

/**
 * `userId` is REQUIRED — enrollment is per-tenant. Throws pg unique-violation
 * errors through to the caller, which maps the constraint names to 409s.
 */
export async function insertUserPasskey(
  input: {
    userId: string
    credentialId: string
    publicKeyX: Buffer
    publicKeyY: Buffer
    signerAddress: string
    chainId: number
    rawAttestation: Buffer | null
  },
  db: Executor = pool,
): Promise<UserPasskeyRow> {
  const result = await db.query<UserPasskeyRow>(INSERT_USER_PASSKEY_SQL, [
    input.userId,
    input.credentialId,
    input.publicKeyX,
    input.publicKeyY,
    input.signerAddress,
    input.chainId,
    input.rawAttestation,
  ])
  return result.rows[0]
}

/** `userId` is REQUIRED — tenant scope for the passkey list. */
export async function listUserPasskeys(
  userId: string,
  db: Executor = pool,
): Promise<UserPasskeyRow[]> {
  const result = await db.query<UserPasskeyRow>(LIST_USER_PASSKEYS_SQL, [userId])
  return result.rows
}

/**
 * The passkey bound to (user, safe, chain) — the ownership check the
 * passkey-Safe exec path runs before building any transaction. `userId` is
 * REQUIRED.
 */
export async function findPasskeyForSafe(
  userId: string,
  safeAddress: string,
  chainId: number,
  db: Executor = pool,
): Promise<StoredPasskeySafeRow | null> {
  const result = await db.query<StoredPasskeySafeRow>(FIND_PASSKEY_FOR_SAFE_SQL, [
    userId,
    safeAddress,
    chainId,
  ])
  return result.rows[0] ?? null
}

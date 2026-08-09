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
 * Unique-violation mapping (credential id) stays in the route, which owns the
 * HTTP shape of that conflict.
 *
 * Since #1229 a user may hold SEVERAL passkeys per chain — the extra ones are
 * backup signers, the only recovery this rail has. So `(user_id, chain_id)`
 * identifies a SET, never a row; resolve a single passkey by credential id
 * (`findUserPasskeyByCredential`) or by its Safe binding
 * (`findPasskeyForSafe`), and treat `safe_address` as a fast-path hint that
 * only the Safe's on-chain owner list can confirm.
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

export const FIND_PASSKEY_FOR_SAFE_SQL = `SELECT credential_id, public_key_x, public_key_y, signer_address, safe_address
       FROM user_passkeys
       WHERE user_id = $1
         AND LOWER(safe_address) = LOWER($2)
         AND chain_id = $3`

export const FIND_PASSKEY_BY_CREDENTIAL_SQL = `SELECT credential_id, public_key_x, public_key_y, signer_address, safe_address
       FROM user_passkeys
       WHERE user_id = $1
         AND chain_id = $2
         AND credential_id = $3`

export const LIST_PASSKEY_SIGNERS_FOR_CHAIN_SQL = `SELECT credential_id, public_key_x, public_key_y, signer_address, safe_address
       FROM user_passkeys
       WHERE user_id = $1
         AND chain_id = $2
       ORDER BY created_at ASC`

/**
 * Claim an UNBOUND passkey row for a Safe. Deliberately `safe_address IS NULL`
 * rather than an unconditional update: a passkey can be an owner of several
 * Safes, and this column is a fast-path hint for the exec route, not a
 * membership record. Overwriting it would move the hint off the Safe it was
 * first bound to and slow that one down to the on-chain check for no gain.
 */
export const BIND_PASSKEY_TO_SAFE_SQL = `UPDATE user_passkeys
       SET safe_address = $3
       WHERE user_id = $1
         AND credential_id = $2
         AND safe_address IS NULL`

/** Same claim, addressed by signer address — what the approver routes know. */
export const BIND_PASSKEY_SIGNER_TO_SAFE_SQL = `UPDATE user_passkeys
       SET safe_address = $4
       WHERE user_id = $1
         AND chain_id = $2
         AND LOWER(signer_address) = LOWER($3)
         AND safe_address IS NULL`

export interface StoredPasskeySafeRow {
  credential_id: string
  public_key_x: Buffer
  public_key_y: Buffer
  signer_address: string
  safe_address: string | null
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

/**
 * The passkey bound to (user, chain, credential) — the resolution the exec
 * path uses once a user may hold more than one passkey per chain (#1229).
 * `userId` is REQUIRED: the credential id arrives from the client, so tenant
 * scope is what stops it naming someone else's row.
 */
export async function findUserPasskeyByCredential(
  userId: string,
  chainId: number,
  credentialId: string,
  db: Executor = pool,
): Promise<StoredPasskeySafeRow | null> {
  const result = await db.query<StoredPasskeySafeRow>(FIND_PASSKEY_BY_CREDENTIAL_SQL, [
    userId,
    chainId,
    credentialId,
  ])
  return result.rows[0] ?? null
}

/** Every passkey the user holds on a chain, oldest first. `userId` REQUIRED. */
export async function listPasskeySignersForChain(
  userId: string,
  chainId: number,
  db: Executor = pool,
): Promise<StoredPasskeySafeRow[]> {
  const result = await db.query<StoredPasskeySafeRow>(LIST_PASSKEY_SIGNERS_FOR_CHAIN_SQL, [
    userId,
    chainId,
  ])
  return result.rows
}

/**
 * Bind an as-yet-unbound passkey to a Safe. No-op when the row is already
 * bound (see `BIND_PASSKEY_TO_SAFE_SQL`). Returns whether a row was claimed.
 */
export async function bindPasskeyToSafe(
  userId: string,
  credentialId: string,
  safeAddress: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query(BIND_PASSKEY_TO_SAFE_SQL, [userId, credentialId, safeAddress])
  return (result.rowCount ?? 0) > 0
}

/**
 * Bind by signer address rather than credential id — the form the approver
 * routes have, since an owner change names an address. Same no-op-when-bound
 * semantics as `bindPasskeyToSafe`.
 */
export async function bindPasskeySignerToSafe(
  userId: string,
  chainId: number,
  signerAddress: string,
  safeAddress: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query(BIND_PASSKEY_SIGNER_TO_SAFE_SQL, [
    userId,
    chainId,
    signerAddress,
    safeAddress,
  ])
  return (result.rowCount ?? 0) > 0
}

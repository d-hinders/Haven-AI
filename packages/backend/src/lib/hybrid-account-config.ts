/**
 * Reconstruct a Hybrid account's owner configuration from storage (#885,
 * epic #836).
 *
 * The account address in user_safes was derived from EXACTLY this config at
 * provisioning time (owner_address + the hybrid_account_passkeys rows). The
 * deploy (#860) and revoke paths rebuild it from here so a pure-passkey
 * account — which has no owner_address — can still be deployed and operated.
 */
import pool from '../db.js'
import type { Address } from 'viem'
import type { HybridOwnerConfig } from './hybrid-provisioning.js'

export interface StoredPasskey {
  keyId: string
  x: bigint
  y: bigint
}

/**
 * Load the owner config for a Hybrid account, owner-scoped. Returns null when
 * the account is unknown OR carries no signer at all (neither owner_address
 * nor a passkey) — callers translate that to a clean 409.
 */
export async function loadHybridOwnerConfig(
  userId: string,
  safeAddress: string,
  chainId: number,
): Promise<{ config: HybridOwnerConfig; userSafeId: string } | null> {
  // chain_id is part of the row identity: the same owner config derives the
  // same address on EVERY chain, so a user can hold rows for one address on
  // both testnet and mainnet. Without the bind, rows[0] of an unordered
  // result could return the OTHER chain's signer set — found by the #908
  // money-path review (a testnet row's backup passkey must never satisfy the
  // mainnet signer floor).
  const safeRow = await pool.query<{ id: string; owner_address: string | null }>(
    `SELECT id, owner_address FROM user_safes
     WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3`,
    [userId, safeAddress, chainId],
  )
  const safe = safeRow.rows[0]
  if (!safe) return null

  const passkeyRows = await pool.query<{ key_id: string; public_key_x: string; public_key_y: string }>(
    `SELECT key_id, public_key_x, public_key_y
     FROM hybrid_account_passkeys
     WHERE user_safe_id = $1
     ORDER BY created_at ASC`,
    [safe.id],
  )
  const passkeys: StoredPasskey[] = passkeyRows.rows.map((r) => ({
    keyId: r.key_id,
    x: BigInt(r.public_key_x),
    y: BigInt(r.public_key_y),
  }))

  if (!safe.owner_address && passkeys.length === 0) return null

  return {
    userSafeId: safe.id,
    config: {
      ownerAddress: (safe.owner_address as Address | null) ?? undefined,
      passkeys: passkeys.length > 0 ? passkeys : undefined,
    },
  }
}

/** True when the account's only authority is passkeys (no EOA owner). */
export function isPasskeyOnly(config: HybridOwnerConfig): boolean {
  return !config.ownerAddress && !!config.passkeys && config.passkeys.length > 0
}

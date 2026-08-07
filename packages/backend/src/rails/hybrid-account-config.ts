/**
 * Reconstruct a Hybrid account's owner configuration from storage (#885,
 * epic #836).
 *
 * The account address in user_safes was derived from EXACTLY this config at
 * provisioning time (owner_address + the hybrid_account_passkeys rows). The
 * deploy (#860) and revoke paths rebuild it from here so a pure-passkey
 * account — which has no owner_address — can still be deployed and operated.
 */
import { findHybridOwnerSafeRow } from '../infra/repositories/user-safes.js'
import { listAccountPasskeys } from '../infra/repositories/hybrid-signers.js'
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
): Promise<{ config: HybridOwnerConfig; userSafeId: string; singleSignerWaiverAt: string | null } | null> {
  // The queries live in the repositories (#999): the account row bind is
  // chain-scoped — see FIND_HYBRID_OWNER_SAFE_ROW_SQL's note on the #908
  // testnet/mainnet signer-set hazard.
  const safe = await findHybridOwnerSafeRow(userId, safeAddress, chainId)
  if (!safe) return null

  const passkeyRows = await listAccountPasskeys(safe.id)
  const passkeys: StoredPasskey[] = passkeyRows.map((r) => ({
    keyId: r.key_id,
    x: BigInt(r.public_key_x),
    y: BigInt(r.public_key_y),
  }))

  if (!safe.owner_address && passkeys.length === 0) return null

  return {
    userSafeId: safe.id,
    singleSignerWaiverAt: safe.single_signer_waiver_at ?? null,
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

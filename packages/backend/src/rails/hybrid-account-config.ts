/**
 * Reconstruct a Hybrid account's owner configuration from storage (#885,
 * epic #836).
 *
 * The account address in smart_accounts was derived from EXACTLY this config at
 * provisioning time (owner_address + the hybrid_account_passkeys rows + the
 * per-account deploy salt, #4023). The deploy (#860) and revoke paths rebuild
 * it from here so a pure-passkey account — which has no owner_address — can
 * still be deployed and operated.
 */
import { findHybridOwnerAccountRow } from '../infra/repositories/smart-accounts.js'
import { listAccountPasskeys } from '../infra/repositories/hybrid-signers.js'
import type { Address, Hex } from 'viem'
import type { SaltedHybridOwnerConfig } from './hybrid-provisioning.js'

export interface StoredPasskey {
  keyId: string
  x: bigint
  y: bigint
}

/**
 * Load the owner config for a Hybrid account, owner-scoped. Returns null when
 * the account is unknown OR carries no signer at all (neither owner_address
 * nor a passkey) — callers translate that to a clean 409.
 *
 * The returned config is SALTED (#4023): `deploySalt` is the account's stored
 * per-account deploy salt (`'0x'` for every account created before #4023),
 * and every consumer derives or deploys THIS account with it. A user account
 * must never be derived at the literal salt-0 again — that is a different
 * account than the row describes.
 */
export async function loadHybridOwnerConfig(
  userId: string,
  accountAddress: string,
  chainId: number,
): Promise<{ config: SaltedHybridOwnerConfig; accountId: string; singleSignerWaiverAt: string | null } | null> {
  // The queries live in the repositories (#999): the account row bind is
  // chain-scoped — see FIND_HYBRID_OWNER_ACCOUNT_ROW_SQL's note on the #908
  // testnet/mainnet signer-set hazard.
  const account = await findHybridOwnerAccountRow(userId, accountAddress, chainId)
  if (!account) return null

  const passkeyRows = await listAccountPasskeys(account.id)
  const passkeys: StoredPasskey[] = passkeyRows.map((r) => ({
    keyId: r.key_id,
    x: BigInt(r.public_key_x),
    y: BigInt(r.public_key_y),
  }))

  if (!account.owner_address && passkeys.length === 0) return null

  return {
    accountId: account.id,
    singleSignerWaiverAt: account.single_signer_waiver_at ?? null,
    config: {
      ownerAddress: (account.owner_address as Address | null) ?? undefined,
      passkeys: passkeys.length > 0 ? passkeys : undefined,
      deploySalt: (account.deploy_salt ?? '0x') as Hex,
    },
  }
}

/** True when the account's only authority is passkeys (no EOA owner). */
export function isPasskeyOnly(config: SaltedHybridOwnerConfig): boolean {
  return !config.ownerAddress && !!config.passkeys && config.passkeys.length > 0
}

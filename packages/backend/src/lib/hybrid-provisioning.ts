/**
 * Hybrid DeleGator provisioning (#825, epic #821 Phase 1).
 *
 * Computes the COUNTERFACTUAL account address for a new Hybrid DeleGator —
 * no transaction, no deployment: the address is deterministic from the
 * owner configuration, and actual on-chain deployment happens with the first
 * sponsored operation (the grant flow, #828 — a delegation's EIP-1271
 * signature needs deployed code, so grant deploys if needed).
 *
 * Non-custody: address derivation uses a WATCH-ONLY owner (the session-rail
 * pattern) — this module can never sign anything, loudly (#824 invariant 5).
 *
 * Two owner configurations (the Hybrid account's native shapes):
 * - EOA owner:      deployParams [ownerAddress, [], [], []]
 * - Passkey owner:  deployParams [zeroAddress, [keyId], [x], [y]] — pure P256;
 *   both may be combined (EOA + N passkeys) which #836 (recovery) will use.
 */

import { http, createPublicClient, zeroAddress, type Address, type LocalAccount } from 'viem'
import { toAccount } from 'viem/accounts'
import { Implementation, toMetaMaskSmartAccount } from '@metamask/smart-accounts-kit'
import { getChain } from './chains.js'
import { chainForId } from './session-rail.js'
import { getDelegationContracts } from './delegation-contracts.js'

export interface PasskeySigner {
  /** WebAuthn credential id (hex or base64url-derived hex, per the kit). */
  keyId: string
  /** P256 public key coordinates as 0x-hex. */
  x: bigint
  y: bigint
}

export interface HybridOwnerConfig {
  /** EOA owner — omit for a pure-passkey account. */
  ownerAddress?: Address
  /** P256/passkey signers — omit for a pure-EOA account. */
  passkeys?: PasskeySigner[]
}

function watchOnly(address: Address): LocalAccount {
  const refuse = async (): Promise<never> => {
    throw new Error('non-custody: provisioning is watch-only and cannot sign')
  }
  return toAccount({
    address,
    signMessage: refuse,
    signTransaction: refuse,
    signTypedData: refuse,
  })
}

/**
 * The deterministic account address for an owner configuration. Read-only:
 * one RPC to derive via the pinned factory. Throws on a chain without pinned
 * delegation contracts (fail-closed, #825).
 */
export async function computeHybridAccountAddress(
  chainId: number,
  owner: HybridOwnerConfig,
): Promise<Address> {
  getDelegationContracts(chainId) // fail-closed on unpinned chains

  const eoa = owner.ownerAddress ?? zeroAddress
  const passkeys = owner.passkeys ?? []
  if (eoa === zeroAddress && passkeys.length === 0) {
    throw new Error('hybrid provisioning: at least one owner (EOA or passkey) is required')
  }

  const client = createPublicClient({
    chain: chainForId(chainId),
    transport: http(getChain(chainId).rpcUrl),
  })
  const account = await toMetaMaskSmartAccount({
    client: client as never, // two viem instances in the type graph — runtime-identical
    implementation: Implementation.Hybrid,
    deployParams: [
      eoa,
      passkeys.map((p) => p.keyId),
      passkeys.map((p) => p.x),
      passkeys.map((p) => p.y),
    ],
    deploySalt: '0x',
    signer: { account: watchOnly(eoa === zeroAddress ? '0x0000000000000000000000000000000000000001' : eoa) },
  })
  return account.address
}

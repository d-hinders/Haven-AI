/**
 * Hybrid DeleGator provisioning (#825, epic #821 Phase 1).
 *
 * Computes the COUNTERFACTUAL account address for a new Hybrid DeleGator —
 * no transaction, no deployment: the address is deterministic from the
 * owner configuration. Actual deployment happens at grant activation
 * (ensureHybridDeployed, #860): a delegation's EIP-1271 signature needs
 * deployed code, and the relayer's factory call is permissionless — no
 * owner signature, no owner transaction.
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

import { getDelegationContracts, chainForId } from './delegation-contracts.js'

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

async function buildWatchOnlyAccount(chainId: number, owner: HybridOwnerConfig) {
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
  return { account, client }
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
  const { account } = await buildWatchOnlyAccount(chainId, owner)
  return account.address
}

export interface EnsureDeployedResult {
  address: Address
  alreadyDeployed: boolean
  txHash?: string
}

/**
 * Deploy the counterfactual Hybrid if it has no code yet (#860).
 *
 * A 4337 factory deploy is PERMISSIONLESS — it instantiates the account with
 * the owner configuration baked into the deterministic address and grants the
 * deployer nothing. Haven's relayer therefore deploys the delegator account
 * without any owner signature, preserving the grant flow's one-signature UX.
 * This must happen before the first redemption: the DelegationManager
 * validates the delegator's delegation signature via EIP-1271, which reverts
 * against an account with no code (found live by the #835 DoD).
 *
 * Non-custody unchanged: the relayer signs a plain transaction to the audited
 * factory; the deployed account's signers are the owner's keys, never Haven's.
 */
export async function ensureHybridDeployed(
  chainId: number,
  owner: HybridOwnerConfig,
  /**
   * The account's KNOWN address, when the caller has one (#891 fix). Checked
   * FIRST: a deployed account short-circuits before any derivation — the
   * signer set may have evolved since provisioning (addKey/removeKey, #888),
   * in which case deriving from the CURRENT set would derive a different,
   * wrong address and deploy a spurious account.
   */
  expectedAddress?: Address,
  /** #717: who this deploy is billed to (relayer gas budget + attribution). */
  attribution?: { agentId?: string | null; userId?: string | null },
): Promise<EnsureDeployedResult> {
  if (expectedAddress) {
    const client = createPublicClient({
      chain: chainForId(chainId),
      transport: http(getChain(chainId).rpcUrl),
    })
    const existing = await client.getBytecode({ address: expectedAddress })
    if (existing && existing !== '0x') {
      return { address: expectedAddress, alreadyDeployed: true }
    }
  }
  const { account, client } = await buildWatchOnlyAccount(chainId, owner)

  const code = await client.getBytecode({ address: account.address })
  if (code && code !== '0x') {
    return { address: account.address, alreadyDeployed: true }
  }

  const { factory, factoryData } = await account.getFactoryArgs()
  if (!factory || !factoryData) {
    throw new Error('hybrid provisioning: account reports no factory args to deploy with')
  }

  // #717: budget check BEFORE the relayer signs — over-cap throws (429 at
  // the route); lazy import keeps the pure derivation path free of db wiring.
  const { assertRelayerBudget, recordRelayerSpend, finishRelayerSpend } = await import('./relayer-spend-guard.js')
  await assertRelayerBudget('hybrid_deploy', attribution ?? {})
  // Attempt row before broadcast: bursts see each other, and the row exists
  // even when tx.wait() throws on a reverted deploy (ethers v6).
  const spendId = await recordRelayerSpend({
    operation: 'hybrid_deploy',
    chainId,
    agentId: attribution?.agentId,
    userId: attribution?.userId,
  })

  // Lazy import: the relayer wiring pulls ethers + env config; keep the pure
  // derivation path (compute…) free of it for tests and scripts.
  const { getRelayer, getRelayerFeeOverrides, withRelayerSendLock } = await import('./relayer.js')
  const relayer = getRelayer(chainId)
  if (!relayer.provider) {
    throw new Error('hybrid provisioning: relayer has no provider')
  }
  const overrides = await getRelayerFeeOverrides(relayer.provider)
  const tx = await withRelayerSendLock(chainId, () =>
    relayer.sendTransaction({ to: factory, data: factoryData, ...overrides }),
  )
  let receipt
  try {
    receipt = await tx.wait()
  } finally {
    // Stamp the hash whatever happened — a reverting deploy burned gas too,
    // and ethers v6 throws out of wait() on revert.
    await finishRelayerSpend(spendId, {
      txHash: tx.hash,
      gasUsed: receipt ? BigInt(receipt.gasUsed.toString()) : null,
      effectiveGasPrice: receipt?.gasPrice != null ? BigInt(receipt.gasPrice.toString()) : null,
    })
  }
  if (!receipt || receipt.status !== 1) {
    throw new Error(`hybrid deploy transaction reverted (${tx.hash})`)
  }
  return { address: account.address, alreadyDeployed: false, txHash: tx.hash }
}

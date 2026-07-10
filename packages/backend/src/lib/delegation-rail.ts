/**
 * Delegation rail — sponsored redemption gas routing (#826, epic #821).
 *
 * The shape proven by spike #820 case 8, productionized: the DELEGATE is
 * itself a counterfactual Hybrid DeleGator owned by the agent key, and a
 * redemption rides a sponsored ERC-4337 UserOp calling
 * DelegationManager.redeemDelegations. Consequences:
 *
 * - The agent key holds NO funds and NO gas — the paymaster sponsors, and
 *   sponsorship can only pay gas, never move value (#824 invariant 10).
 * - Haven holds NO key at all: the delegate account is constructed with a
 *   WATCH-ONLY owner that refuses to sign, loudly (#824 invariant 5); the
 *   agent signs the userOpHash client-side and the backend only relays —
 *   the #737 prepare/submit split, delegation flavor.
 * - Sponsorship exhaustion degrades to "payments pause" (the bundler
 *   declines, prepare/submit throws, the route 502s cleanly) — NEVER to
 *   "policy weakens": the caveat stack is enforced on-chain regardless of
 *   who pays gas.
 *
 * Vendor credential: {@link delegationRailBundlerUrl} is the ONE place the
 * bundler secret is read for this rail (#824 invariant 9); every error
 * surface must pass redactVendorSecrets (bundler errors echo the URL, #764).
 *
 * Nothing routes here yet — #829 wires the payment flow. Runbook:
 * docs/operations/delegation-rail-vendor-ops.md.
 */

import { http, createPublicClient, type Address, type Hex, type LocalAccount } from 'viem'
import { toAccount } from 'viem/accounts'
import { entryPoint07Address, toPackedUserOperation } from 'viem/account-abstraction'
import { getUserOperationHash } from 'viem/account-abstraction'
import { SIGNABLE_USER_OP_TYPED_DATA } from '@metamask/smart-accounts-kit/utils'
import { createSmartAccountClient } from 'permissionless'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import {
  Implementation,
  toMetaMaskSmartAccount,
  createExecution,
  ExecutionMode,
  contracts,
  type Delegation,
} from '@metamask/smart-accounts-kit'
import { encodeFunctionData, parseAbi } from 'viem'
import { getChain } from './chains.js'
import { chainForId } from './session-rail.js'
import { getDelegationContracts, DELEGATION_RAIL_CHAIN_IDS } from './delegation-contracts.js'

const ERC20_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

/**
 * Bundler endpoint for the delegation rail — env-only SECRET (hosted bundler
 * URLs embed the API key). Falls back to the session rail's credential (same
 * Pimlico account on Base Sepolia); a dedicated var lets ops split vendors
 * per rail later without code changes. Never logged, never persisted.
 */
export function delegationRailBundlerUrl(chainId: number): string {
  const url = process.env.DELEGATION_RAIL_BUNDLER_URL || process.env.SESSION_RAIL_BUNDLER_URL
  if (!url) {
    throw new Error('DELEGATION_RAIL_BUNDLER_URL is not configured — delegation rail unavailable')
  }
  if (!DELEGATION_RAIL_CHAIN_IDS.has(chainId)) {
    throw new Error(`delegation rail: chain ${chainId} is not enabled`)
  }
  return url
}

/** Watch-only agent-key owner — refuses to sign, loudly (#824 invariant 5). */
export function watchOnlyDelegateOwner(address: Address): LocalAccount {
  const refuse = async (): Promise<never> => {
    throw new Error('non-custody: the backend cannot sign as the agent delegate')
  }
  return toAccount({
    address,
    signMessage: refuse,
    signTransaction: refuse,
    signTypedData: refuse,
  })
}

export interface DelegationRailConfig {
  /** The agent key's address — the OWNER of the delegate Hybrid account. */
  delegateOwnerAddress: Address
  chainId: number
  bundlerUrl: string
  rpcUrl: string
  /** Pimlico sponsorship-policy id (per-request binding — the #738 lesson). */
  sponsorshipPolicyId?: string
}

export interface PreparedRedemption {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userOperation: any
  /** The 4337 userOp hash — an identifier for logs/evidence, NOT what is signed. */
  userOpHash: Hex
  /**
   * What the agent key ACTUALLY signs: the account's EIP-712 typed data over
   * the packed UserOperation. HybridDeleGator validates exactly this in
   * `validateUserOp` — signing the bare 4337 hash would be rejected on-chain.
   * All bigints are stringified so the payload survives JSON transport.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signingTypedData: any
  /** The delegate smart account (counterfactual until first op). */
  delegateAccountAddress: Address
}

/** The account's typed data for a prepared UserOperation (see the interface). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function userOpTypedData(userOperation: any, accountAddress: Address, chainId: number): any {
  const packed = toPackedUserOperation({ ...userOperation, signature: '0x' })
  const message: Record<string, unknown> = { ...packed, entryPoint: entryPoint07Address }
  for (const [key, value] of Object.entries(message)) {
    if (typeof value === 'bigint') message[key] = value.toString()
  }
  return {
    domain: {
      chainId,
      name: contracts.HybridDeleGator.constants.NAME,
      version: contracts.HybridDeleGator.constants.DOMAIN_VERSION,
      verifyingContract: accountAddress,
    },
    types: SIGNABLE_USER_OP_TYPED_DATA,
    primaryType: 'PackedUserOperation',
    message,
  }
}

export interface RedemptionSubmitResult {
  txHash: string
  userOpHash: string
  actualGasUsed: bigint
  actualGasCost: bigint
}

export interface DelegationRail {
  delegateAccountAddress: Address
  /**
   * Build the sponsored redemption UserOp for a USDC transfer under the
   * given signed delegation, and the hash the agent signs. Does NOT sign.
   * The caveat stack is exercised during gas estimation, so an out-of-policy
   * redemption fails HERE — before any state is written (the #769 seam).
   */
  prepareRedemption(
    delegation: Delegation,
    token: Address,
    to: Address,
    amount: bigint,
  ): Promise<PreparedRedemption>
  /** Stamp the agent's signature and submit. */
  submitRedemption(prepared: PreparedRedemption, signature: Hex): Promise<RedemptionSubmitResult>
}

export async function createDelegationRail(cfg: DelegationRailConfig): Promise<DelegationRail> {
  getDelegationContracts(cfg.chainId) // fail-closed on unpinned chains
  const chain = chainForId(cfg.chainId)
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) })
  const account = await toMetaMaskSmartAccount({
    client: publicClient as never, // viem type-graph seam (runtime-identical)
    implementation: Implementation.Hybrid,
    deployParams: [cfg.delegateOwnerAddress, [], [], []],
    deploySalt: '0x',
    signer: { account: watchOnlyDelegateOwner(cfg.delegateOwnerAddress) },
  })
  const pimlico = createPimlicoClient({
    transport: http(cfg.bundlerUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  })
  const client = createSmartAccountClient({
    account,
    chain,
    bundlerTransport: http(cfg.bundlerUrl),
    paymaster: pimlico,
    ...(cfg.sponsorshipPolicyId
      ? { paymasterContext: { sponsorshipPolicyId: cfg.sponsorshipPolicyId } }
      : {}),
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  })

  async function prepareRedemption(
    delegation: Delegation,
    token: Address,
    to: Address,
    amount: bigint,
  ): Promise<PreparedRedemption> {
    const execution = createExecution({
      target: token,
      value: 0n,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] }),
    })
    const redeemData = contracts.DelegationManager.encode.redeemDelegations({
      delegations: [[delegation]],
      modes: [ExecutionMode.SingleDefault],
      executions: [[execution]],
    })
    const manager = getDelegationContracts(cfg.chainId).delegationManager
    // The stub signature comes from the account implementation, so gas
    // estimation validates without the backend holding a key.
    const userOperation = await client.prepareUserOperation({
      calls: [{ to: manager, value: 0n, data: redeemData }],
    })
    const userOpHash = getUserOperationHash({
      chainId: cfg.chainId,
      entryPointAddress: entryPoint07Address,
      entryPointVersion: '0.7',
      userOperation: { ...userOperation, sender: account.address },
    })
    return {
      userOperation,
      userOpHash,
      signingTypedData: userOpTypedData(userOperation, account.address, cfg.chainId),
      delegateAccountAddress: account.address,
    }
  }

  async function submitRedemption(
    prepared: PreparedRedemption,
    signature: Hex,
  ): Promise<RedemptionSubmitResult> {
    const userOpHash = await client.sendUserOperation({
      ...prepared.userOperation,
      signature,
    })
    const receipt = await pimlico.waitForUserOperationReceipt({ hash: userOpHash })
    if (!receipt.success) throw new Error('redemption UserOp included but reverted')
    return {
      txHash: receipt.receipt.transactionHash,
      userOpHash,
      actualGasUsed: receipt.actualGasUsed,
      actualGasCost: receipt.actualGasCost,
    }
  }

  return { delegateAccountAddress: account.address, prepareRedemption, submitRedemption }
}

/**
 * Treasury operations (#828): prepare/submit a sponsored UserOp FROM the
 * user's treasury Hybrid — the same watch-only prepare/submit split as
 * redemptions, but the OWNER signs the userOpHash client-side. Used for
 * disableDelegation (revoke) and any future owner-executed account call.
 * The backend still holds no key; sponsorship still cannot move value.
 */
export interface TreasuryOpsConfig {
  /** The treasury account's owner (EOA today; passkey via #833's WebAuthn). */
  ownerAddress: Address
  chainId: number
  bundlerUrl: string
  rpcUrl: string
  sponsorshipPolicyId?: string
}

export interface PreparedTreasuryOp {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userOperation: any
  /** 4337 identifier — NOT what is signed. */
  userOpHash: Hex
  /**
   * What the treasury OWNER actually signs: EIP-712 typed data over the
   * packed UserOperation (domain HybridDeleGator). The account validates
   * exactly this — signing the bare hash reverts in validateUserOp (the
   * #829 lesson; treasury ops share it).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signingTypedData: any
  treasuryAddress: Address
}

export interface TreasuryOps {
  treasuryAddress: Address
  prepareCall(to: Address, data: Hex): Promise<PreparedTreasuryOp>
  submitCall(prepared: PreparedTreasuryOp, signature: Hex): Promise<RedemptionSubmitResult>
}

export async function createTreasuryOps(cfg: TreasuryOpsConfig): Promise<TreasuryOps> {
  getDelegationContracts(cfg.chainId)
  const chain = chainForId(cfg.chainId)
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) })
  const account = await toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    deployParams: [cfg.ownerAddress, [], [], []],
    deploySalt: '0x',
    signer: { account: watchOnlyDelegateOwner(cfg.ownerAddress) },
  })
  const pimlico = createPimlicoClient({
    transport: http(cfg.bundlerUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  })
  const client = createSmartAccountClient({
    account,
    chain,
    bundlerTransport: http(cfg.bundlerUrl),
    paymaster: pimlico,
    ...(cfg.sponsorshipPolicyId
      ? { paymasterContext: { sponsorshipPolicyId: cfg.sponsorshipPolicyId } }
      : {}),
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  })

  async function prepareCall(to: Address, data: Hex): Promise<PreparedTreasuryOp> {
    const userOperation = await client.prepareUserOperation({
      calls: [{ to, value: 0n, data }],
    })
    const userOpHash = getUserOperationHash({
      chainId: cfg.chainId,
      entryPointAddress: entryPoint07Address,
      entryPointVersion: '0.7',
      userOperation: { ...userOperation, sender: account.address },
    })
    return {
      userOperation,
      userOpHash,
      signingTypedData: userOpTypedData(userOperation, account.address, cfg.chainId),
      treasuryAddress: account.address,
    }
  }

  async function submitCall(
    prepared: PreparedTreasuryOp,
    signature: Hex,
  ): Promise<RedemptionSubmitResult> {
    const userOpHash = await client.sendUserOperation({
      ...prepared.userOperation,
      signature,
    })
    const receipt = await pimlico.waitForUserOperationReceipt({ hash: userOpHash })
    if (!receipt.success) throw new Error('treasury UserOp included but reverted')
    return {
      txHash: receipt.receipt.transactionHash,
      userOpHash,
      actualGasUsed: receipt.actualGasUsed,
      actualGasCost: receipt.actualGasCost,
    }
  }

  return { treasuryAddress: account.address, prepareCall, submitCall }
}

/** Convenience mirror of getSessionRailFor — resolves env + pinned config. */
export async function getDelegationRailFor(
  delegateOwnerAddress: Address,
  chainId: number,
): Promise<DelegationRail> {
  return createDelegationRail({
    delegateOwnerAddress,
    chainId,
    bundlerUrl: delegationRailBundlerUrl(chainId),
    rpcUrl: getChain(chainId).rpcUrl,
    sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
  })
}

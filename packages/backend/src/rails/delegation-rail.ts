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

import { http, createPublicClient, zeroAddress, type Address, type Hex, type LocalAccount } from 'viem'
import { toAccount } from 'viem/accounts'
import { entryPoint07Address, toPackedUserOperation, toWebAuthnAccount } from 'viem/account-abstraction'
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
import { getChain } from '../domain/chains.js'

import { getDelegationContracts, DELEGATION_RAIL_CHAIN_IDS, chainForId } from './delegation-contracts.js'

const ERC20_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

/**
 * Bundler endpoint for the delegation rail — env-only SECRET (hosted bundler
 * URLs embed the API key). Falls back to the session rail's credential (same
 * Pimlico account on Base Sepolia); a dedicated var lets ops split vendors
 * per rail later without code changes. Never logged, never persisted.
 * Session rail retired (#834) → this is the single delegation-rail bundler var.
 */
export function delegationRailBundlerUrl(chainId: number): string {
  // The session rail is retired (#834) and both Railway environments migrated
  // to the dedicated var (#882), so the legacy SESSION_RAIL_BUNDLER_URL
  // fallback is gone: this reads DELEGATION_RAIL_BUNDLER_URL only, fail-closed.
  const url = process.env.DELEGATION_RAIL_BUNDLER_URL
  if (!url) {
    throw new Error('DELEGATION_RAIL_BUNDLER_URL is not configured — delegation rail unavailable')
  }
  if (!DELEGATION_RAIL_CHAIN_IDS.has(chainId)) {
    throw new Error(`delegation rail: chain ${chainId} is not enabled`)
  }
  // #1053 review, finding 7: the env var is ONE URL while two chains are
  // enabled, and a Pimlico URL is chain-scoped by its path. Assert the URL
  // names the requested chain so a mismatched env fails at first use with a
  // config error instead of routing a payment at the wrong chain's bundler.
  if (/\/v2\/\d+\//.test(url) && !url.includes(`/v2/${chainId}/`)) {
    throw new Error(
      `DELEGATION_RAIL_BUNDLER_URL targets a different chain than ${chainId} — ` +
        'the credential is chain-scoped; this deployment cannot serve this chain',
    )
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

/**
 * The account's typed data for a prepared UserOperation (see the interface).
 * Exported for #961: an idempotent replay of a pending funding intent
 * reconstructs the exact signing payload from the STORED UserOperation
 * instead of re-running a sponsored estimation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function userOpTypedData(userOperation: any, accountAddress: Address, chainId: number): any {
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
export interface TreasuryPasskey {
  keyId: string
  x: bigint
  y: bigint
}

export interface TreasuryOpsConfig {
  /** EOA owner — omit for a pure-passkey account (provide `passkeys`). */
  ownerAddress?: Address
  /** P256 signer set for a pure-passkey account (#885). */
  passkeys?: TreasuryPasskey[]
  /**
   * The account's DEPLOYED address (#891 fix). Treasury ops only exist after
   * the account is deployed (the grant deploys it, #860), and the signer set
   * can have EVOLVED since provisioning (addKey/removeKey, #888) — deriving
   * the address from the CURRENT set would derive a different, wrong account.
   * With the address pinned, deployParams play no role in ops.
   */
  accountAddress?: Address
  chainId: number
  bundlerUrl: string
  rpcUrl: string
  sponsorshipPolicyId?: string
  /**
   * Which of the account's signers the CLIENT intends to sign with. A Hybrid
   * account with both an EOA owner and passkeys accepts either on-chain, and
   * the choice is the client's — only the device knows what is available
   * (the multi-signer lesson: "has an owner" is not "must sign as the owner").
   * It also shapes gas estimation: WebAuthn signatures are longer than EOA
   * ones, so the dummy signature must match what will actually be submitted.
   * Omitted: the legacy inference (owner if present, else passkey).
   */
  signWith?: 'owner' | 'passkey'
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
  const passkeys = cfg.passkeys ?? []
  if (cfg.signWith === 'passkey' && passkeys.length === 0) {
    throw new Error('treasury ops: signWith=passkey but the account has no passkeys')
  }
  if (cfg.signWith === 'owner' && !cfg.ownerAddress) {
    throw new Error('treasury ops: signWith=owner but the account has no EOA owner')
  }
  const isPasskey = cfg.signWith
    ? cfg.signWith === 'passkey'
    : !cfg.ownerAddress && passkeys.length > 0
  if (!cfg.ownerAddress && !isPasskey) {
    throw new Error('treasury ops: an EOA owner or at least one passkey is required')
  }
  // Passkey accounts sign the userOpHash via WebAuthn (#887); the prepare here
  // never signs, so the WebAuthn signer's getFn is a stub that must not be
  // called server-side. EOA accounts keep the watch-only owner-signer.
  //
  // Address pinned when the account is DEPLOYED (#891: the signer set can
  // have evolved since provisioning, so deriving would find the wrong
  // account). A COUNTERFACTUAL account is the one case where deriving from
  // the stored set is CORRECT — nothing on-chain can have diverged, because
  // every signer change requires a deployed account op — and it is also
  // REQUIRED: the kit cannot build a UserOperation for an undeployed account
  // without deployParams (initCode). This is what lets a zero-agent account
  // enrol its backup signer (#1089): deploy + addKey ride the same sponsored
  // op. The derived address is checked against the pin below, so set drift
  // still refuses instead of targeting a different account.
  const fullDeployParams = [
    cfg.ownerAddress ?? zeroAddress,
    passkeys.map((p) => p.keyId),
    passkeys.map((p) => p.x),
    passkeys.map((p) => p.y),
  ] as const
  const pinnedCode = cfg.accountAddress
    ? await publicClient.getCode({ address: cfg.accountAddress }).catch(() => undefined)
    : undefined
  const pinnedDeployed = !!pinnedCode && pinnedCode !== '0x'
  const location =
    cfg.accountAddress && pinnedDeployed
      ? ({ address: cfg.accountAddress } as const)
      : ({ deployParams: fullDeployParams, deploySalt: '0x' } as const)
  const signerConfig = isPasskey
    ? {
        webAuthnAccount: toWebAuthnAccount({
          credential: {
            id: passkeys[0].keyId,
            publicKey: `0x04${passkeys[0].x.toString(16).padStart(64, '0')}${passkeys[0].y
              .toString(16)
              .padStart(64, '0')}` as Hex,
          },
          getFn: async () => {
            throw new Error('non-custody: treasury prepare is watch-only and cannot sign')
          },
        }),
        keyId: passkeys[0].keyId as Hex,
      }
    : { account: watchOnlyDelegateOwner(cfg.ownerAddress as Address) }
  const account = await toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    ...location,
    signer: signerConfig,
  } as never)
  // The counterfactual branch derives — refuse a derivation that does not
  // land on the stored address (the #891 mismatch class: acting on a
  // DIFFERENT account than the one the user owns must be impossible).
  if (
    cfg.accountAddress &&
    !pinnedDeployed &&
    account.address.toLowerCase() !== cfg.accountAddress.toLowerCase()
  ) {
    throw new Error(
      'treasury ops: the stored signer set does not derive the stored account address — refusing to act on a different account',
    )
  }
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

/** Resolves env + pinned config for the delegation rail (the old getSessionRailFor mirror comment predated the #834 retirement). */
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

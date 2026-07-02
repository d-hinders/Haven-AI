/**
 * Session-key payment rail — backend UserOp construction + bundler submit
 * (foundation #739, slice #742). Backend port of the pilot's `session-rail.ts`,
 * split per the #737 decision into **prepare** (backend builds the UserOp and
 * computes the hash) and **submit** (backend wraps the client's signature and
 * sends it to the bundler). The agent's session key signs the hash client-side
 * via `@haven_ai/sdk`'s `signUserOpHashForSession` (EIP-191, #741).
 *
 * Non-custody: the backend holds NO key. The Safe "owner" used for account
 * derivation is a signer-less {@link watchOnlyOwner}; session UserOps are
 * authorized by the Smart Sessions validator, never by an owner signature.
 *
 * Nothing routes to this yet — the payment flow is wired to it in the routing
 * slice (#745), where the full live E2E (bundler + funded account) is verified.
 * The pure construction pieces below are unit-tested offline; the network
 * orchestration mirrors the pilot run that already landed sponsored session
 * UserOps on Base Sepolia (#722/#723).
 */

import {
  http,
  createPublicClient,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
} from 'viem'
import { toAccount } from 'viem/accounts'
import { base, baseSepolia, gnosis } from 'viem/chains'
import { entryPoint07Address, getUserOperationHash } from 'viem/account-abstraction'
import { createSmartAccountClient } from 'permissionless'
import { toSafeSmartAccount } from 'permissionless/accounts'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { getAccountNonce } from 'permissionless/actions'
import {
  SMART_SESSIONS_ADDRESS,
  encodeSmartSessionSignature,
  encodeValidatorNonce,
  getAccount,
  getOwnableValidatorMockSignature,
} from '@rhinestone/module-sdk'
import { SmartSessionMode } from './session-policies.js'

export const ERC20_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

// Base-first. Gnosis is listed but the rail waits on its own v1.3.0 + Safe7579
// verification run (#733) before any Gnosis account migrates.
const CHAINS: Record<number, Chain> = { 8453: base, 84532: baseSepolia, 100: gnosis }

export function chainForId(chainId: number): Chain {
  const chain = CHAINS[chainId]
  if (!chain) {
    throw new Error(`session rail: unsupported chainId ${chainId}`)
  }
  return chain
}

/** Inner calldata for a USDC (ERC-20) transfer. */
export function encodeUsdcTransferCall(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] })
}

/** Wrap a session-key signature for the Smart Sessions USE mode. */
export function wrapSessionSignature(permissionId: Hex, signature: Hex): Hex {
  return encodeSmartSessionSignature({ mode: SmartSessionMode.USE, permissionId, signature })
}

/**
 * A signer-less "owner" used only to derive the Safe account object. Session
 * UserOps are authorized by the Smart Sessions validator, never by an owner
 * signature, so the backend holds NO owner key — non-custody preserved. Any
 * attempt to sign as the owner throws, so a stray owner-signing path fails
 * loudly instead of silently expecting a key the backend must never have.
 */
export function watchOnlyOwner(address: Address): LocalAccount {
  const refuse = async (): Promise<never> => {
    throw new Error('non-custody: the backend cannot sign as the Safe owner')
  }
  return toAccount({
    address,
    signMessage: refuse,
    signTransaction: refuse,
    signTypedData: refuse,
  }) as LocalAccount
}

export interface SessionRailConfig {
  safeAddress: Address
  /** The Safe owner address — signer-less here (see watchOnlyOwner). */
  ownerAddress: Address
  /** Secret: hosted bundlers embed the API key. Env-only, never logged. */
  bundlerUrl: string
  rpcUrl: string
  chainId: number
  safe7579AdapterAddress: Address
  erc7579LaunchpadAddress: Address
}

export interface PreparedSessionTransfer {
  /** The prepared UserOp (carries a mock session signature for gas estimation). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userOperation: any
  /** The hash the agent's session key signs client-side (via #741). */
  userOpHash: Hex
}

export interface SessionSubmitResult {
  txHash: string
  userOpHash: string
  actualGasUsed: bigint
  actualGasCost: bigint
}

export interface SessionRail {
  /** Next free 2D nonce for the Smart Sessions validator key. */
  getSessionNonce(): Promise<bigint>
  /**
   * Build the UserOp for a USDC transfer and compute the hash the session key
   * must sign. Does NOT sign — the caller signs `userOpHash` with the agent's
   * session key (EIP-191) and passes the signature to {@link submitSessionTransfer}.
   */
  prepareSessionTransfer(
    permissionId: Hex,
    usdc: Address,
    to: Address,
    amount: bigint,
  ): Promise<PreparedSessionTransfer>
  /** Wrap the client's session signature and submit to the bundler. */
  submitSessionTransfer(
    prepared: PreparedSessionTransfer,
    permissionId: Hex,
    sessionSignature: Hex,
  ): Promise<SessionSubmitResult>
}

export async function createSessionRail(cfg: SessionRailConfig): Promise<SessionRail> {
  const chain = chainForId(cfg.chainId)
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) })
  const account = await toSafeSmartAccount({
    client: publicClient,
    address: cfg.safeAddress,
    owners: [watchOnlyOwner(cfg.ownerAddress)],
    version: '1.4.1',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    safe4337ModuleAddress: cfg.safe7579AdapterAddress,
    erc7579LaunchpadAddress: cfg.erc7579LaunchpadAddress,
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
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  })

  async function getSessionNonce(): Promise<bigint> {
    return getAccountNonce(publicClient, {
      address: cfg.safeAddress,
      entryPointAddress: entryPoint07Address,
      key: encodeValidatorNonce({
        account: getAccount({ address: cfg.safeAddress, type: 'safe' }),
        validator: SMART_SESSIONS_ADDRESS,
      }),
    })
  }

  async function prepareSessionTransfer(
    permissionId: Hex,
    usdc: Address,
    to: Address,
    amount: bigint,
  ): Promise<PreparedSessionTransfer> {
    const nonce = await getSessionNonce()
    const userOperation = await client.prepareUserOperation({
      calls: [{ to: usdc, value: 0n, data: encodeUsdcTransferCall(to, amount) }],
      nonce,
      // Mock session signature so gas estimation validates; the real signature
      // is stamped in submit after the client signs the returned hash.
      signature: wrapSessionSignature(permissionId, getOwnableValidatorMockSignature({ threshold: 1 })),
    })
    const userOpHash = getUserOperationHash({
      chainId: cfg.chainId,
      entryPointAddress: entryPoint07Address,
      entryPointVersion: '0.7',
      userOperation: { ...userOperation, sender: cfg.safeAddress },
    })
    return { userOperation, userOpHash }
  }

  async function submitSessionTransfer(
    prepared: PreparedSessionTransfer,
    permissionId: Hex,
    sessionSignature: Hex,
  ): Promise<SessionSubmitResult> {
    const userOperation = {
      ...prepared.userOperation,
      signature: wrapSessionSignature(permissionId, sessionSignature),
    }
    const userOpHash = await client.sendUserOperation(userOperation)
    const receipt = await pimlico.waitForUserOperationReceipt({ hash: userOpHash })
    if (!receipt.success) throw new Error('session UserOp included but reverted')
    return {
      txHash: receipt.receipt.transactionHash,
      userOpHash,
      actualGasUsed: receipt.actualGasUsed,
      actualGasCost: receipt.actualGasCost,
    }
  }

  return { getSessionNonce, prepareSessionTransfer, submitSessionTransfer }
}

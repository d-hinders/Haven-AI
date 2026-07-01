/**
 * Session-rail plumbing shared by the #722 policy suite and the #723 rail
 * comparison: send USDC transfers from the provisioned pilot Safe as
 * session-key UserOps (bundler submits, paymaster sponsors gas), and report
 * timing + gas per operation.
 *
 * Manual nonce support exists for the #718 concurrency probe: 4337 2D nonces
 * share a sequence per validator key, so three simultaneous ops must carry
 * consecutive nonces assigned up front — the bundler can then include all
 * three (potentially in one bundle), which is exactly what the single-EOA
 * relayer rail cannot do today.
 */

import {
  http,
  createPublicClient,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
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

const CHAIN_ID = 84532
export const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address
export const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])

export interface SessionRailConfig {
  safeAddress: `0x${string}`
  ownerPrivateKey: `0x${string}`
  sessionPrivateKey: `0x${string}`
  bundlerUrl: string
  rpcUrl: string
  safe7579AdapterAddress: `0x${string}`
  erc7579LaunchpadAddress: `0x${string}`
}

export interface SessionTransferResult {
  txHash: string
  userOpHash: string
  latencyMs: number
  actualGasUsed: bigint
  actualGasCost: bigint
}

export interface SessionRail {
  /**
   * Narrow structural view of the viem public client — a full `PublicClient`
   * annotation collides across the hoisted viem copies (qa-agent vs
   * module-sdk), so we expose only what the pilot scripts use.
   */
  publicClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract(args: any): Promise<unknown>
  }
  /** Next free 2D nonce for the Smart Sessions validator key. */
  getSessionNonce(): Promise<bigint>
  /** Send one policy-bound USDC transfer; nonce fetched automatically. */
  sendTransfer(permissionId: Hex, to: Address, amount: bigint): Promise<SessionTransferResult>
  /**
   * Same, with a caller-assigned nonce (concurrency probe). Pass the current
   * on-chain nonce as `estimationNonce` when `nonce` lies in the future.
   */
  sendTransferWithNonce(
    permissionId: Hex,
    to: Address,
    amount: bigint,
    nonce: bigint,
    estimationNonce?: bigint,
  ): Promise<SessionTransferResult>
}

export async function createSessionRail(cfg: SessionRailConfig): Promise<SessionRail> {
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(cfg.rpcUrl) })
  const sessionKey = privateKeyToAccount(cfg.sessionPrivateKey)
  const account = await toSafeSmartAccount({
    client: publicClient,
    address: cfg.safeAddress,
    owners: [privateKeyToAccount(cfg.ownerPrivateKey)],
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
    chain: baseSepolia,
    bundlerTransport: http(cfg.bundlerUrl),
    paymaster: pimlico,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  })

  const sessionSig = (permissionId: Hex, signature: Hex): Hex =>
    encodeSmartSessionSignature({ mode: SmartSessionMode.USE, permissionId, signature })

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

  async function sendTransferWithNonce(
    permissionId: Hex,
    to: Address,
    amount: bigint,
    nonce: bigint,
    estimationNonce?: bigint,
  ): Promise<SessionTransferResult> {
    const startedAt = Date.now()
    // Gas estimation simulates against current chain state, so a FUTURE nonce
    // (concurrency probe: base+1, base+2) reverts AA25 during estimation.
    // Estimate with the currently-valid nonce, then stamp the assigned one
    // before hashing/signing — the gas profile is identical (same call).
    const userOperation = await client.prepareUserOperation({
      calls: [
        {
          to: SEPOLIA_USDC,
          value: 0n,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] }),
        },
      ],
      nonce: estimationNonce ?? nonce,
      signature: sessionSig(permissionId, getOwnableValidatorMockSignature({ threshold: 1 })),
    })
    userOperation.nonce = nonce
    const hash = getUserOperationHash({
      chainId: CHAIN_ID,
      entryPointAddress: entryPoint07Address,
      entryPointVersion: '0.7',
      userOperation: { ...userOperation, sender: cfg.safeAddress },
    })
    userOperation.signature = sessionSig(permissionId, await sessionKey.sign({ hash }))
    const userOpHash = await client.sendUserOperation(userOperation)
    const receipt = await pimlico.waitForUserOperationReceipt({ hash: userOpHash })
    if (!receipt.success) throw new Error('UserOp included but reverted')
    return {
      txHash: receipt.receipt.transactionHash,
      userOpHash,
      latencyMs: Date.now() - startedAt,
      actualGasUsed: receipt.actualGasUsed,
      actualGasCost: receipt.actualGasCost,
    }
  }

  return {
    publicClient,
    getSessionNonce,
    sendTransfer: async (permissionId: Hex, to: Address, amount: bigint) =>
      sendTransferWithNonce(permissionId, to, amount, await getSessionNonce()),
    sendTransferWithNonce,
  }
}

/**
 * Pure helpers for #721: upgrade an EXISTING vanilla Safe to ERC-7579 with ONE
 * owner transaction. This is the ADR #719 Stage 2 migration recipe, extracted
 * so the batch construction is unit-testable without a network.
 *
 * The one owner tx is a MultiSendCallOnly batch (delegatecalled by the Safe, so
 * every inner call runs with msg.sender = the Safe):
 *   1. safe.enableModule(safe7579)        — adapter may execute via module path
 *   2. safe.setFallbackHandler(safe7579)  — EntryPoint/7579 calls route to it
 *   3. safe7579.initializeAccount(...)    — wires validators + ERC-7484 registry
 *
 * ⚠️ ABI pinned to the DEPLOYED adapter (safe7579 tag v1.0.2 — verified against
 * the tagged source). The repo's main branch has diverged (single ModuleInit[]
 * with a moduleType field); do NOT "upgrade" this ABI without confirming what
 * the canonical adapter address actually runs.
 */

import { ethers } from 'ethers'

/** Base Sepolia (84532) Safe v1.4.1 deployments — mirrors backend lib/chains.ts. */
export const SEPOLIA_SAFE_CONTRACTS = {
  safeProxyFactory: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC',
  safeSingletonL2: '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
  compatibilityFallbackHandler: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804',
  multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
} as const

export const SAFE_ABI = [
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function enableModule(address module)',
  'function setFallbackHandler(address handler)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function nonce() view returns (uint256)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
] as const

export const SAFE_PROXY_FACTORY_ABI = [
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address proxy, address singleton)', // NOT indexed on the deployed factory (empirically 1 topic; matches backend safe-deployer.ts)
] as const

// Deployed safe7579 v1.0.2 interface (5-array initializeAccount, 2-field ModuleInit).
export const SAFE7579_ABI = [
  'function initializeAccount((address module, bytes initData)[] validators, (address module, bytes initData)[] executors, (address module, bytes initData)[] fallbacks, (address module, bytes initData)[] hooks, (address registry, address[] attesters, uint8 threshold) registryInit)',
] as const

// ERC-7579 surface the Safe exposes once the adapter is its fallback handler.
export const ERC7579_ACCOUNT_ABI = [
  'function accountId() view returns (string)',
  'function isModuleInstalled(uint256 moduleTypeId, address module, bytes additionalContext) view returns (bool)',
] as const

export const MULTI_SEND_ABI = ['function multiSend(bytes transactions) payable'] as const

export const ERC7579_MODULE_TYPE_VALIDATOR = 1n

export interface InnerTx {
  to: string
  value: bigint
  data: string
  /** 0 = CALL. MultiSendCallOnly rejects delegatecalls, so this is always 0 here. */
  operation: 0
}

/**
 * Pack inner txs into MultiSend's byte layout:
 * operation (1) ++ to (20) ++ value (32) ++ data.length (32) ++ data.
 */
export function encodeMultiSendTransactions(txs: readonly InnerTx[]): string {
  const packed = txs.map((tx) =>
    ethers.solidityPacked(
      ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
      [tx.operation, tx.to, tx.value, ethers.dataLength(tx.data), tx.data],
    ),
  )
  return ethers.concat(packed)
}

export interface ProvisionBatchArgs {
  safeAddress: string
  safe7579Adapter: string
  smartSessionsValidator: string
  registry: string
  attester: string
}

/**
 * The three inner calls of the migration batch, in dependency order: the
 * adapter must be an enabled module before initializeAccount runs (module
 * installs execute through the Safe's module path).
 */
export function buildProvisionBatch(args: ProvisionBatchArgs): InnerTx[] {
  const safe = new ethers.Interface(SAFE_ABI)
  const adapter = new ethers.Interface(SAFE7579_ABI)
  return [
    {
      to: args.safeAddress,
      value: 0n,
      data: safe.encodeFunctionData('enableModule', [args.safe7579Adapter]),
      operation: 0,
    },
    {
      to: args.safeAddress,
      value: 0n,
      data: safe.encodeFunctionData('setFallbackHandler', [args.safe7579Adapter]),
      operation: 0,
    },
    {
      to: args.safe7579Adapter,
      value: 0n,
      data: adapter.encodeFunctionData('initializeAccount', [
        // validators: Smart Sessions installed with no initial sessions (#722 adds them)
        [{ module: args.smartSessionsValidator, initData: '0x' }],
        [], // executors
        [], // fallbacks
        [], // hooks
        { registry: args.registry, attesters: [args.attester], threshold: 1 },
      ]),
      operation: 0,
    },
  ]
}

/**
 * Sign (EIP-712) and submit one owner execTransaction on a threshold-1 Safe.
 * The owner EOA pays gas — the customer-side path, no relayer or bundler.
 */
export async function execSafeTransactionAsOwner(
  safe: ethers.Contract,
  owner: ethers.Wallet,
  args: { chainId: number; to: string; data: string; operation: 0 | 1 },
): Promise<ethers.TransactionReceipt> {
  const nonce: bigint = await safe.nonce()
  const typed = safeTxTypedData({
    chainId: args.chainId,
    safeAddress: await safe.getAddress(),
    to: args.to,
    data: args.data,
    operation: args.operation,
    nonce,
  })
  const signature = await owner.signTypedData(typed.domain, typed.types, typed.message)
  const tx = await safe.execTransaction(
    args.to, 0n, args.data, args.operation, 0n, 0n, 0n,
    ethers.ZeroAddress, ethers.ZeroAddress, signature,
  )
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) throw new Error('execTransaction reverted')
  return receipt
}

/** EIP-712 payload for a Safe v1.4.1 transaction (chainId in the domain). */
export function safeTxTypedData(args: {
  chainId: number
  safeAddress: string
  to: string
  data: string
  operation: 0 | 1
  nonce: bigint
}) {
  return {
    domain: { chainId: args.chainId, verifyingContract: args.safeAddress },
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    message: {
      to: args.to,
      value: 0n,
      data: args.data,
      operation: args.operation,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
      nonce: args.nonce,
    },
  }
}

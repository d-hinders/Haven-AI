import {
  encodeFunctionData,
  hashTypedData,
  parseUnits,
  WaitForTransactionReceiptTimeoutError,
  ContractFunctionRevertedError,
  ContractFunctionExecutionError,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem'
import { getChainConfig, DEFAULT_CHAIN_ID } from './chains'
import { api } from './api'
import { signSafeHashWithPasskey } from './passkey-sign'
import type { HavenUserSigner } from './signer'

// ── Constants ────────────────────────────────────────────────────────
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/**
 * Thrown when a submitted Safe tx does not produce a receipt within the timeout.
 * The tx may still confirm later, so `txHash` is carried for the UI to surface a
 * block-explorer link and to retry the *backend* save without re-running the
 * on-chain batch. `instanceof Error` and the message stay intact for callers
 * that still match on text.
 */
export class SafeTxReceiptTimeoutError extends Error {
  readonly txHash: Hash
  constructor(txHash: Hash) {
    super(
      `Transaction submitted but not yet confirmed after 2 minutes. ` +
        `It may still land — check the block explorer for ${txHash}`,
    )
    this.name = 'SafeTxReceiptTimeoutError'
    this.txHash = txHash
  }
}

// ERC-20 transfer ABI
const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

// Safe v1.3.0 execTransaction ABI
const SAFE_EXEC_ABI = [
  {
    name: 'execTransaction',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const

// Safe nonce() ABI
const SAFE_NONCE_ABI = [
  {
    name: 'nonce',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// EIP-712 domain and types for Safe transaction signing
const SAFE_TX_TYPEHASH = {
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
} as const

// ── Types ────────────────────────────────────────────────────────────
export interface SafeTxParams {
  to: Address
  value: bigint
  data: `0x${string}`
  operation: 0 | 1 // 0 = Call, 1 = DelegateCall
  safeTxGas: bigint
  baseGas: bigint
  gasPrice: bigint
  gasToken: Address
  refundReceiver: Address
  nonce: bigint
}

export interface SendParams {
  token: string
  tokenAddress: Address | null  // null = native
  decimals: number
  amount: string               // human-readable (e.g. "10.5")
  recipient: Address
}

// ── Token config (Gnosis Chain — kept for backwards compat) ──────────
export const TOKENS: Record<string, { address: Address | null; decimals: number }> = {
  'xDAI': { address: null, decimals: 18 },
  'EURe': { address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E' as Address, decimals: 18 },
  'USDC.e': { address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0' as Address, decimals: 6 },
}

/** Get token config map for a specific chain (address -> symbol, decimals). */
export function getChainTokens(chainId: number): Record<string, { address: Address | null; decimals: number }> {
  const tokens = getChainConfig(chainId).tokens
  const result: Record<string, { address: Address | null; decimals: number }> = {}
  for (const [key, cfg] of Object.entries(tokens)) {
    result[key] = { address: cfg.address as Address | null, decimals: cfg.decimals }
  }
  return result
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Read the current nonce from the Safe contract on-chain */
export async function getSafeNonce(
  publicClient: PublicClient,
  safeAddress: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: safeAddress,
    abi: SAFE_NONCE_ABI,
    functionName: 'nonce',
  }) as Promise<bigint>
}

/** Build Safe transaction params for a token transfer */
export function buildSafeTx(
  send: SendParams,
  nonce: bigint,
): SafeTxParams {
  const rawAmount = parseUnits(send.amount, send.decimals)

  if (send.tokenAddress) {
    // ERC-20 transfer: call the token contract
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [send.recipient, rawAmount],
    })
    return {
      to: send.tokenAddress,
      value: 0n,
      data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce,
    }
  }

  // Native xDAI transfer
  return {
    to: send.recipient,
    value: rawAmount,
    data: '0x',
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  }
}

/** Sign the Safe transaction using EIP-712 typed data */
export function getSafeTxHash(
  safeAddress: Address,
  tx: SafeTxParams,
  chainId: number = DEFAULT_CHAIN_ID,
): `0x${string}` {
  return hashTypedData({
    domain: {
      chainId,
      verifyingContract: safeAddress,
    },
    types: SAFE_TX_TYPEHASH,
    primaryType: 'SafeTx',
    message: {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas,
      baseGas: tx.baseGas,
      gasPrice: tx.gasPrice,
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: tx.nonce,
    },
  })
}

/** Sign the Safe transaction using either an EOA or passkey-backed contract signer. */
export async function signSafeTx(
  signer: HavenUserSigner,
  safeAddress: Address,
  tx: SafeTxParams,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<`0x${string}`> {
  if (signer.type === 'eoa') {
    return signer.walletClient.signTypedData({
      account: signer.address,
      domain: {
        chainId,
        verifyingContract: safeAddress,
      },
      types: SAFE_TX_TYPEHASH,
      primaryType: 'SafeTx',
      message: {
        to: tx.to,
        value: tx.value,
        data: tx.data,
        operation: tx.operation,
        safeTxGas: tx.safeTxGas,
        baseGas: tx.baseGas,
        gasPrice: tx.gasPrice,
        gasToken: tx.gasToken,
        refundReceiver: tx.refundReceiver,
        nonce: tx.nonce,
      },
    })
  }

  const safeTxHash = getSafeTxHash(safeAddress, tx, chainId)
  const result = await signSafeHashWithPasskey({ signer, safeTxHash })
  return result.signature
}

/**
 * Normalise the signature v value to 27/28.
 *
 * Safe v1.3.0 checkSignatures interprets v values as:
 *   v = 0, 1   → contract signature (special encoding)
 *   v = 27, 28 → ECDSA signature verified with ecrecover(hash, v, r, s)
 *   v = 31, 32 → eth_sign signature (wraps hash with "\x19Ethereum..." prefix)
 *
 * Since we use signTypedData (EIP-712), the wallet signs the raw hash.
 * Safe should verify it with plain ecrecover → v must be 27 or 28.
 *
 * Some wallets return v as 0/1 instead of 27/28, so we normalise.
 */
function normaliseSignatureV(sig: `0x${string}`): `0x${string}` {
  const raw = sig.slice(2)
  if (raw.length !== 130) {
    return sig
  }

  const v = parseInt(raw.slice(128, 130), 16)

  // Normalise: raw 0/1 → 27/28
  if (v === 0 || v === 1) {
    const adjusted = (v + 27).toString(16).padStart(2, '0')
    return `0x${raw.slice(0, 128)}${adjusted}` as `0x${string}`
  }

  return sig
}

/** Execute the Safe transaction on-chain (threshold = 1) */
export async function executeSafeTx(
  signer: HavenUserSigner,
  publicClient: PublicClient,
  safeAddress: Address,
  tx: SafeTxParams,
  signature: `0x${string}`,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<{ txHash: Hash }> {
  if (signer.type === 'eoa') {
    const adjustedSig = normaliseSignatureV(signature)
    const { viemChain } = getChainConfig(chainId)

    const execArgs = [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      adjustedSig,
    ] as const

    // Pre-flight simulation — catch reverts BEFORE MetaMask shows the
    // confirmation prompt. Without this, a reverted tx causes MetaMask to
    // display "Your transaction was canceled" while `writeContract` keeps its
    // promise pending until the user dismisses the popup, freezing the UI.
    try {
      await publicClient.simulateContract({
        address: safeAddress,
        abi: SAFE_EXEC_ABI,
        functionName: 'execTransaction',
        args: execArgs,
        account: signer.address,
      })
    } catch (err) {
      // Case 1: direct revert from simulateContract
      if (err instanceof ContractFunctionRevertedError) {
        const reason = err.data?.errorName ?? err.shortMessage ?? 'unknown revert'
        throw new Error(
          `Transaction would revert on-chain: ${reason}. ` +
            `Check that the Safe has the AllowanceModule enabled and the delegate address is valid.`,
        )
      }
      // Case 2: viem wraps the revert inside ContractFunctionExecutionError
      if (
        err instanceof ContractFunctionExecutionError &&
        err.cause instanceof ContractFunctionRevertedError
      ) {
        const reason = err.cause.data?.errorName ?? err.cause.shortMessage ?? 'unknown revert'
        throw new Error(
          `Transaction would revert on-chain: ${reason}. ` +
            `Check that the Safe has the AllowanceModule enabled and the delegate address is valid.`,
        )
      }
      // Case 3: network / RPC failure — replace raw viem internals with a
      // human-readable message so the modal never shows "RPC Request failed."
      const raw = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Could not verify the transaction — network or RPC error. ` +
          `Check your connection and try again. (${raw})`,
      )
    }

    const txHash = await signer.walletClient.writeContract({
      address: safeAddress,
      abi: SAFE_EXEC_ABI,
      functionName: 'execTransaction',
      args: execArgs,
      chain: viemChain,
      account: signer.address,
    })

    // Wait up to 120 s for the receipt. If the chain is congested or gas was
    // underpriced the tx may still land — throw a user-friendly error that
    // includes the hash so the UI can surface a block-explorer link.
    try {
      await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) {
        // The tx was broadcast and may still land. Throw a typed error carrying
        // the hash so callers can route to "finish saving" instead of re-running
        // the on-chain batch (which would double-apply or collide on the nonce).
        throw new SafeTxReceiptTimeoutError(txHash)
      }
      throw err
    }

    return { txHash }
  }

  const result = await api.execSafe({
    chain_id: chainId,
    safe_address: safeAddress,
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    operation: tx.operation,
    safe_tx_gas: tx.safeTxGas.toString(),
    base_gas: tx.baseGas.toString(),
    gas_price: tx.gasPrice.toString(),
    gas_token: tx.gasToken,
    refund_receiver: tx.refundReceiver,
    nonce: tx.nonce.toString(),
    signatures: signature,
  })

  return { txHash: result.tx_hash as Hash }
}

/** Propose a multi-sig transaction to the Safe Transaction Service */
export async function proposeSafeTx(
  safeAddress: Address,
  tx: SafeTxParams,
  safeTxHash: string,
  signature: `0x${string}`,
  sender: Address,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<void> {
  const adjustedSig = normaliseSignatureV(signature)
  const { safeTxServiceUrl } = getChainConfig(chainId)
  const url = `${safeTxServiceUrl}/api/v1/safes/${safeAddress}/multisig-transactions/`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas.toString(),
      baseGas: tx.baseGas.toString(),
      gasPrice: tx.gasPrice.toString(),
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      // Send as a string: the Safe Tx Service hashes the exact uint256 nonce
      // into contractTransactionHash, so Number() truncation on a high-nonce
      // Safe (> 2^53) would post a nonce that disagrees with the hash → 422.
      nonce: tx.nonce.toString(),
      contractTransactionHash: safeTxHash,
      sender,
      signature: adjustedSig,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Safe Transaction Service error: ${body}`)
  }
}

import {
  encodeFunctionData,
  parseUnits,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { gnosis } from 'viem/chains'

// ── Constants ────────────────────────────────────────────────────────
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

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
  token: 'xDAI' | 'EURe' | 'USDC.e'
  tokenAddress: Address | null  // null = native
  decimals: number
  amount: string               // human-readable (e.g. "10.5")
  recipient: Address
}

// ── Token config (mirrors backend) ───────────────────────────────────
export const TOKENS: Record<string, { address: Address | null; decimals: number }> = {
  'xDAI': { address: null, decimals: 18 },
  'EURe': { address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E' as Address, decimals: 18 },
  'USDC.e': { address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0' as Address, decimals: 6 },
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
export async function signSafeTx(
  walletClient: WalletClient,
  safeAddress: Address,
  tx: SafeTxParams,
  signer: Address,
): Promise<`0x${string}`> {
  return walletClient.signTypedData({
    account: signer,
    domain: {
      chainId: gnosis.id,
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
  walletClient: WalletClient,
  publicClient: PublicClient,
  safeAddress: Address,
  tx: SafeTxParams,
  signature: `0x${string}`,
  sender: Address,
): Promise<{ txHash: Hash }> {
  const adjustedSig = normaliseSignatureV(signature)

  const txHash = await walletClient.writeContract({
    address: safeAddress,
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args: [
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
    ],
    chain: gnosis,
    account: sender,
  })

  // Wait for confirmation
  await publicClient.waitForTransactionReceipt({ hash: txHash })

  return { txHash }
}

/** Propose a multi-sig transaction to the Safe Transaction Service */
export async function proposeSafeTx(
  safeAddress: Address,
  tx: SafeTxParams,
  safeTxHash: string,
  signature: `0x${string}`,
  sender: Address,
): Promise<void> {
  const adjustedSig = normaliseSignatureV(signature)

  const url = `https://safe-transaction-gnosis-chain.safe.global/api/v1/safes/${safeAddress}/multisig-transactions/`

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
      nonce: Number(tx.nonce),
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

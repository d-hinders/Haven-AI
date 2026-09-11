/**
 * Safe transaction construction and signing.
 *
 * ⚠️ **This file SURVIVED the Safe-rail retirement (#1989, epic #1440) on
 * purpose — do not delete it as "the safe-tx libs".** Same shape as the
 * backend's `rails/allowance-module.ts`, which #1987 likewise trimmed to its
 * shared half rather than deleting: the file's execution half died with the
 * rail, its shared half has consumers that must live.
 *
 * DELETED here with their callers: `buildSafeTx`, the `SendParams` type, the
 * ERC-20 transfer ABI and the Gnosis `TOKENS` map. Their only consumers were
 * `SendModal` / `useSendTransaction` / `ApprovalQueue`.
 *
 * #2847 deleted `executeSafeTx` with its backend: the relayed
 * `POST /safe/exec` leg and the `SAFE_EXEC_ABI` write-contract shape went
 * with it (the direct-signing half had no production caller either — the
 * route was the client). What remains of the execution half is the
 * Transaction-Service proposal.
 *
 * KEPT, with the consumer that requires each:
 *
 *  - `getChainTokens` — a generic per-chain token list, and the one export a
 *    DELEGATION-rail surface reads: `DelegationSendModal`,
 *    `useAgentConnectionSetup`, `agent-panel/agent-display` (and
 *    `EditAgentModal`). Nothing about it is AllowanceModule code.
 *  - `getSafeNonce` / `getSafeTxHash` / `signSafeTx` / `proposeSafeTx` /
 *    `SafeTxParams` / `SafeTxReceiptTimeoutError` — owner-signed Safe
 *    construction and signing helpers retained for slices 2–4 of this
 *    retirement (#2848 takes the rest). No dashboard surface calls them.
 *
 * The #1229 approver-recovery consumer (`lib/approver-tx.ts`) is NOT in that
 * list any more: #1988 deleted all five `/user/safes/:id/approvers*` routes,
 * so the builder had no backend left and this slice deleted it. That removed
 * Haven's only offered way to add a backup owner to a legacy Safe. It is a
 * deliberate, owner-approved narrowing with a stated residual limit — see
 * #1988's PR (#2009) boundary section — not something to reverse from here.
 */
import type { SafeCapableSigner } from './signer'
import {
  hashTypedData,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem'
import { getChainConfig, DEFAULT_CHAIN_ID } from './chains'
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
  // #1079: the type says what the union cannot — a delegator_passkey never
  // signs a Safe transaction; callers narrow via isSafeCapableSigner.
  signer: SafeCapableSigner,
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

/**
 * The Safe Transaction Service base URL per chain, inlined locally since
 * #2849 (safe-retirement slice 3) dropped the service URL field from the
 * shared chain registry — history no longer reads the service, and this
 * helper is its only remaining consumer. #2848 (safe-retirement slice 2)
 * deletes this map along with `proposeSafeTx` itself.
 */
const SAFE_TX_SERVICE_BASE_URLS: Record<number, string> = {
  100: 'https://api.safe.global/tx-service/gno',
  8453: 'https://api.safe.global/tx-service/base',
  84532: 'https://api.safe.global/tx-service/basesep',
}

/**
 * Propose a multi-sig transaction to the Safe Transaction Service
 *
 * `executeSafeTx` — the on-chain execution this proposal used to precede —
 * was deleted in #2847 with its backend (`POST /safe/exec`).
 */
export async function proposeSafeTx(
  safeAddress: Address,
  tx: SafeTxParams,
  safeTxHash: string,
  signature: `0x${string}`,
  sender: Address,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<void> {
  const adjustedSig = normaliseSignatureV(signature)
  const txServiceBaseUrl = SAFE_TX_SERVICE_BASE_URLS[chainId]
  if (!txServiceBaseUrl) {
    // Same message shape getChainConfig threw before #2849.
    throw new Error(`Unsupported chain: ${chainId}`)
  }
  const url = `${txServiceBaseUrl}/api/v1/safes/${safeAddress}/multisig-transactions/`

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

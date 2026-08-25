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
 * KEPT, with the consumer that requires each:
 *
 *  - `getChainTokens` — a generic per-chain token list, and the one export a
 *    DELEGATION-rail surface reads: `DelegationSendModal`,
 *    `useAgentConnectionSetup`, `agent-panel/agent-display` (and
 *    `EditAgentModal`). Nothing about it is AllowanceModule code.
 *  - `getSafeNonce` / `getSafeTxHash` / `signSafeTx` / `executeSafeTx` /
 *    `proposeSafeTx` / `SafeTxParams` / `SafeTxReceiptTimeoutError` — the
 *    OWNER-signed Safe execution path, still used by the agent lifecycle
 *    (`lib/agent-setup.ts`, `lib/revoke-agent.ts`, `EditAgentModal`,
 *    `lib/allowance-module.ts`, and `signSafeTx` from `lib/signer.ts`). Those
 *    surfaces are out of this slice's scope; the epic's residue sweep (#1993)
 *    owns whatever of them the retirement eventually reaches.
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
  encodeFunctionData,
  hashTypedData,
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

/** Execute the Safe transaction on-chain (threshold = 1) */
export async function executeSafeTx(
  signer: SafeCapableSigner,
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
    // #1229: an account can hold a backup passkey now, so "the user's passkey
    // on this chain" no longer names one credential. Say which one signed —
    // the relay resolves the signer contract from it.
    credential_id: signer.credentialId,
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

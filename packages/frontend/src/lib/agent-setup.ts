import { type Address, type Hash, type PublicClient } from 'viem'
import { buildAgentSetupTx, isModuleEnabled, type AllowanceSetup } from './allowance-module'
import {
  executeSafeTx,
  getSafeNonce,
  getSafeTxHash,
  proposeSafeTx,
  signSafeTx,
  SafeTxReceiptTimeoutError,
} from './safe-tx'
import type { HavenUserSigner } from './signer'

/**
 * Outcome of the on-chain agent-setup batch:
 *  - `confirmed`        single-owner Safe, tx mined within the timeout
 *  - `proposed`         multisig Safe, tx posted to the Safe Tx Service
 *  - `receipt_timeout`  single-owner tx broadcast but not mined within 2 min;
 *                       it may still land, so callers must NOT re-run the batch
 */
export type AgentSetupStatus = 'confirmed' | 'proposed' | 'receipt_timeout'

export interface AgentSetupResult {
  status: AgentSetupStatus
  /** On-chain tx hash for confirmed/receipt_timeout; the SafeTx hash for proposed. */
  txHash: Hash
  /** EIP-712 SafeTx hash (always computed). */
  safeTxHash: Hash
}

export interface ExecuteAgentSetupParams {
  signer: HavenUserSigner
  publicClient: PublicClient
  safeAddress: Address
  delegateAddress: Address
  allowances: AllowanceSetup[]
  chainId: number
  threshold: number
  /** Optional per-step progress, for UIs that surface a status line. */
  onStatus?: (status: 'checking' | 'signing' | 'executing') => void
}

/**
 * Build, sign, and submit the agent-setup batch (enableModule + addDelegate +
 * setAllowance per token) as a single Safe transaction.
 *
 * Used by the ConnectAgent2Modal flow so the on-chain orchestration — and its
 * timeout/confirm semantics — stays in one place. Callers own everything after:
 * saving the agent, recording the wallet approval, and rendering the result.
 *
 * A receipt timeout is returned as a status (not thrown) so the caller can act
 * on the partially-applied state with the tx hash in hand, rather than treating
 * it as a failure and re-running the batch (which would double-apply or collide
 * on the Safe nonce once the original tx confirms).
 */
export async function executeAgentSetup(
  params: ExecuteAgentSetupParams,
): Promise<AgentSetupResult> {
  const {
    signer,
    publicClient,
    safeAddress,
    delegateAddress,
    allowances,
    chainId,
    threshold,
    onStatus,
  } = params

  onStatus?.('checking')
  const moduleEnabled = await isModuleEnabled(publicClient, safeAddress)
  const nonce = await getSafeNonce(publicClient, safeAddress)
  const safeTx = buildAgentSetupTx(
    safeAddress,
    delegateAddress,
    allowances,
    !moduleEnabled,
    nonce,
    chainId,
  )
  const safeTxHash = getSafeTxHash(safeAddress, safeTx, chainId)

  onStatus?.('signing')
  const signature = await signSafeTx(signer, safeAddress, safeTx, chainId)

  onStatus?.('executing')
  if (threshold <= 1) {
    try {
      const result = await executeSafeTx(
        signer,
        publicClient,
        safeAddress,
        safeTx,
        signature,
        chainId,
      )
      return { status: 'confirmed', txHash: result.txHash, safeTxHash }
    } catch (err) {
      if (err instanceof SafeTxReceiptTimeoutError) {
        return { status: 'receipt_timeout', txHash: err.txHash, safeTxHash }
      }
      throw err
    }
  }

  await proposeSafeTx(safeAddress, safeTx, safeTxHash, signature, signer.address, chainId)
  return { status: 'proposed', txHash: safeTxHash, safeTxHash }
}

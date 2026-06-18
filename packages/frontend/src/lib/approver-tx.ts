import type { Address, PublicClient } from 'viem'
import { api } from '@/lib/api'
import type { HavenUserSigner } from '@/lib/signer'
import {
  executeSafeTx,
  getSafeNonce,
  signSafeTx,
  type SafeTxParams,
} from '@/lib/safe-tx'
import type { ApproverType } from '@/hooks/useSafeApprovers'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

interface OwnerTxResponse {
  chain_id: number
  safe_address: string
  tx: {
    to: string
    value: string
    data: string
    operation: 0
  }
}

interface ApplyApproverChangeInput {
  safeId: string
  safeAddress: Address
  chainId: number
  action: 'add' | 'remove'
  address: string
  signer: HavenUserSigner
  publicClient: PublicClient
  /** Metadata persisted after an add. Ignored for remove. */
  label?: string
  type?: ApproverType
}

/**
 * Apply an approver (Safe owner) change end to end:
 *   1. ask the backend to construct + guard the owner-change Safe self-call
 *   2. sign it with the user's own owner key (EOA or passkey) — Haven never signs
 *   3. execute it (wallet direct for EOA, relayed for passkey)
 *   4. persist / drop the label+type metadata
 *
 * The last-owner and already-an-owner guards live in step 1 on the backend, so
 * an invalid change throws before anything is signed.
 */
export async function applyApproverChange({
  safeId,
  safeAddress,
  chainId,
  action,
  address,
  signer,
  publicClient,
  label,
  type,
}: ApplyApproverChangeInput): Promise<{ txHash: string }> {
  const built = await api.post<OwnerTxResponse>(`/user/safes/${safeId}/approvers/tx`, {
    action,
    address,
  })

  const nonce = await getSafeNonce(publicClient, safeAddress)
  const tx: SafeTxParams = {
    to: built.tx.to as Address,
    value: BigInt(built.tx.value),
    data: built.tx.data as `0x${string}`,
    operation: built.tx.operation,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  }

  const signature = await signSafeTx(signer, safeAddress, tx, chainId)
  const { txHash } = await executeSafeTx(signer, publicClient, safeAddress, tx, signature, chainId)

  // Bookkeeping only — failure here doesn't undo the on-chain change, so the
  // approver list still reconciles from chain on the next refetch.
  try {
    if (action === 'add') {
      await api.post(`/user/safes/${safeId}/approvers`, {
        address,
        type: type ?? 'eoa',
        label: label ?? undefined,
      })
    } else {
      await api.delete(`/user/safes/${safeId}/approvers/${address}`)
    }
  } catch {
    /* metadata is best-effort; on-chain membership is the source of truth */
  }

  return { txHash }
}

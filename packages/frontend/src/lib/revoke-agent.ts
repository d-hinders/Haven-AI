import { type Address, type PublicClient } from 'viem'
import { buildAgentRevokeTx } from './allowance-module'
import { executeSafeTx, getSafeNonce, getSafeTxHash, proposeSafeTx, signSafeTx } from './safe-tx'
import type { HavenUserSigner } from './signer'
import type { Agent } from '@/hooks/useAgents'
import type { SafeDetails } from '@/types/transactions'

interface RevokeAgentParams {
  agent: Agent
  publicClient: PublicClient
  signer: HavenUserSigner
  safeAddress: Address
  safeDetails: SafeDetails
  chainId: number
}

export function isUserRejectedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes('rejected') || err.message.includes('denied'))
  )
}

export async function revokeAgentOnChain({
  agent,
  publicClient,
  signer,
  safeAddress,
  safeDetails,
  chainId,
}: RevokeAgentParams): Promise<void> {
  if (!agent.delegate_address) {
    throw new Error('Agent has no delegate address configured')
  }

  const nonce = await getSafeNonce(publicClient, safeAddress)
  const safeTx = buildAgentRevokeTx(agent.delegate_address as Address, nonce)
  const signature = await signSafeTx(signer, safeAddress, safeTx, chainId)

  const threshold = safeDetails.threshold ?? 1
  if (threshold <= 1) {
    await executeSafeTx(
      signer,
      publicClient,
      safeAddress,
      safeTx,
      signature,
      chainId,
    )
    return
  }

  const safeTxHash = getSafeTxHash(safeAddress, safeTx, chainId)

  await proposeSafeTx(
    safeAddress,
    safeTx,
    safeTxHash,
    signature,
    signer.address,
    chainId,
  )
}

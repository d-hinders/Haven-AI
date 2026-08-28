import { type Address, type PublicClient } from 'viem'
import { buildAgentRevokeTx } from './allowance-module'
import { executeSafeTx, getSafeNonce, getSafeTxHash, proposeSafeTx, signSafeTx } from './safe-tx'
import type { SafeCapableSigner } from './signer'
import type { Agent } from '@/hooks/useAgents'
import type { SafeDetails } from '@/types/transactions'

interface RevokeDelegateParams {
  delegateAddress: Address
  publicClient: PublicClient
  signer: SafeCapableSigner
  safeAddress: Address
  safeDetails: SafeDetails
  chainId: number
}

interface RevokeAgentParams extends Omit<RevokeDelegateParams, 'delegateAddress'> {
  agent: Agent
}

export function isUserRejectedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes('rejected') || err.message.includes('denied'))
  )
}

/**
 * Tear down a delegate's AllowanceModule authority on-chain
 * (`removeDelegate(delegate, true)` — the delegate and every allowance it
 * holds, in one Safe transaction).
 *
 * Keyed on the delegate ADDRESS alone, deliberately: the AllowanceModule
 * knows nothing about Haven agents, so the same teardown applies to a
 * delegate Haven manages and to one set up outside Haven entirely
 * (`UnmanagedDelegateCard`, #1980). Callers with a Haven agent go through
 * `revokeAgentOnChain` below and follow up with the credential revoke;
 * an unmanaged delegate has no credential, so this is the whole action.
 */
export async function revokeDelegateOnChain({
  delegateAddress,
  publicClient,
  signer,
  safeAddress,
  safeDetails,
  chainId,
}: RevokeDelegateParams): Promise<void> {
  const nonce = await getSafeNonce(publicClient, safeAddress)
  const safeTx = buildAgentRevokeTx(delegateAddress, nonce, chainId)
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

export async function revokeAgentOnChain({
  agent,
  ...params
}: RevokeAgentParams): Promise<void> {
  if (!agent.delegate_address) {
    throw new Error('Agent has no delegate address configured')
  }

  await revokeDelegateOnChain({
    ...params,
    delegateAddress: agent.delegate_address as Address,
  })
}

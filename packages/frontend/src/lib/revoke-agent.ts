import { hashTypedData, type Address, type PublicClient, type WalletClient } from 'viem'
import { buildAgentRevokeTx } from './allowance-module'
import { executeSafeTx, getSafeNonce, proposeSafeTx, signSafeTx } from './safe-tx'
import type { Agent } from '@/hooks/useAgents'
import type { SafeDetails } from '@/types/transactions'

interface RevokeAgentParams {
  agent: Agent
  publicClient: PublicClient
  walletClient: WalletClient
  connectedAddress: Address
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
  walletClient,
  connectedAddress,
  safeAddress,
  safeDetails,
  chainId,
}: RevokeAgentParams): Promise<void> {
  if (!agent.delegate_address) {
    throw new Error('Agent has no delegate address configured')
  }

  const nonce = await getSafeNonce(publicClient, safeAddress)
  const safeTx = buildAgentRevokeTx(agent.delegate_address as Address, nonce)
  const signature = await signSafeTx(
    walletClient,
    safeAddress,
    safeTx,
    connectedAddress,
    chainId,
  )

  const threshold = safeDetails.threshold ?? 1
  if (threshold <= 1) {
    await executeSafeTx(
      walletClient,
      publicClient,
      safeAddress,
      safeTx,
      signature,
      connectedAddress,
      chainId,
    )
    return
  }

  const safeTxHash = hashTypedData({
    domain: {
      chainId,
      verifyingContract: safeAddress,
    },
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
    primaryType: 'SafeTx',
    message: {
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
      safeTxGas: safeTx.safeTxGas,
      baseGas: safeTx.baseGas,
      gasPrice: safeTx.gasPrice,
      gasToken: safeTx.gasToken,
      refundReceiver: safeTx.refundReceiver,
      nonce: safeTx.nonce,
    },
  })

  await proposeSafeTx(
    safeAddress,
    safeTx,
    safeTxHash,
    signature,
    connectedAddress,
    chainId,
  )
}

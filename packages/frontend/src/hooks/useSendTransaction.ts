'use client'

import { useState, useCallback } from 'react'
import { usePublicClient, useWalletClient } from 'wagmi'
import { type Address, hashTypedData } from 'viem'
import { gnosis } from 'viem/chains'
import {
  buildSafeTx,
  signSafeTx,
  executeSafeTx,
  proposeSafeTx,
  getSafeNonce,
  type SendParams,
} from '@/lib/safe-tx'

export type SendStatus =
  | 'idle'
  | 'building'
  | 'signing'
  | 'executing'
  | 'confirmed'
  | 'proposed'
  | 'error'

interface UseSendTransactionReturn {
  status: SendStatus
  txHash: string | null
  error: string | null
  send: (params: SendParams, safeAddress: Address, threshold: number, signer: Address) => Promise<void>
  reset: () => void
}

export function useSendTransaction(): UseSendTransactionReturn {
  const [status, setStatus] = useState<SendStatus>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const publicClient = usePublicClient({ chainId: gnosis.id })
  const { data: walletClient } = useWalletClient({ chainId: gnosis.id })

  const reset = useCallback(() => {
    setStatus('idle')
    setTxHash(null)
    setError(null)
  }, [])

  const send = useCallback(
    async (
      params: SendParams,
      safeAddress: Address,
      threshold: number,
      signer: Address,
    ) => {
      if (!walletClient || !publicClient) {
        setError('Wallet not connected')
        setStatus('error')
        return
      }

      try {
        // Build
        setStatus('building')
        setError(null)
        setTxHash(null)

        const nonce = await getSafeNonce(publicClient, safeAddress)
        const safeTx = buildSafeTx(params, nonce)

        // Sign
        setStatus('signing')
        const signature = await signSafeTx(walletClient, safeAddress, safeTx, signer)

        if (threshold <= 1) {
          // Single-owner: execute directly
          setStatus('executing')
          const result = await executeSafeTx(
            walletClient,
            publicClient,
            safeAddress,
            safeTx,
            signature,
            signer,
          )
          setTxHash(result.txHash)
          setStatus('confirmed')
        } else {
          // Multi-sig: propose to Safe Transaction Service
          setStatus('executing')

          // Compute the safeTxHash for the proposal
          const safeTxHash = hashTypedData({
            domain: {
              chainId: gnosis.id,
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

          await proposeSafeTx(safeAddress, safeTx, safeTxHash, signature, signer)
          setTxHash(safeTxHash)
          setStatus('proposed')
        }
      } catch (err: unknown) {
        // User rejected in wallet
        if (
          err instanceof Error &&
          (err.message.includes('User rejected') ||
            err.message.includes('user rejected') ||
            err.message.includes('User denied'))
        ) {
          setError('Transaction rejected in wallet')
        } else {
          setError(err instanceof Error ? err.message : 'Transaction failed')
        }
        setStatus('error')
      }
    },
    [walletClient, publicClient],
  )

  return { status, txHash, error, send, reset }
}

'use client'

import { useState, useCallback } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useActiveSigner } from '@/lib/signer'
import {
  buildSafeTx,
  signSafeTx,
  executeSafeTx,
  getSafeTxHash,
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
  send: (params: SendParams, safeAddress: Address, threshold: number, signer: Address, chainId?: number) => Promise<void>
  reset: () => void
}

export function useSendTransaction(): UseSendTransactionReturn {
  const [status, setStatus] = useState<SendStatus>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { activeSafe } = useAuth()
  const publicClient = usePublicClient()
  const signer = useActiveSigner({
    safeAddress: activeSafe?.safe_address as Address | undefined,
    chainId: activeSafe?.chain_id,
  })

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
      _owner: Address,
      chainId: number = 100,
    ) => {
      if (!signer || !publicClient) {
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
        const signature = await signSafeTx(signer, safeAddress, safeTx, chainId)

        if (threshold <= 1) {
          // Single-owner: execute directly
          setStatus('executing')
          const result = await executeSafeTx(
            signer,
            publicClient,
            safeAddress,
            safeTx,
            signature,
            chainId,
          )
          setTxHash(result.txHash)
          setStatus('confirmed')
        } else {
          // Multi-sig: propose to Safe Transaction Service
          setStatus('executing')

          const safeTxHash = getSafeTxHash(safeAddress, safeTx, chainId)

          await proposeSafeTx(safeAddress, safeTx, safeTxHash, signature, signer.address, chainId)
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
    [signer, publicClient],
  )

  return { status, txHash, error, send, reset }
}

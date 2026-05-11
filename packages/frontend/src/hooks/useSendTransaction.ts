'use client'

import { useState, useCallback } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
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

export function useSendTransaction(args: {
  safeAddress?: Address
  chainId?: number
} = {}): UseSendTransactionReturn {
  const [status, setStatus] = useState<SendStatus>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const publicClient = usePublicClient({ chainId: args.chainId })
  const signer = useActiveSigner({
    safeAddress: args.safeAddress,
    chainId: args.chainId,
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
        setError('No approval method is available for this Haven wallet.')
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
          setError(
            signer.type === 'passkey'
              ? 'Face ID or Touch ID was cancelled'
              : 'Payment was cancelled in your wallet.',
          )
        } else {
          setError('We could not send this payment. Check your approval method, then try again.')
        }
        setStatus('error')
      }
    },
    [signer, publicClient],
  )

  return { status, txHash, error, send, reset }
}

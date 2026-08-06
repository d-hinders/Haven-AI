'use client'

/**
 * Owner-initiated send from a delegation-rail account (#1083).
 *
 * The rail's "Send": the treasury executes an ERC-20 transfer as a sponsored
 * account op the OWNER signs — prepare/submit through the #1083 by-address
 * routes, calldata pinned server-side to what was signed. The signature
 * scheme is the DEVICE's choice (#1086 via `pickSigningPath`), dispatched
 * through the shared `signPreparedAccountOp`. Works on a counterfactual
 * account (#1106): deploy + transfer ride one sponsored op.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { api } from '@/lib/api'
import { useActiveSigner } from '@/lib/signer'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'
import { signPreparedAccountOp, type PreparedAccountOp } from '@/lib/hybridAccountOps'
import type { AccountSigners } from '@/lib/delegationPasskeySigner'
import { pickSigningPath, passkeyLikelyElsewhere } from './useDelegationBudget'

export type SendResult =
  | { ok: true; txHash: string | null }
  | { ok: false; reason: 'cancelled' | 'failed'; message?: string }

export interface SendInput {
  tokenAddress: Address
  to: Address
  amountAtomic: string
}

export function useDelegationSend(accountAddress: string, chainId: number) {
  const [signers, setSigners] = useState<AccountSigners | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const signer = useActiveSigner({
    safeAddress: signers ? (signers.account_address as Address) : undefined,
    chainId,
  })

  const reload = useCallback(async () => {
    // #1079 discipline: a failed fetch is a retryable ERROR state, never a
    // silent null the UI misreads as an account shape.
    setLoadError(false)
    try {
      setSigners(
        await api.get<AccountSigners>(`/accounts/hybrid/${accountAddress}/signers?chain_id=${chainId}`),
      )
    } catch {
      setSigners(null)
      setLoadError(true)
    }
  }, [accountAddress, chainId])

  useEffect(() => {
    void reload()
  }, [reload])

  const signingPath = pickSigningPath(signers, signer?.type === 'eoa')

  const send = useCallback(
    async (input: SendInput): Promise<SendResult> => {
      setBusy(true)
      try {
        const body = {
          token_address: input.tokenAddress,
          to: input.to,
          amount_atomic: input.amountAtomic,
          signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop',
        }
        const prep = await api.post<PreparedAccountOp>(
          `/accounts/hybrid/${accountAddress}/transfers/prepare?chain_id=${chainId}`,
          body,
        )
        const signature = await signPreparedAccountOp(prep, signers, signer)
        const done = await api.post<{ tx_hash?: string | null }>(
          `/accounts/hybrid/${accountAddress}/transfers/submit?chain_id=${chainId}`,
          { ...body, signature, user_operation: prep.user_operation },
        )
        return { ok: true, txHash: done.tx_hash ?? null }
      } catch (err) {
        if (isPasskeyCancellation(err)) return { ok: false, reason: 'cancelled' }
        return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : undefined }
      } finally {
        setBusy(false)
      }
    },
    [accountAddress, chainId, signer, signers, signingPath],
  )

  return {
    busy,
    // Signer set fetched — until then `ready` is meaningless, not a blocker.
    loaded: signers !== null,
    loadError,
    reload,
    // Some signer for this account is reachable from THIS device.
    ready: signingPath !== null,
    // #1097: hint condition — the ceremony may hand off to another device.
    passkeyElsewhere: passkeyLikelyElsewhere(signers),
    send,
  }
}

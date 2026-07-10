'use client'

/**
 * Delegation-rail budget lifecycle for the dashboard (#833, epic #821).
 *
 * The owner-facing counterpart of the delegation lifecycle API (#828): grant a
 * budget with ONE signature, list budgets with status, revoke with ONE
 * signature. The wallet signs the EIP-712 typed data the backend returns
 * VERBATIM — never a reconstructed payload, never a bare hash (the #829/#832
 * lesson; the account validates exactly that typed data). Haven signs nothing.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { api } from '@/lib/api'
import { useActiveSigner } from '@/lib/signer'

export interface DelegationBudget {
  id: string
  token_address: string
  recipient_address: string | null
  delegation_hash: string
  version: number
  status: 'pending' | 'active' | 'replaced' | 'revoked'
  budget_atomic: string
  period_seconds: number
  expires_at: number
}

interface BuildResponse {
  delegation_hash: string
  version: number
  signing_payload: TypedDataPayload
}

interface RevokePrepare {
  signing_payload: TypedDataPayload
  user_operation: unknown
}

interface TypedDataPayload {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

export interface GrantInput {
  tokenAddress: Address
  recipientAddress?: Address | null
  budgetAtomic: string
  periodSeconds: number
}

export type BudgetResult = { ok: true } | { ok: false; reason: 'cancelled' | 'failed' }

async function signTyped(
  signer: NonNullable<ReturnType<typeof useActiveSigner>>,
  payload: TypedDataPayload,
): Promise<`0x${string}`> {
  if (signer.type !== 'eoa') {
    // Owner EIP-712 signing over the account payload needs a wallet client;
    // passkey-owner budget signing lands with #836's recovery/WebAuthn work.
    throw new Error('Connect your account owner wallet to set or stop a budget.')
  }
  // ethers/wallet derives EIP712Domain itself; strip it if present.
  const types = { ...payload.types }
  delete (types as Record<string, unknown>).EIP712Domain
  return signer.walletClient.signTypedData({
    account: signer.address,
    domain: payload.domain,
    types,
    primaryType: payload.primaryType,
    message: payload.message,
  } as never)
}

export function useDelegationBudget(agentId: string, chainId: number) {
  const [budgets, setBudgets] = useState<DelegationBudget[] | null>(null)
  const [busy, setBusy] = useState(false)
  const signer = useActiveSigner({ chainId })

  const reload = useCallback(async () => {
    try {
      const res = await api.get<{ delegations: DelegationBudget[] }>(`/agents/${agentId}/delegations`)
      setBudgets(res.delegations)
    } catch {
      setBudgets(null)
    }
  }, [agentId])

  useEffect(() => {
    void reload()
  }, [reload])

  const grant = useCallback(
    async (input: GrantInput): Promise<BudgetResult> => {
      if (!signer) return { ok: false, reason: 'failed' }
      setBusy(true)
      try {
        const built = await api.post<BuildResponse>(`/agents/${agentId}/delegations/build`, {
          token_address: input.tokenAddress,
          recipient_address: input.recipientAddress ?? null,
          budget_atomic: input.budgetAtomic,
          period_seconds: input.periodSeconds,
        })
        const signature = await signTyped(signer, built.signing_payload)
        await api.post(`/agents/${agentId}/delegations/${built.delegation_hash}/activate`, { signature })
        await reload()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
      } finally {
        setBusy(false)
      }
    },
    [agentId, reload, signer],
  )

  const revoke = useCallback(
    async (delegationHash: string): Promise<BudgetResult> => {
      if (!signer) return { ok: false, reason: 'failed' }
      setBusy(true)
      try {
        const prep = await api.post<RevokePrepare>(`/agents/${agentId}/delegations/${delegationHash}/revoke`, {})
        const signature = await signTyped(signer, prep.signing_payload)
        await api.post(`/agents/${agentId}/delegations/${delegationHash}/revoke/submit`, {
          signature,
          user_operation: prep.user_operation,
        })
        await reload()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
      } finally {
        setBusy(false)
      }
    },
    [agentId, reload, signer],
  )

  return { budgets, grant, revoke, busy, ready: signer?.type === 'eoa', reload }
}

function cancelled(err: unknown): boolean {
  const m = err instanceof Error ? err.message.toLowerCase() : ''
  return m.includes('rejected') || m.includes('denied')
}

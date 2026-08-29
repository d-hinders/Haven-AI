'use client'

/**
 * Read-only custody proof for a DELEGATION-rail account (#2106, epic #1440).
 *
 * `/custody` exists to show what constrains an agent, and on the delegation
 * rail that is the signed budget delegation — not the retired Safe
 * AllowanceModule. This hook is the READ half of two surfaces that already
 * exist for the write path:
 *
 * - `useAccountSigners` (#1089) owns `/accounts/hybrid/:address/signers` for
 *   ENROLLING and REMOVING signers, and pulls in `useActiveSigner` plus the
 *   WebAuthn/EOA signing machinery to do it.
 * - `useDelegationBudget` (#833) owns `/agents/:id/delegations` for GRANTING
 *   and REVOKING budgets, and does the same.
 *
 * `/custody` signs nothing. Reusing either of those would make a proof page
 * probe the device for credentials and resolve a signing path it will never
 * use, so this is a deliberate read-only twin over the same two endpoints —
 * the response TYPES are imported from those modules, never restated, so the
 * two halves cannot drift apart.
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { AccountSigners } from '@/lib/delegationPasskeySigner'
import type { DelegationBudget } from './useDelegationBudget'

export interface DelegationCustodyProof {
  /** The account's on-chain signer set, or null while loading / on error. */
  signers: AccountSigners | null
  signersLoading: boolean
  /** Agent id → that agent's delegations (every status, callers filter). */
  budgetsByAgent: Map<string, DelegationBudget[]>
  budgetsLoading: boolean
  /**
   * At least one agent's delegation read FAILED (#2106 review finding).
   *
   * Load-bearing, not decoration. Without it a failed read is indistinguishable
   * from an empty result, and the card renders "No agent budget granted" — an
   * affirmative claim that this agent has no on-chain limit, on the one page
   * that exists to stop Haven making false custody claims. That is the same
   * defect as the one #2106 fixes, arrived at from the other direction, so the
   * unknown state has to stay distinguishable from the empty one.
   */
  budgetsError: boolean
  /** Retry the delegation reads — a failed proof must never be a dead end. */
  reloadBudgets: () => Promise<void>
}

export function useDelegationCustodyProof(
  accountAddress: string | null,
  chainId: number,
  agentIds: string[],
): DelegationCustodyProof {
  const [signers, setSigners] = useState<AccountSigners | null>(null)
  const [signersLoading, setSignersLoading] = useState(Boolean(accountAddress))
  const [budgetsByAgent, setBudgetsByAgent] = useState<Map<string, DelegationBudget[]>>(new Map())
  const [budgetsLoading, setBudgetsLoading] = useState(agentIds.length > 0)
  const [budgetsError, setBudgetsError] = useState(false)

  // Agent ids arrive as a fresh array on every parent render, so the effect
  // keys off a stable join instead — without it the fetch loops forever.
  const agentKey = agentIds.join(',')

  const loadSigners = useCallback(async () => {
    if (!accountAddress) {
      setSigners(null)
      setSignersLoading(false)
      return
    }
    setSignersLoading(true)
    try {
      setSigners(
        await api.get<AccountSigners>(
          `/accounts/hybrid/${accountAddress}/signers?chain_id=${chainId}`,
        ),
      )
    } catch {
      // A failed read renders as "—", never as a claim about the signer set.
      setSigners(null)
    } finally {
      setSignersLoading(false)
    }
  }, [accountAddress, chainId])

  const loadBudgets = useCallback(async () => {
    const ids = agentKey ? agentKey.split(',') : []
    if (ids.length === 0) {
      setBudgetsByAgent(new Map())
      setBudgetsError(false)
      setBudgetsLoading(false)
      return
    }
    setBudgetsLoading(true)
    const next = new Map<string, DelegationBudget[]>()
    let failed = false
    await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await api.get<{ delegations: DelegationBudget[] }>(`/agents/${id}/delegations`)
          next.set(id, res?.delegations ?? [])
        } catch {
          // One agent's failed read must not void the others' rows — but it
          // must not be recorded as an empty result either. The agent is left
          // ABSENT from the map and the failure is flagged, so the card can
          // say "could not load" instead of "no budget granted".
          failed = true
        }
      }),
    )
    setBudgetsByAgent(next)
    setBudgetsError(failed)
    setBudgetsLoading(false)
  }, [agentKey])

  useEffect(() => {
    void loadSigners()
  }, [loadSigners])

  useEffect(() => {
    void loadBudgets()
  }, [loadBudgets])

  return {
    signers,
    signersLoading,
    budgetsByAgent,
    budgetsLoading,
    budgetsError,
    reloadBudgets: loadBudgets,
  }
}

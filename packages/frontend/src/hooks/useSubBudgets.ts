'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { ApiOperations, ApiSchema } from '@haven_ai/core'

/** Wire shape of one sub-budget row (#3330): `components.schemas.SubBudget` in `openapi/spec.ts`. */
export type SubBudget = ApiSchema<'SubBudget'>

/** One parent→child tree (#3330): A's parent-child narrowing with its grants nested — `components.schemas.SubBudgetTree` in `openapi/spec.ts`. */
export type SubBudgetTree = ApiSchema<'SubBudgetTree'>

/** Request body of `POST /agents/:id/sub-budgets` (#3506): the spec's `issueAgentSubBudget`. Atomic amount, unix-seconds expiry. */
export type IssueSubBudgetInput =
  ApiOperations['issueAgentSubBudget']['requestBody']['content']['application/json']

/** The 201 body: two PENDING rows the delegating agent still has to sign. */
export type IssueSubBudgetResponse =
  ApiOperations['issueAgentSubBudget']['responses']['201']['content']['application/json']

/** Owner JWT only — Haven builds both rows server-side; no passkey prompt, no on-chain step. */
export function issueSubBudget(agentId: string, input: IssueSubBudgetInput) {
  return api.post<IssueSubBudgetResponse>(`/agents/${agentId}/sub-budgets`, input)
}

/**
 * The owner-facing read of the sub-budget trees an agent ISSUES (#3330,
 * `GET /agents/:id/sub-budgets/tree`) — the parent→child view for the
 * agent-page budget card. Read separately from the period budgets so a
 * failure here never breaks the budgets list this feeds
 * (`DelegationBudgetCard`), exactly as `useTaskBudgets` does for #3329.
 */
export function useSubBudgetTrees(agentId: string) {
  const [trees, setTrees] = useState<SubBudgetTree[] | null>(null)
  const [error, setError] = useState(false)
  // One in-flight request per hook (the #2732 "Async Hook Requests" trap): a
  // late response from a PREVIOUS agentId must not overwrite the current
  // agent's card — it is silently discarded rather than applied.
  const requestIdRef = useRef(0)

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current
    try {
      const res = await api.get<{
        trees: SubBudgetTree[]
        unattached?: SubBudget[]
      }>(`/agents/${agentId}/sub-budgets/tree`)
      if (requestIdRef.current !== requestId) return
      // `?? []` — an absent key must degrade, not crash the route (#3093).
      setTrees(res.trees ?? [])
      setError(false)
    } catch {
      if (requestIdRef.current !== requestId) return
      // A failed fetch must not take the budgets list down with it — leave
      // any previously loaded rows in place and surface only `error`.
      setError(true)
    }
  }, [agentId])

  useEffect(() => {
    // A new agentId clears the previous agent's already-resolved rows before
    // the new fetch even starts; `reload()`'s own `++requestIdRef.current`
    // invalidates any request the old agentId still has outstanding.
    setTrees(null)
    setError(false)
    void reload()
  }, [agentId, reload])

  return { trees, error, reload }
}

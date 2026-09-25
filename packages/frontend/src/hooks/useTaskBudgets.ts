'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'

/** Wire shape of a task budget (#3329): `components.schemas.TaskBudget` in `openapi/spec.ts`. */
export type TaskBudget = ApiSchema<'TaskBudget'>

/**
 * The owner-facing read of an agent's task budgets (#3329,
 * `GET /agents/:id/task-budgets`) — the counterpart to
 * `useDelegationBudget`'s period budgets, read separately so a failure here
 * never breaks the budgets list this feeds (`DelegationBudgetCard`).
 */
export function useTaskBudgets(agentId: string) {
  const [taskBudgets, setTaskBudgets] = useState<TaskBudget[] | null>(null)
  const [error, setError] = useState(false)
  // One in-flight request per hook (the #2732 "Async Hook Requests" trap): a
  // late response from a PREVIOUS agentId must not overwrite the current
  // agent's card — it is silently discarded rather than applied.
  const requestIdRef = useRef(0)

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current
    try {
      const res = await api.get<{ task_budgets: TaskBudget[] }>(`/agents/${agentId}/task-budgets`)
      if (requestIdRef.current !== requestId) return
      // `?? []` — an absent key must degrade, not crash the route (#3093).
      setTaskBudgets(res.task_budgets ?? [])
      setError(false)
    } catch {
      if (requestIdRef.current !== requestId) return
      // A failed fetch must not take the budgets list down with it (#3329) —
      // leave any previously loaded rows in place and surface only `error`.
      setError(true)
    }
  }, [agentId])

  useEffect(() => {
    // A new agentId clears the previous agent's already-resolved rows before
    // the new fetch even starts — the old agent's task budgets must never
    // render on the new agent's card while the new fetch is in flight.
    // `reload()`'s own `++requestIdRef.current` invalidates any request the
    // old agentId still has outstanding.
    setTaskBudgets(null)
    setError(false)
    void reload()
  }, [agentId, reload])

  return { taskBudgets, error, reload }
}

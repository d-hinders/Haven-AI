'use client'

import { useCallback, useEffect, useState } from 'react'
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

  const reload = useCallback(async () => {
    try {
      const res = await api.get<{ task_budgets: TaskBudget[] }>(`/agents/${agentId}/task-budgets`)
      // `?? []` — an absent key must degrade, not crash the route (#3093).
      setTaskBudgets(res.task_budgets ?? [])
      setError(false)
    } catch {
      // A failed fetch must not take the budgets list down with it (#3329) —
      // leave any previously loaded rows in place and surface only `error`.
      setError(true)
    }
  }, [agentId])

  useEffect(() => {
    void reload()
  }, [reload])

  return { taskBudgets, error, reload }
}

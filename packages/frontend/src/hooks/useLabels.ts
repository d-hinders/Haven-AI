'use client'

import { useCallback, useState } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'

export type Label = ApiSchema<'Label'>

/**
 * The user's label vocabulary (#3167).
 *
 * Deliberately a passive hook: it exposes the CRUD calls and the fetched
 * list, but no polling and no auto-refetch — the vocabulary changes only
 * through the surfaces this hook is passed to, and `onChanged` lets each
 * caller fold the outcome into ITS list state (the editor updates the one
 * agent it is open for; the manager refreshes the vocabulary it renders).
 *
 * The putAgentLabels call returns the saved labels, so the editor does not
 * depend on this hook's cache for the agent's new set.
 */
export function useLabels(options?: { onChanged?: () => void }) {
  const [labels, setLabels] = useState<Label[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const onChanged = options?.onChanged

  const fetchLabels = useCallback(async (): Promise<Label[]> => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ labels: Label[] }>('/labels')
      // `?? []` — an absent key must degrade, not crash the route (#3093).
      const rows = res.labels ?? []
      setLabels(rows)
      return rows
    } catch {
      setError('We could not load your labels. Try again in a moment.')
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const createLabel = useCallback(
    async (name: string, color?: string): Promise<Label> => {
      const label = await api.post<Label>('/labels', color ? { name, color } : { name })
      setLabels((prev) =>
        prev.some((l) => l.id === label.id)
          ? prev.map((l) => (l.id === label.id ? label : l))
          : [...prev, label].sort((a, b) => a.name.localeCompare(b.name)),
      )
      onChanged?.()
      return label
    },
    [onChanged],
  )

  const updateLabel = useCallback(
    async (id: string, fields: { name?: string; color?: string }): Promise<Label> => {
      const label = await api.put<Label>(`/labels/${id}`, fields)
      setLabels((prev) =>
        prev.map((l) => (l.id === id ? label : l)).sort((a, b) => a.name.localeCompare(b.name)),
      )
      onChanged?.()
      return label
    },
    [onChanged],
  )

  const deleteLabel = useCallback(
    async (id: string): Promise<void> => {
      await api.delete(`/labels/${id}`)
      setLabels((prev) => prev.filter((l) => l.id !== id))
      onChanged?.()
    },
    [onChanged],
  )

  /**
   * Replace one agent's whole label set. Resolves with the agent's saved
   * labels exactly as the API returned them — the editor's source of truth
   * for what the agent now carries.
   */
  const putAgentLabels = useCallback(
    async (agentId: string, labelIds: string[]): Promise<Label[]> => {
      const res = await api.put<{ labels: Label[] }>(`/agents/${agentId}/labels`, {
        label_ids: labelIds,
      })
      return res.labels ?? []
    },
    [],
  )

  return { labels, loading, error, fetchLabels, createLabel, updateLabel, deleteLabel, putAgentLabels }
}

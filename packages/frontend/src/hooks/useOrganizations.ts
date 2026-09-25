'use client'

import { useCallback, useState } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'

export type Organization = ApiSchema<'Organization'>

/**
 * The user's organization tree (#3164).
 *
 * Deliberately the same passive shape as `useLabels` (#3167): it exposes the
 * CRUD calls and the fetched list, but no polling and no auto-refetch — the
 * tree changes only through the surfaces this hook is passed to, and
 * `onChanged` lets each caller fold the outcome into ITS list state (the
 * panel refetches agents, whose rows carry `organization_id`; the manager
 * refreshes the tree it renders).
 *
 * Organizations are display/categorization only: every call here lands on
 * routes that cannot move money or change an agent's authority.
 */
export function useOrganizations(options?: { onChanged?: () => void }) {
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const onChanged = options?.onChanged

  const fetchOrganizations = useCallback(async (): Promise<Organization[]> => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ organizations: Organization[] }>('/organizations')
      // `?? []` — an absent key must degrade, not crash the route (#3093).
      const rows = res.organizations ?? []
      setOrganizations(rows)
      return rows
    } catch {
      setError('We could not load your organizations. Try again in a moment.')
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const createOrganization = useCallback(
    async (name: string, parentOrganizationId?: string | null): Promise<Organization> => {
      const body = parentOrganizationId ? { name, parent_organization_id: parentOrganizationId } : { name }
      const org = await api.post<Organization>('/organizations', body)
      setOrganizations((prev) =>
        prev.some((o) => o.id === org.id) ? prev : [...prev, org],
      )
      onChanged?.()
      return org
    },
    [onChanged],
  )

  const updateOrganization = useCallback(
    async (
      id: string,
      fields: { name?: string; parent_organization_id?: string | null },
    ): Promise<Organization> => {
      const org = await api.put<Organization>(`/organizations/${id}`, fields)
      setOrganizations((prev) => prev.map((o) => (o.id === id ? org : o)))
      onChanged?.()
      return org
    },
    [onChanged],
  )

  const deleteOrganization = useCallback(
    async (id: string): Promise<void> => {
      await api.delete(`/organizations/${id}`)
      setOrganizations((prev) => prev.filter((o) => o.id !== id))
      onChanged?.()
    },
    [onChanged],
  )

  return { organizations, loading, error, fetchOrganizations, createOrganization, updateOrganization, deleteOrganization }
}

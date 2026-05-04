'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { DashboardOverviewResponse } from '@/types/dashboard'

export function useDashboardOverview() {
  const [data, setData] = useState<DashboardOverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchOverview = useCallback(async () => {
    try {
      setError(null)
      const response = await api.get<DashboardOverviewResponse>('/dashboard/overview')
      setData(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard overview')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchOverview()
  }, [fetchOverview])

  return {
    data,
    loading,
    error,
    refetch: fetchOverview,
  }
}

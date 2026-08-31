'use client'

import { useState, useCallback } from 'react'
import { api } from '@/lib/api'
import { useAuth, type UserSafe } from '@/context/AuthContext'

export function useUserSafes() {
  const { user, refreshUser } = useAuth()
  const [loading, setLoading] = useState(false)

  const safes = user?.safes ?? []

  // `addSafe` lived here — a POST to /user/safes, the Safe IMPORT route. It is
  // removed rather than left dead: since #1984 (epic #1440) that route answers
  // 410, so the only thing this could still do is throw. Its one call site,
  // the Accounts page's AddSafeModal, went with it. The onboarding surface that
  // called the same route, `PasskeyEnrollFlow`, was deleted by #2261 — nothing
  // in the frontend posts to a retired Safe inflow any more, and
  // `src/__tests__/safe-inflow-frontend-residue.test.ts` now holds that line.
  // Rename, remove and set-default all stay: they operate on EXISTING
  // accounts, which must keep working.

  const renameSafe = useCallback(
    async (safeId: string, name: string): Promise<UserSafe> => {
      setLoading(true)
      try {
        const result = await api.put<UserSafe>(`/user/safes/${safeId}`, { name })
        await refreshUser()
        return result
      } finally {
        setLoading(false)
      }
    },
    [refreshUser],
  )

  const removeSafe = useCallback(
    async (safeId: string): Promise<void> => {
      setLoading(true)
      try {
        await api.delete(`/user/safes/${safeId}`)
        await refreshUser()
      } finally {
        setLoading(false)
      }
    },
    [refreshUser],
  )

  const setDefault = useCallback(
    async (safeId: string): Promise<void> => {
      setLoading(true)
      try {
        await api.put(`/user/safes/${safeId}/default`, {})
        await refreshUser()
      } finally {
        setLoading(false)
      }
    },
    [refreshUser],
  )

  return { safes, loading, renameSafe, removeSafe, setDefault }
}

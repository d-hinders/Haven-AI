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
  // the Accounts page's AddSafeModal, went with it. Unlike PasskeyEnrollFlow —
  // a whole surface whose deletion is slice #1989 — this is a no-caller
  // function in a file already being edited, so leaving it would be dead code
  // the PR narrative does not account for. Rename, remove and set-default all
  // stay: they operate on EXISTING accounts, which must keep working.

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

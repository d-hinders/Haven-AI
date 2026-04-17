'use client'

import { useState, useCallback } from 'react'
import { api } from '@/lib/api'
import { useAuth, type UserSafe } from '@/context/AuthContext'

export function useUserSafes() {
  const { user, refreshUser } = useAuth()
  const [loading, setLoading] = useState(false)

  const safes = user?.safes ?? []

  const addSafe = useCallback(
    async (safe_address: string, name?: string, chain_id?: number): Promise<UserSafe> => {
      setLoading(true)
      try {
        const result = await api.post<UserSafe>('/user/safes', {
          safe_address,
          name,
          chain_id,
        })
        await refreshUser()
        return result
      } finally {
        setLoading(false)
      }
    },
    [refreshUser],
  )

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

  return { safes, loading, addSafe, renameSafe, removeSafe, setDefault }
}

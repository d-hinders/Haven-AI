'use client'

import { useState, useCallback } from 'react'
import { api } from '@/lib/api'
import { useAuth, type SmartAccount } from '@/context/AuthContext'

export function useAccounts() {
  const { user, refreshUser } = useAuth()
  const [loading, setLoading] = useState(false)

  const accounts = user?.accounts ?? []

  // `addAccount` lived here — a POST to /user/safes, the Safe IMPORT route. It
  // is removed rather than left dead: since #1984 (epic #1440) that route answers
  // 410, so the only thing this could still do is throw. Its one call site,
  // the Accounts page's AddSafeModal, went with it. The onboarding surface that
  // called the same route, `PasskeyEnrollFlow`, was deleted by #2261 — nothing
  // in the frontend posts to a retired Safe inflow any more, and
  // `src/__tests__/safe-inflow-frontend-residue.test.ts` now holds that line.
  // Rename, remove and set-default all stay: they operate on EXISTING
  // accounts, which must keep working.

  const renameAccount = useCallback(
    async (accountId: string, name: string): Promise<SmartAccount> => {
      setLoading(true)
      try {
        const result = await api.put<SmartAccount>(`/user/accounts/${accountId}`, { name })
        await refreshUser()
        return result
      } finally {
        setLoading(false)
      }
    },
    [refreshUser],
  )

  const removeAccount = useCallback(
    async (accountId: string): Promise<void> => {
      setLoading(true)
      try {
        await api.delete(`/user/accounts/${accountId}`)
        await refreshUser()
      } finally {
        setLoading(false)
      }
    },
    [refreshUser],
  )

  const setDefault = useCallback(
    async (accountId: string): Promise<void> => {
      setLoading(true)
      try {
        await api.put(`/user/accounts/${accountId}/default`, {})
        await refreshUser()
      } finally {
        setLoading(false)
      }
    },
    [refreshUser],
  )

  return { accounts, loading, renameAccount, removeAccount, setDefault }
}

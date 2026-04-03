'use client'

import { useState, useCallback } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'

type Currency = 'USD' | 'EUR'

interface UsePreferencesReturn {
  currency: Currency
  setCurrency: (c: Currency) => Promise<void>
  saving: boolean
}

export function usePreferences(): UsePreferencesReturn {
  const { user, updateUser } = useAuth()
  const [saving, setSaving] = useState(false)

  const currency: Currency = user?.currency_preference ?? 'USD'

  const setCurrency = useCallback(
    async (c: Currency) => {
      setSaving(true)
      try {
        await api.put('/user/preferences', { currency_preference: c })
        updateUser({ currency_preference: c })
      } finally {
        setSaving(false)
      }
    },
    [updateUser],
  )

  return { currency, setCurrency, saving }
}

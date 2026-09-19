'use client'

import { useState, useCallback } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'

/**
 * The display currency the Settings surface owns. SEK joins USD and EUR
 * (#3127): it is the currency the backend already served and defaulted to,
 * and the display surfaces now render it in its own voice (sv-SE) rather
 * than relabelling a USD figure with a SEK symbol.
 */
type Currency = 'USD' | 'EUR' | 'SEK'

interface UsePreferencesReturn {
  currency: Currency
  setCurrency: (c: Currency) => Promise<void>
  saving: boolean
}

export function usePreferences(): UsePreferencesReturn {
  const { user, updateUser } = useAuth()
  const [saving, setSaving] = useState(false)

  // The no-preference fallback is SEK — the same default the backend serves
  // for a null `users.currency_preference` — so a payload that omits the
  // field reads as the currency the user is actually being served, not as a
  // frontend guess.
  const currency: Currency = user?.currency_preference ?? 'SEK'

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

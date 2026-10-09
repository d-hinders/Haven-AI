'use client'

/**
 * Every signer of the signed-in user, once each, with the accounts it
 * approves (#3825) — `GET /user/signers`. A signer is its own object, not a
 * part of one account (owner decision 2026-10-09): one passkey sits on every
 * network's account, so the per-account read (`useAccountSigners`) would list
 * it once per chain. The backend dedupes and orders the list (passkeys by
 * enrollment, then wallets), so "Passkey N" numbering is stable here.
 *
 * Read-only: adding, replacing and removing a signer stay on the account
 * page's Backup & recovery card.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ApiOperations } from '@haven_ai/core'
import { api } from '@/lib/api'

type UserSignersResponse = ApiOperations['listUserSigners']['responses']['200']['content']['application/json']
export type UserSigner = UserSignersResponse['signers'][number]
export type UserSignerAccount = UserSigner['accounts'][number]

export function useUserSigners(): {
  signers: UserSigner[] | null
  loadError: boolean
  reload: () => Promise<void>
} {
  const [signers, setSigners] = useState<UserSigner[] | null>(null)
  const [loadError, setLoadError] = useState(false)

  const reload = useCallback(async () => {
    try {
      const res = await api.get<Partial<UserSignersResponse>>('/user/signers')
      setSigners(res.signers ?? [])
      setLoadError(false)
    } catch {
      setSigners(null)
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { signers, loadError, reload }
}

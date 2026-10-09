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
import { api } from '@/lib/api'

export interface UserSignerAccount {
  account_id: string
  account_address: string
  account_name: string | null
  chain_id: number
}

export type UserSigner =
  | { kind: 'passkey'; key_id: string; created_at: string | null; accounts: UserSignerAccount[] }
  | { kind: 'wallet'; address: string; accounts: UserSignerAccount[] }

export function useUserSigners(): {
  signers: UserSigner[] | null
  loadError: boolean
  reload: () => Promise<void>
} {
  const [signers, setSigners] = useState<UserSigner[] | null>(null)
  const [loadError, setLoadError] = useState(false)

  const reload = useCallback(async () => {
    try {
      const res = await api.get<{ signers?: UserSigner[] }>('/user/signers')
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

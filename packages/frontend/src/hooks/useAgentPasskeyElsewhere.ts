'use client'

/**
 * Whether the agent's account has passkeys but none marked on THIS device
 * (#1097), for a flow whose own signing hook does not expose it — the re-key
 * modal (#3825). `useAgentRekey` is a money-path control file and stays
 * untouched; this is a separate read of the same public signer set
 * (`/agents/:id/account-signers`), used only to word a hint.
 *
 * False while loading or on a failed read: the hint is information, so an
 * unknown answer shows nothing rather than a guess.
 */

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { AccountSigners } from '@/lib/delegationPasskeySigner'
import { passkeyLikelyElsewhere } from './useDelegationBudget'

export function useAgentPasskeyElsewhere(agentId: string): boolean {
  const [elsewhere, setElsewhere] = useState(false)
  useEffect(() => {
    let cancelled = false
    setElsewhere(false)
    api
      .get<AccountSigners>(`/agents/${agentId}/account-signers`)
      .then((res) => {
        if (!cancelled) setElsewhere(passkeyLikelyElsewhere({ ...res, passkeys: res.passkeys ?? [] }))
      })
      .catch(() => {
        if (!cancelled) setElsewhere(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])
  return elsewhere
}

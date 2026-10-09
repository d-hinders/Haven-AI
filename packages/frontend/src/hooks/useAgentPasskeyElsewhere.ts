'use client'

/**
 * Whether the agent's account has passkeys but none marked on THIS device
 * (#1097), for a flow whose own signing hook does not expose it — the re-key
 * modal (#3825). `useAgentRekey` is a money-path control file and stays
 * untouched; this is a separate read of the same public signer set
 * (`/agents/:id/account-signers`), used only to word a hint.
 *
 * Only when the PASSKEY will sign — never with the owner wallet connected.
 * False while loading or on a failed read: the hint is information, so an
 * unknown answer shows nothing rather than a guess.
 */

import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { api } from '@/lib/api'
import { useActiveSigner } from '@/lib/signer'
import type { AccountSigners } from '@/lib/delegationPasskeySigner'
import { passkeyLikelyElsewhere, pickSigningPath } from './useDelegationBudget'

export function useAgentPasskeyElsewhere(agentId: string, chainId: number, enabled = true): boolean {
  const [signers, setSigners] = useState<AccountSigners | null>(null)
  useEffect(() => {
    let cancelled = false
    setSigners(null)
    // The re-key modal stays mounted on the agent page; read only while it is
    // open, so a page view costs no extra request (#3825 code review).
    if (!enabled) return
    api
      .get<AccountSigners>(`/agents/${agentId}/account-signers`)
      .then((res) => {
        if (!cancelled) setSigners({ ...res, passkeys: res.passkeys ?? [] })
      })
      .catch(() => {
        if (!cancelled) setSigners(null)
      })
    return () => {
      cancelled = true
    }
  }, [agentId, enabled])
  // The same signing-path decision the re-key flow makes (#3825 design
  // review): with the account's owner wallet connected the EOA path signs,
  // and nothing hands off to another device.
  const signer = useActiveSigner({
    accountAddress: signers ? (signers.account_address as Address) : undefined,
    chainId,
  })
  const path = pickSigningPath(signers, signer?.type === 'eoa' ? signer.address : null)
  return path === 'passkey' && passkeyLikelyElsewhere(signers)
}

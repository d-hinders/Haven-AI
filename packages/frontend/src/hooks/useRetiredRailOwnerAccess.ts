'use client'

import { useMemo } from 'react'
import { useAuth, type UserSafe } from '@/context/AuthContext'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import {
  classifyRetiredRailOwnerAccess,
  type RetiredRailOwnerAccess,
} from '@/lib/retired-rail-owner-access'

type RetiredRailAccount = Pick<UserSafe, 'safe_address' | 'chain_id' | 'account_type'>

/** Read and classify the owner access needed by a legacy retirement notice. */
export function useRetiredRailOwnerAccess(account: RetiredRailAccount | null | undefined): {
  ownerAccess: RetiredRailOwnerAccess
  details: ReturnType<typeof useSafeDetails>['details']
  loading: boolean
  error: string | null
  refetch: () => void
} {
  const { user, passkeys = [] } = useAuth()
  const isLegacy = Boolean(account && account.account_type !== 'delegator_hybrid')
  const safeAddress = isLegacy ? account?.safe_address ?? null : null
  const chainId = account?.chain_id
  const { details, loading, error, refetch } = useSafeDetails(safeAddress, {
    enabled: isLegacy && Boolean(safeAddress),
    chainId,
  })

  const passkeyAddresses = useMemo(
    () =>
      new Set(
        passkeys
          .filter(
            (passkey) =>
              passkey.chain_id === chainId &&
              (!safeAddress || passkey.safe_address?.toLowerCase() === safeAddress.toLowerCase()),
          )
          .map((passkey) => passkey.signer_address.toLowerCase()),
      ),
    [chainId, passkeys, safeAddress],
  )

  const ownerAccess = classifyRetiredRailOwnerAccess({
    details: isLegacy && !loading && !error ? details : null,
    passkeyAddresses,
    walletAddress: user?.wallet_address,
  })

  return { ownerAccess, details: isLegacy ? details : null, loading, error, refetch }
}

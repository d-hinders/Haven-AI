'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import type { Contact } from '@/hooks/useContacts'
import { useBalances } from '@/hooks/useBalances'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import SendModal from './SendModal'

interface Props {
  open: boolean
  onClose: () => void
  contacts?: Contact[]
  resolveAddress?: (address: string) => string | null
  onSuccess?: () => void
}

export default function DashboardSendModal({
  open,
  onClose,
  contacts = [],
  resolveAddress,
  onSuccess,
}: Props) {
  const { user, activeSafe } = useAuth()
  const safes = user?.safes ?? []

  const initialSafeId =
    activeSafe?.id ??
    safes.find((safe) => safe.is_default)?.id ??
    safes[0]?.id ??
    null

  const [selectedSafeId, setSelectedSafeId] = useState<string | null>(initialSafeId)

  useEffect(() => {
    if (!open) return
    setSelectedSafeId(initialSafeId)
  }, [open, initialSafeId])

  const selectedSafe = safes.find((safe) => safe.id === selectedSafeId) ?? null
  const safeAddress = selectedSafe?.safe_address ?? null

  const {
    balances,
    loading: balancesLoading,
    error: balancesError,
  } = useBalances(safeAddress)
  const {
    details: safeDetails,
    loading: safeDetailsLoading,
    error: safeDetailsError,
  } = useSafeDetails(safeAddress)

  const safeOptions = useMemo(
    () =>
      safes.map((safe) => ({
        id: safe.id,
        name: safe.name,
        address: safe.safe_address,
        chainId: safe.chain_id,
        isDefault: safe.is_default,
      })),
    [safes],
  )

  if (!open || !selectedSafe) return null

  return (
    <SendModal
      open={open}
      onClose={onClose}
      safeAddress={selectedSafe.safe_address}
      safeName={selectedSafe.name}
      safeDetails={safeDetails}
      balances={balances}
      onSuccess={onSuccess}
      contacts={contacts}
      resolveAddress={resolveAddress}
      chainId={selectedSafe.chain_id}
      safeOptions={safeOptions}
      selectedSafeOptionId={selectedSafeId ?? undefined}
      onSelectSafeOption={(safeId) => setSelectedSafeId(safeId)}
      contextLoading={balancesLoading || safeDetailsLoading}
      contextError={balancesError ?? safeDetailsError}
    />
  )
}

'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useAuth } from '@/context/AuthContext'
import {
  api,
  type OwnerAlias,
  type OwnersResponse,
  type UpdateOwnerAliasResponse,
} from '@/lib/api'

interface OwnerDirectoryState {
  owners: OwnerAlias[]
  loading: boolean
  error: string | null
  partialFailure: boolean
  failedSafeIds: string[]
  getOwnerAlias: (address: string | null | undefined) => string | null
  getOwner: (address: string | null | undefined) => OwnerAlias | null
  refreshOwners: () => Promise<void>
  renameOwner: (ownerAddress: string, name: string) => Promise<void>
  clearOwner: (ownerAddress: string) => Promise<void>
}

const OwnerDirectoryContext = createContext<OwnerDirectoryState | null>(null)

function normalizeAddress(address: string | null | undefined): string | null {
  if (!address) return null
  return address.toLowerCase()
}

export function OwnerDirectoryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [owners, setOwners] = useState<OwnerAlias[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [partialFailure, setPartialFailure] = useState(false)
  const [failedSafeIds, setFailedSafeIds] = useState<string[]>([])

  const refreshOwners = useCallback(async () => {
    if (!user) {
      setOwners([])
      setError(null)
      setPartialFailure(false)
      setFailedSafeIds([])
      return
    }

    try {
      setLoading(true)
      setError(null)
      const response = await api.get<OwnersResponse>('/user/owners')
      setOwners(response.owners)
      setPartialFailure(response.partialFailure)
      setFailedSafeIds(response.failedSafeIds)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load account owners')
      setOwners([])
      setPartialFailure(false)
      setFailedSafeIds([])
    } finally {
      setLoading(false)
    }
  }, [user])

  // Use a stable string key derived from safe IDs rather than the `safes`
  // array reference itself. `setUser(newUserObj)` always creates a new array
  // reference even when the safes are unchanged, which would trigger an extra
  // `refreshOwners` call on every `refreshUser` invocation.
  const safeKey = user?.safes?.map((s) => s.id).join(',') ?? ''

  useEffect(() => {
    void refreshOwners()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshOwners, safeKey])

  const ownerByAddress = useMemo(() => {
    const map = new Map<string, OwnerAlias>()
    for (const owner of owners) {
      map.set(owner.owner_address.toLowerCase(), owner)
    }
    return map
  }, [owners])

  const getOwner = useCallback(
    (address: string | null | undefined) => {
      const normalized = normalizeAddress(address)
      return normalized ? ownerByAddress.get(normalized) ?? null : null
    },
    [ownerByAddress],
  )

  const getOwnerAlias = useCallback(
    (address: string | null | undefined) => getOwner(address)?.name ?? null,
    [getOwner],
  )

  const renameOwner = useCallback(async (ownerAddress: string, name: string) => {
    const result = await api.put<UpdateOwnerAliasResponse>(
      `/user/owners/${ownerAddress}`,
      { name },
    )
    setOwners((current) =>
      current.map((owner) =>
        owner.owner_address.toLowerCase() === result.owner_address.toLowerCase()
          ? { ...owner, name: result.name }
          : owner,
      ),
    )
  }, [])

  const clearOwner = useCallback(async (ownerAddress: string) => {
    await api.delete(`/user/owners/${ownerAddress}`)
    setOwners((current) =>
      current.map((owner) =>
        owner.owner_address.toLowerCase() === ownerAddress.toLowerCase()
          ? { ...owner, name: null }
          : owner,
      ),
    )
  }, [])

  return (
    <OwnerDirectoryContext.Provider
      value={{
        owners,
        loading,
        error,
        partialFailure,
        failedSafeIds,
        getOwnerAlias,
        getOwner,
        refreshOwners,
        renameOwner,
        clearOwner,
      }}
    >
      {children}
    </OwnerDirectoryContext.Provider>
  )
}

export function useOwnerDirectory(): OwnerDirectoryState {
  const ctx = useContext(OwnerDirectoryContext)
  if (!ctx) {
    throw new Error('useOwnerDirectory must be used within OwnerDirectoryProvider')
  }
  return ctx
}

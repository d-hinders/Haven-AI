'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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

  // Ref keeps refreshOwners stable across user-object reference changes.
  // Without this, any refreshUser() call (even when safe IDs are unchanged)
  // would recreate refreshOwners and trigger an extra /user/owners API call.
  const userRef = useRef(user)
  userRef.current = user

  // Generation counter prevents a slow response from an earlier call from
  // overwriting state written by a more-recent call.
  const genRef = useRef(0)

  const refreshOwners = useCallback(async () => {
    if (!userRef.current) {
      setOwners([])
      setError(null)
      setPartialFailure(false)
      setFailedSafeIds([])
      return
    }

    const gen = ++genRef.current

    try {
      setLoading(true)
      setError(null)
      const response = await api.get<OwnersResponse>('/user/owners')
      if (genRef.current !== gen) return
      setOwners(response.owners)
      setPartialFailure(response.partialFailure)
      setFailedSafeIds(response.failedSafeIds)
    } catch (err) {
      if (genRef.current !== gen) return
      setError(err instanceof Error ? err.message : 'Could not load account owners')
      setOwners([])
      setPartialFailure(false)
      setFailedSafeIds([])
    } finally {
      if (genRef.current === gen) setLoading(false)
    }
  }, []) // stable — reads user via ref, not as a closure dep

  // Refresh only when the set of safe IDs actually changes. refreshOwners is
  // stable (empty dep array), so this effect only re-fires on safeKey changes
  // and on mount — not on every refreshUser() call that creates a new user object.
  const safeKey = user?.safes?.map((s) => s.id).join(',') ?? ''

  useEffect(() => {
    void refreshOwners()
  }, [safeKey, refreshOwners])

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

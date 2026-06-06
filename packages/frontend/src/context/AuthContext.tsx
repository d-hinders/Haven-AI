'use client'

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react'
import { api, type ListPasskeysResponse } from '@/lib/api'
import { ACTIVE_SAFE_STORAGE_KEY, AUTH_TOKEN_STORAGE_KEY } from '@/lib/auth-storage'
import {
  PASSKEY_SCHEMA_VERSION,
  clearStoredPasskeySigner,
  hasPasskeyCredentialOnDevice,
  setStoredPasskeySigner,
} from '@/lib/signer'
import type { Address } from 'viem'

export interface UserSafe {
  id: string
  safe_address: string
  chain_id: number
  name: string
  is_default: boolean
  created_at: string
}

export interface User {
  id: string
  name: string | null
  email: string
  wallet_address: string | null
  safe_address: string | null
  safes: UserSafe[]
  currency_preference?: 'USD' | 'EUR'
  created_at?: string
}

interface AuthResponse {
  token: string
  user: User
}

interface AuthState {
  user: User | null
  token: string | null
  loading: boolean
  activeSafe: UserSafe | null
  passkeys: ListPasskeysResponse['passkeys']
  setActiveSafe: (safe: UserSafe) => void
  signup: (name: string, email: string, password: string) => Promise<User>
  login: (email: string, password: string) => Promise<User>
  logout: () => void
  updateUser: (partial: Partial<User>) => void
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

function resolveActiveSafe(safes: UserSafe[]): UserSafe | null {
  if (safes.length === 0) return null

  // Check localStorage for a previous selection
  const storedId = localStorage.getItem(ACTIVE_SAFE_STORAGE_KEY)
  if (storedId) {
    const found = safes.find((s) => s.id === storedId)
    if (found) return found
  }

  // Fall back to the default Safe, or the first one
  return safes.find((s) => s.is_default) ?? safes[0]
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeSafe, setActiveSafeState] = useState<UserSafe | null>(null)
  const [passkeys, setPasskeys] = useState<ListPasskeysResponse['passkeys']>([])

  const setActiveSafe = useCallback((safe: UserSafe) => {
    setActiveSafeState(safe)
    localStorage.setItem(ACTIVE_SAFE_STORAGE_KEY, safe.id)
  }, [])

  // Sync activeSafe when user changes (e.g., after refresh or safe add/remove)
  const syncActiveSafe = useCallback((u: User) => {
    const safes = u.safes ?? []
    setActiveSafeState((prev) => {
      // If the current active safe is still in the list, keep it
      if (prev && safes.find((s) => s.id === prev.id)) {
        // Update in case name changed
        return safes.find((s) => s.id === prev.id)!
      }
      return resolveActiveSafe(safes)
    })
  }, [])

  const hydratePasskeys = useCallback(async () => {
    try {
      const { passkeys: rows } = await api.listPasskeys()
      setPasskeys(rows)

      for (const passkey of rows) {
        if (
          !passkey.safe_address ||
          !hasPasskeyCredentialOnDevice(passkey.credential_id)
        ) {
          continue
        }

        setStoredPasskeySigner({
          schemaVersion: PASSKEY_SCHEMA_VERSION,
          address: passkey.signer_address as Address,
          credentialId: passkey.credential_id,
          chainId: passkey.chain_id,
          safeAddress: passkey.safe_address as Address,
          createdAt: Date.parse(passkey.created_at) || Date.now(),
        })
      }
    } catch {
      setPasskeys([])
    }
  }, [])

  const refreshUser = useCallback(async () => {
    try {
      const u = await api.get<User>('/auth/me')
      setUser(u)
      syncActiveSafe(u)
      await hydratePasskeys()
    } catch {
      // Silently fail — token might be invalid
    }
  }, [hydratePasskeys, syncActiveSafe])

  // On mount, check for existing token.
  // A cancelled ref guards against the effect re-running (e.g. in Strict Mode)
  // while an in-flight request is still pending — without it two overlapping
  // /auth/me calls could both call setUser/syncActiveSafe in an undefined order.
  useEffect(() => {
    let cancelled = false

    const stored = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
    if (!stored) {
      setLoading(false)
      return
    }

    setToken(stored)

    api
      .get<User>('/auth/me')
      .then(async (u) => {
        if (cancelled) return
        setUser(u)
        syncActiveSafe(u)
        await hydratePasskeys()
      })
      .catch(() => {
        if (cancelled) return
        // Token invalid or expired
        localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
        setToken(null)
        setPasskeys([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [hydratePasskeys, syncActiveSafe])

  const signup = useCallback(
    async (name: string, email: string, password: string): Promise<User> => {
      const res = await api.post<AuthResponse>('/auth/signup', {
        name,
        email,
        password,
      })
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, res.token)
      setToken(res.token)
      setUser(res.user)
      syncActiveSafe(res.user)
      await hydratePasskeys()
      return res.user
    },
    [hydratePasskeys, syncActiveSafe],
  )

  const login = useCallback(
    async (email: string, password: string): Promise<User> => {
      const res = await api.post<AuthResponse>('/auth/login', {
        email,
        password,
      })
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, res.token)
      setToken(res.token)
      setUser(res.user)
      syncActiveSafe(res.user)
      await hydratePasskeys()
      return res.user
    },
    [hydratePasskeys, syncActiveSafe],
  )

  const logout = useCallback(() => {
    const safes = user?.safes ?? []
    for (const safe of safes) {
      clearStoredPasskeySigner({
        safeAddress: safe.safe_address as Address,
        chainId: safe.chain_id,
      })
    }
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
    localStorage.removeItem(ACTIVE_SAFE_STORAGE_KEY)
    setToken(null)
    setUser(null)
    setPasskeys([])
    setActiveSafeState(null)
  }, [user?.safes])

  const updateUser = useCallback((partial: Partial<User>) => {
    setUser((prev) => (prev ? { ...prev, ...partial } : null))
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        activeSafe,
        passkeys,
        setActiveSafe,
        signup,
        login,
        logout,
        updateUser,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}

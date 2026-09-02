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
  setStoredHybridSigners,
  setStoredPasskeySigner,
  type HybridAccountSigners,
} from '@/lib/signer'
import type { Address } from 'viem'

export interface UserSafe {
  id: string
  safe_address: string
  chain_id: number
  name: string
  is_default: boolean
  created_at: string
  /**
   * Always 'delegator_hybrid' since #2413: the account-list queries filter the
   * retired Safe rail out, so no other value reaches the client. Kept on the
   * type because the column still holds legacy values in the database.
   */
  account_type?: string | null
  /**
   * #1205: server-computed by `needsBackupSignerRecommendation` — true when a
   * delegation-rail account holds real value with fewer than two enrolled
   * signers; null for non-delegation accounts (their signer truth is
   * on-chain); absent on an older backend (fall back to the local read).
   */
  needs_backup_recommendation?: boolean | null
  /** #1205: same single home for chain classification (testnets are false). */
  value_bearing_chain?: boolean
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

  // Takes the freshly-fetched user rather than reading state: it runs inside
  // refreshUser/login/signup BEFORE React commits setUser, so `user` state
  // would still be the stale previous value (#1079).
  const hydratePasskeys = useCallback(async (u: User) => {
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

    // #1079: hybrid DeleGator accounts keep their signer set in
    // hybrid_account_passkeys, invisible to GET /passkeys — resolve each
    // account's set so useActiveSigner can see it. Per-safe failures are
    // skipped silently, same as the loop above: the gate simply stays at
    // no_signer for that account until the next refresh.
    // #2413: every account the API returns is on the delegation rail, so the
    // filter that used to sit here selected all of them.
    await Promise.all(
      (u.safes ?? []).map(async (safe) => {
        try {
          const signers = await api.get<HybridAccountSigners>(
            `/accounts/hybrid/${safe.safe_address}/signers?chain_id=${safe.chain_id}`,
          )
          setStoredHybridSigners(signers)
        } catch {
          /* skipped silently — per-safe parity with the passkey loop */
        }
      }),
    )
  }, [])

  const refreshUser = useCallback(async () => {
    try {
      const u = await api.get<User>('/auth/me')
      setUser(u)
      syncActiveSafe(u)
      await hydratePasskeys(u)
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
        await hydratePasskeys(u)
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
      await hydratePasskeys(res.user)
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
      await hydratePasskeys(res.user)
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

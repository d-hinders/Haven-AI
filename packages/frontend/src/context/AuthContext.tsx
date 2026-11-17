'use client'

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react'
import {
  api,
  ApiRequestError,
  setSessionExpiredHandler,
  type ListPasskeysResponse,
} from '@/lib/api'
import { LEGACY_ACTIVE_ACCOUNT_STORAGE_KEY, AUTH_TOKEN_STORAGE_KEY } from '@/lib/auth-storage'
import { clearEntryLatches } from '@/lib/entry-latch'
import {
  PASSKEY_SCHEMA_VERSION,
  clearStoredPasskeySigner,
  hasPasskeyCredentialOnDevice,
  setStoredHybridSigners,
  setStoredPasskeySigner,
  type HybridAccountSigners,
} from '@/lib/signer'
import type { Address } from 'viem'

/**
 * The session user's linked account. Type name per #2913 (naming epic
 * #2906): the objects are MetaMask Hybrid DeleGator smart accounts, so the
 * type matches the `smart_accounts` table and the backend type.
 */
export interface SmartAccount {
  id: string
  account_address: string
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
  /**
   * #4719: server-computed — whether this deployment can issue this
   * account's agents a passport a merchant can verify. The passport opt-in is
   * shown only when this is exactly `true`; absent (an older backend) reads as
   * not issuable, so the gate fails closed.
   */
  passport_issuable?: boolean
}

export interface User {
  id: string
  name: string | null
  email: string
  wallet_address: string | null
  account_address: string | null
  /**
   * The list is read from the #2907 `accounts` envelope key, which is the
   * only one the backend emits: the `safes` twin went with #2914 on these
   * session payloads and with its follow-up everywhere else.
   */
  accounts: SmartAccount[]
  currency_preference?: 'USD' | 'EUR' | 'SEK'
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
  /**
   * #4827: the load-time `GET /auth/me` failed in a way that does NOT end the
   * session — a rejected `fetch`, a 5xx, a 429, a 2xx whose body is not JSON.
   * The token is still stored and the session is still valid; the READ just did
   * not happen. `ProtectedRoute` and `OnboardingClient` render a load-error page
   * with one Try again action instead of redirecting to `/login`, because
   * "signed out" and "read failed" are no longer the same state.
   */
  loadError: boolean
  /** Repeat the load-time `GET /auth/me` after a `loadError`. */
  retryLoad: () => void
  passkeys: ListPasskeysResponse['passkeys']
  signup: (name: string, email: string, password: string, via?: string | null) => Promise<User>
  login: (email: string, password: string) => Promise<User>
  logout: () => void
  updateUser: (partial: Partial<User>) => void
  refreshUser: () => Promise<void>
  /**
   * `refreshUser` that SAYS whether the re-read happened (#4024): true when
   * `/auth/me` answered and the user was replaced, false when it threw. The
   * New account dialog needs the difference — "no new account yet" is only
   * true after a read that succeeded. `refreshUser` keeps its swallow-everything
   * contract for every other caller.
   */
  reloadUser: () => Promise<boolean>
}

/**
 * #4827: which failures of the load-time `GET /auth/me` end the session.
 *
 * Owner decision 2026-11-12: a 401 (the token is not accepted) and a 404
 * `User not found` (the token is accepted but the account behind it is gone).
 * Everything else is a failed READ, not an ended session, and keeps the token —
 * a network failure, a 502 from a deploy and a 500 all used to sign the owner
 * out and throw away a valid session.
 */
function isSessionEndingError(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return false
  if (err.status === 401) return true
  return err.status === 404 && err.message === 'User not found'
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [passkeys, setPasskeys] = useState<ListPasskeysResponse['passkeys']>([])

  // #4827: guards a superseded load (a retry, or Strict Mode's double mount)
  // from writing state after a newer read has started.
  const loadGenerationRef = useRef(0)

  /**
   * #4827: one sign-out per ended session.
   *
   * The stored token is the latch: the first caller removes it, and every later
   * 401 for the same session finds it gone and does nothing. That is what keeps
   * two in-flight 401s — and the load-time read's own catch — to exactly one
   * `clearEntryLatches()` and one redirect.
   *
   * The effects are the load-time expiry's (`AuthContext.tsx:200-204`) plus
   * `setUser(null)`: the session is over, so the user goes with it. Stored
   * passkey signer pointers stay — they are device state, not session state.
   */
  const endSession = useCallback(() => {
    if (localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) === null) return
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
    // #4704: an expired session is a sign-out too — the next sign-in is an entrance.
    clearEntryLatches()
    setToken(null)
    setUser(null)
    // The session is over, so there is no failed read left to offer Try again
    // for: the route must redirect to `/login`, not sit on the load-error page.
    setLoadError(false)
    setPasskeys([])
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
          !passkey.account_address ||
          !hasPasskeyCredentialOnDevice(passkey.credential_id)
        ) {
          continue
        }

        setStoredPasskeySigner({
          schemaVersion: PASSKEY_SCHEMA_VERSION,
          address: passkey.signer_address as Address,
          credentialId: passkey.credential_id,
          chainId: passkey.chain_id,
          safeAddress: passkey.account_address as Address,
          createdAt: Date.parse(passkey.created_at) || Date.now(),
        })
      }
    } catch {
      setPasskeys([])
    }

    // #1079: hybrid DeleGator accounts keep their signer set in
    // hybrid_account_passkeys, invisible to GET /passkeys — resolve each
    // account's set so useActiveSigner can see it. Per-account failures are
    // skipped silently, same as the loop above: the gate simply stays at
    // no_signer for that account until the next refresh.
    // #2413: every account the API returns is on the delegation rail, so the
    // filter that used to sit here selected all of them.
    await Promise.all(
      (u.accounts ?? []).map(async (account) => {
        try {
          const signers = await api.get<HybridAccountSigners>(
            `/accounts/hybrid/${account.account_address}/signers?chain_id=${account.chain_id}`,
          )
          setStoredHybridSigners(signers)
        } catch {
          /* skipped silently — per-account parity with the passkey loop */
        }
      }),
    )
  }, [])

  const reloadUser = useCallback(async (): Promise<boolean> => {
    try {
      const u = await api.get<User>('/auth/me')
      setUser(u)
      await hydratePasskeys(u)
      return true
    } catch {
      return false
    }
  }, [hydratePasskeys])

  const refreshUser = useCallback(async () => {
    // Silently fail — token might be invalid
    await reloadUser()
  }, [reloadUser])

  /**
   * #4827: the load-time session read, repeatable by `retryLoad`.
   *
   * A failure is told apart from an ended session here: a 401 (and a 404
   * `User not found`) ends the session; anything else is a failed READ and
   * leaves the token, the entry latches and the session alone, surfacing
   * `loadError` so the route can offer Try again instead of a redirect.
   */
  const loadSession = useCallback(async () => {
    const generation = ++loadGenerationRef.current

    const stored = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
    if (!stored) {
      setLoading(false)
      return
    }

    setToken(stored)

    try {
      const u = await api.get<User>('/auth/me')
      if (loadGenerationRef.current !== generation) return
      setUser(u)
      await hydratePasskeys(u)
    } catch (err) {
      if (loadGenerationRef.current !== generation) return
      if (isSessionEndingError(err)) {
        // A 401 has already fired `endSession` from the API client; this call
        // is the no-op half of that pair, and the whole of the 404 half.
        endSession()
        return
      }
      setLoadError(true)
    } finally {
      if (loadGenerationRef.current === generation) setLoading(false)
    }
  }, [hydratePasskeys, endSession])

  // #4827: the API client's 401 reaction. Registered BEFORE the load effect so
  // the load-time `GET /auth/me` 401 lands on the same one sign-out path as
  // every other authenticated call.
  useEffect(() => {
    setSessionExpiredHandler(endSession)
    return () => setSessionExpiredHandler(null)
  }, [endSession])

  // On mount, check for existing token.
  // The generation guard replaces the old `cancelled` flag: it covers the
  // effect re-running (e.g. in Strict Mode) AND a retry superseding an
  // in-flight read, so two overlapping /auth/me calls cannot both setUser in
  // an undefined order.
  useEffect(() => {
    void loadSession()
    return () => {
      loadGenerationRef.current += 1
    }
  }, [loadSession])

  const retryLoad = useCallback(() => {
    setLoadError(false)
    setLoading(true)
    void loadSession()
  }, [loadSession])

  const signup = useCallback(
    // `via` is the #2522 agent hand-off marker. Optional and omitted when
    // absent rather than sent as null: the backend sanitises it to the enum
    // `agent` or null either way, and an absent field keeps the request shape
    // identical to what every existing caller sends.
    async (name: string, email: string, password: string, via?: string | null): Promise<User> => {
      const res = await api.post<AuthResponse>('/auth/signup', {
        name,
        email,
        password,
        ...(via ? { via } : {}),
      })
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, res.token)
      setToken(res.token)
      setUser(res.user)
      setLoadError(false)
      await hydratePasskeys(res.user)
      return res.user
    },
    [hydratePasskeys],
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
      setLoadError(false)
      await hydratePasskeys(res.user)
      return res.user
    },
    [hydratePasskeys],
  )

  const logout = useCallback(() => {
    const accounts = user?.accounts ?? []
    for (const account of accounts) {
      clearStoredPasskeySigner({
        accountAddress: account.account_address as Address,
        chainId: account.chain_id,
      })
    }
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
    // #3719 retired the global active account; the key is no longer written,
    // but a browser that ran an earlier build may still hold one.
    localStorage.removeItem(LEGACY_ACTIVE_ACCOUNT_STORAGE_KEY)
    // #4704: signing back in is an entrance again (the balance counts up).
    clearEntryLatches()
    setToken(null)
    setUser(null)
    setLoadError(false)
    setPasskeys([])
  }, [user?.accounts])

  const updateUser = useCallback((partial: Partial<User>) => {
    setUser((prev) => (prev ? { ...prev, ...partial } : null))
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        loadError,
        retryLoad,
        passkeys,
        signup,
        login,
        logout,
        updateUser,
        refreshUser,
        reloadUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

/**
 * The auth state, or `null` outside an `AuthProvider` — for a shared component
 * that only needs the user as an optional input (#4705: `ReceiveDialog`'s
 * first-money marker), so a host or a test without the provider still renders.
 */
export function useOptionalAuth(): AuthState | null {
  return useContext(AuthContext)
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}

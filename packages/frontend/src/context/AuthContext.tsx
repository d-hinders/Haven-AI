'use client'

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react'
import { api, ApiRequestError } from '@/lib/api'

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
  setActiveSafe: (safe: UserSafe) => void
  signup: (email: string, password: string) => Promise<User>
  login: (email: string, password: string) => Promise<User>
  logout: () => void
  updateUser: (partial: Partial<User>) => void
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

function resolveActiveSafe(safes: UserSafe[]): UserSafe | null {
  if (safes.length === 0) return null

  // Check localStorage for a previous selection
  const storedId = localStorage.getItem('haven_active_safe_id')
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

  const setActiveSafe = useCallback((safe: UserSafe) => {
    setActiveSafeState(safe)
    localStorage.setItem('haven_active_safe_id', safe.id)
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

  const refreshUser = useCallback(async () => {
    try {
      const u = await api.get<User>('/auth/me')
      setUser(u)
      syncActiveSafe(u)
    } catch {
      // Silently fail — token might be invalid
    }
  }, [syncActiveSafe])

  // On mount, check for existing token
  useEffect(() => {
    const stored = localStorage.getItem('haven_token')
    if (!stored) {
      setLoading(false)
      return
    }

    setToken(stored)

    api
      .get<User>('/auth/me')
      .then((u) => {
        setUser(u)
        syncActiveSafe(u)
      })
      .catch(() => {
        // Token invalid or expired
        localStorage.removeItem('haven_token')
        setToken(null)
      })
      .finally(() => setLoading(false))
  }, [syncActiveSafe])

  const signup = useCallback(
    async (email: string, password: string): Promise<User> => {
      const res = await api.post<AuthResponse>('/auth/signup', {
        email,
        password,
      })
      localStorage.setItem('haven_token', res.token)
      setToken(res.token)
      setUser(res.user)
      syncActiveSafe(res.user)
      return res.user
    },
    [syncActiveSafe],
  )

  const login = useCallback(
    async (email: string, password: string): Promise<User> => {
      const res = await api.post<AuthResponse>('/auth/login', {
        email,
        password,
      })
      localStorage.setItem('haven_token', res.token)
      setToken(res.token)
      setUser(res.user)
      syncActiveSafe(res.user)
      return res.user
    },
    [syncActiveSafe],
  )

  const logout = useCallback(() => {
    localStorage.removeItem('haven_token')
    localStorage.removeItem('haven_active_safe_id')
    setToken(null)
    setUser(null)
    setActiveSafeState(null)
  }, [])

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

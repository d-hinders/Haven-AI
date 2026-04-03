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

export interface User {
  id: string
  email: string
  wallet_address: string | null
  safe_address: string | null
  currency_preference?: 'USD' | 'EUR'
  created_at?: string
}

interface LoginResponse {
  token: string
  user: User
}

interface SignupResponse {
  id: string
  email: string
}

interface AuthState {
  user: User | null
  token: string | null
  loading: boolean
  signup: (email: string, password: string) => Promise<SignupResponse>
  login: (email: string, password: string) => Promise<User>
  logout: () => void
  updateUser: (partial: Partial<User>) => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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
      .then((u) => setUser(u))
      .catch(() => {
        // Token invalid or expired
        localStorage.removeItem('haven_token')
        setToken(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const signup = useCallback(
    async (email: string, password: string): Promise<SignupResponse> => {
      return api.post<SignupResponse>('/auth/signup', { email, password })
    },
    [],
  )

  const login = useCallback(
    async (email: string, password: string): Promise<User> => {
      const res = await api.post<LoginResponse>('/auth/login', {
        email,
        password,
      })
      localStorage.setItem('haven_token', res.token)
      setToken(res.token)
      setUser(res.user)
      return res.user
    },
    [],
  )

  const logout = useCallback(() => {
    localStorage.removeItem('haven_token')
    setToken(null)
    setUser(null)
  }, [])

  const updateUser = useCallback((partial: Partial<User>) => {
    setUser((prev) => (prev ? { ...prev, ...partial } : null))
  }, [])

  return (
    <AuthContext.Provider
      value={{ user, token, loading, signup, login, logout, updateUser }}
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

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import type {
  PortfolioResponse,
  BalancesResponse,
  BalanceItem,
  TransactionsResponse,
  Transaction,
} from '@/types/transactions'

/**
 * Stable stringified key for an array of Safes.
 * Used as a dependency in useEffect to avoid re-fetching unless safes actually change.
 */
interface SafeBalanceRef {
  address: string
  chainId: number
}

function useSafeAddressKey(): { addresses: string[]; balanceRefs: SafeBalanceRef[]; key: string } {
  const { user } = useAuth()
  const balanceRefs = (user?.safes ?? []).map((s) => ({
    address: s.safe_address,
    chainId: s.chain_id,
  }))
  const addresses = balanceRefs.map((safe) => safe.address)
  const key = balanceRefs
    .map((safe) => `${safe.address.toLowerCase()}:${safe.chainId}`)
    .join(',')
  return { addresses, balanceRefs, key }
}

// ── Aggregated Portfolio ────────────────────────────────────────────

interface AggregatedPortfolioReturn {
  totalUsd: number
  totalEur: number
  loading: boolean
  refetch: () => void
}

export function useAggregatedPortfolio(): AggregatedPortfolioReturn {
  const { balanceRefs, key } = useSafeAddressKey()
  const [totalUsd, setTotalUsd] = useState(0)
  const [totalEur, setTotalEur] = useState(0)
  const [loading, setLoading] = useState(true)
  const generationRef = useRef(0)

  // Keep Safe refs in a ref so refetch always uses current values
  const balanceRefsRef = useRef(balanceRefs)
  balanceRefsRef.current = balanceRefs

  const fetchAll = useCallback(async () => {
    const generation = ++generationRef.current
    const safes = balanceRefsRef.current
    if (safes.length === 0) {
      setTotalUsd(0)
      setTotalEur(0)
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      const results = await Promise.all(
        safes.map((safe) =>
          api.get<PortfolioResponse>(
            `/portfolio/${safe.address}?chain_id=${encodeURIComponent(String(safe.chainId))}`,
          ).catch(() => ({
            totalUsd: 0,
            totalEur: 0,
            breakdown: [],
          })),
        ),
      )

      let usd = 0
      let eur = 0
      for (const r of results) {
        usd += r.totalUsd
        eur += r.totalEur
      }

      if (generationRef.current === generation) {
        setTotalUsd(usd)
        setTotalEur(eur)
      }
    } finally {
      if (generationRef.current === generation) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (balanceRefs.length === 0) {
      generationRef.current += 1
      setTotalUsd(0)
      setTotalEur(0)
      setLoading(false)
      return
    }

    setLoading(true)
    fetchAll()
    const interval = setInterval(fetchAll, 60_000)
    return () => {
      generationRef.current += 1
      clearInterval(interval)
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  return { totalUsd, totalEur, loading, refetch: fetchAll }
}

// ── Aggregated Balances ─────────────────────────────────────────────

interface AggregatedBalancesReturn {
  balances: BalanceItem[]
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useAggregatedBalances(): AggregatedBalancesReturn {
  const { balanceRefs, key } = useSafeAddressKey()
  const [balances, setBalances] = useState<BalanceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)

  const balanceRefsRef = useRef(balanceRefs)
  balanceRefsRef.current = balanceRefs

  const fetchAll = useCallback(async () => {
    const generation = ++generationRef.current
    const safes = balanceRefsRef.current
    if (safes.length === 0) {
      setBalances([])
      setError(null)
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)
      const results = await Promise.all(
        safes.map(async (safe) => {
          try {
            const data = await api.get<BalancesResponse>(
              `/balances/${safe.address}?chain_id=${encodeURIComponent(String(safe.chainId))}`,
            )
            return { safe, balances: data.balances, error: null }
          } catch (err) {
            return { safe, balances: [], error: err }
          }
        }),
      )

      if (generationRef.current !== generation) return

      if (results.some((result) => result.error !== null)) {
        setBalances([])
        setError('Failed to load balances')
        return
      }

      const merged = new Map<string, BalanceItem>()
      for (const r of results) {
        for (const b of r.balances) {
          const balanceKey = balanceIdentityKey(b, r.safe.chainId)
          const existing = merged.get(balanceKey)
          if (existing) {
            const rawSum = BigInt(existing.balance) + BigInt(b.balance)
            merged.set(balanceKey, {
              ...existing,
              balance: rawSum.toString(),
              formatted: formatBalance(rawSum, existing.decimals),
            })
          } else {
            merged.set(balanceKey, { ...b, chainId: r.safe.chainId })
          }
        }
      }

      setBalances(Array.from(merged.values()))
    } catch (err) {
      if (generationRef.current === generation) {
        setError(err instanceof Error ? err.message : 'Failed to load balances')
      }
    } finally {
      if (generationRef.current === generation) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (balanceRefs.length === 0) {
      generationRef.current += 1
      setBalances([])
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    fetchAll()
    const interval = setInterval(fetchAll, 60_000)
    return () => {
      generationRef.current += 1
      clearInterval(interval)
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  return { balances, loading, error, refetch: fetchAll }
}

function balanceIdentityKey(balance: BalanceItem, chainId: number): string {
  const assetKey = balance.address === null
    ? 'native'
    : balance.address.toLowerCase()
  return `${chainId}:${assetKey}`
}

function formatBalance(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = raw / divisor
  const frac = raw % divisor
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : whole.toString()
}

// ── Aggregated Transactions ─────────────────────────────────────────

interface AggregatedTransactionsReturn {
  transactions: Transaction[]
  loading: boolean
  error: string | null
  total: number
  refetch: () => void
}

export function useAggregatedTransactions(limit = 10): AggregatedTransactionsReturn {
  const { addresses, key } = useSafeAddressKey()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)

  const addressesRef = useRef(addresses)
  addressesRef.current = addresses

  const fetchAll = useCallback(async () => {
    const addrs = addressesRef.current
    if (addrs.length === 0) return

    try {
      setError(null)

      const results = await Promise.all(
        addrs.map((addr) =>
          api
            .get<TransactionsResponse>(
              `/transactions/${addr}?page=1&limit=${limit}`,
            )
            .catch(() => ({ transactions: [], total: 0, page: 1, limit, pages: 0 })),
        ),
      )

      // Merge, deduplicate, sort by timestamp desc
      const all: Transaction[] = []
      let totalCount = 0
      const seen = new Set<string>()

      for (const r of results) {
        totalCount += r.total
        for (const tx of r.transactions) {
          const txKey = `${tx.hash}:${tx.type}:${tx.from}:${tx.to}`
          if (!seen.has(txKey)) {
            seen.add(txKey)
            all.push(tx)
          }
        }
      }

      all.sort((a, b) => b.timestamp - a.timestamp)

      setTransactions(all.slice(0, limit))
      setTotal(totalCount)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transactions')
    } finally {
      setLoading(false)
    }
  }, [limit])

  useEffect(() => {
    if (!key) {
      setLoading(false)
      return
    }

    setLoading(true)
    fetchAll()
    // Poll every 60s like the other aggregated hooks
    const interval = setInterval(fetchAll, 60_000)
    return () => clearInterval(interval)
  }, [key, fetchAll])

  return { transactions, loading, error, total, refetch: fetchAll }
}

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
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
 * Used as a dependency in useEffect to avoid re-fetching unless accounts actually change.
 */
interface AccountBalanceRef {
  address: string
  chainId: number
}

function useAccountAddressKey(): { addresses: string[]; balanceRefs: AccountBalanceRef[]; key: string } {
  const { user } = useAuth()
  const balanceRefs = (user?.accounts ?? []).map((s) => ({
    address: s.account_address,
    chainId: s.chain_id,
  }))
  const addresses = balanceRefs.map((account) => account.address)
  const key = balanceRefs
    .map((account) => `${account.address.toLowerCase()}:${account.chainId}`)
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
  const { balanceRefs, key } = useAccountAddressKey()
  const [totalUsd, setTotalUsd] = useState(0)
  const [totalEur, setTotalEur] = useState(0)
  const [loading, setLoading] = useState(true)
  const generationRef = useRef(0)

  // Keep account refs in a ref so refetch always uses current values
  const balanceRefsRef = useRef(balanceRefs)
  balanceRefsRef.current = balanceRefs

  const fetchAll = useCallback(async (silent = false) => {
    const generation = ++generationRef.current
    const accounts = balanceRefsRef.current
    if (accounts.length === 0) {
      setTotalUsd(0)
      setTotalEur(0)
      setLoading(false)
      return
    }

    try {
      // #2732: silent visible-poll ticks must not flash the skeleton.
      if (!silent) setLoading(true)
      const results = await Promise.all(
        accounts.map((account) =>
          api.get<PortfolioResponse>(
            `/portfolio/${account.address}?chain_id=${encodeURIComponent(String(account.chainId))}`,
          ).catch(() => null),
        ),
      )

      if (generationRef.current === generation) {
        // #2732: a silent tick with ANY failed account keeps the last good
        // totals — per-account failures fall back to zeros, and summing those
        // would visibly wipe the number mid-demo. Non-silent keeps the
        // existing zero-fallback behaviour.
        if (silent && results.some((r) => r === null)) return
        let usd = 0
        let eur = 0
        for (const r of results) {
          usd += r?.totalUsd ?? 0
          eur += r?.totalEur ?? 0
        }
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
    return () => {
      generationRef.current += 1
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  // #2732: the 60s interval moved into the shared visible-only policy — 10s
  // while visible, immediate fetch on return-to-visible, zero fetches while
  // hidden. Silent ticks never flip `loading` back on.
  useVisiblePolling(() => {
    void fetchAll(true)
  })

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
  const { balanceRefs, key } = useAccountAddressKey()
  const [balances, setBalances] = useState<BalanceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)

  const balanceRefsRef = useRef(balanceRefs)
  balanceRefsRef.current = balanceRefs

  const fetchAll = useCallback(async (silent = false) => {
    const generation = ++generationRef.current
    const accounts = balanceRefsRef.current
    if (accounts.length === 0) {
      setBalances([])
      setError(null)
      setLoading(false)
      return
    }

    try {
      // #2732: silent visible-poll ticks must not flash the skeleton, and
      // must not clear a visible error banner until they actually succeed.
      if (!silent) {
        setLoading(true)
        setError(null)
      }
      const results = await Promise.all(
        accounts.map(async (account) => {
          try {
            const data = await api.get<BalancesResponse>(
              `/balances/${account.address}?chain_id=${encodeURIComponent(String(account.chainId))}`,
            )
            return { account, balances: data.balances, error: null }
          } catch (err) {
            return { account, balances: [], error: err }
          }
        }),
      )

      if (generationRef.current !== generation) return

      if (results.some((result) => result.error !== null)) {
        // A failed silent tick keeps the last good balances and any visible
        // error exactly as it was — this per-account failure class must not
        // wipe the row the presenter is pointing at (#2732).
        if (silent) return
        setBalances([])
        setError('Failed to load balances')
        return
      }

      const merged = new Map<string, BalanceItem>()
      for (const r of results) {
        for (const b of r.balances) {
          const balanceKey = balanceIdentityKey(b, r.account.chainId)
          const existing = merged.get(balanceKey)
          if (existing) {
            const rawSum = BigInt(existing.balance) + BigInt(b.balance)
            merged.set(balanceKey, {
              ...existing,
              balance: rawSum.toString(),
              formatted: formatBalance(rawSum, existing.decimals),
            })
          } else {
            merged.set(balanceKey, { ...b, chainId: r.account.chainId })
          }
        }
      }

      setBalances(Array.from(merged.values()))
      if (silent) setError(null)
    } catch (err) {
      if (generationRef.current === generation && !silent) {
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
    return () => {
      generationRef.current += 1
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  // #2732: the 60s interval moved into the shared visible-only policy — 10s
  // while visible, immediate fetch on return-to-visible, zero fetches while
  // hidden. Silent ticks never flip `loading` back on.
  useVisiblePolling(() => {
    void fetchAll(true)
  })

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
  const { balanceRefs, key } = useAccountAddressKey()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const generationRef = useRef(0)

  const balanceRefsRef = useRef(balanceRefs)
  balanceRefsRef.current = balanceRefs

  const fetchAll = useCallback(async (silent = false) => {
    const generation = ++generationRef.current
    const accounts = balanceRefsRef.current
    if (accounts.length === 0) {
      setTransactions([])
      setTotal(0)
      setError(null)
      setLoading(false)
      return
    }

    try {
      // #2732: silent visible-poll ticks must not flash the skeleton, and
      // must not clear a visible error banner until they actually succeed.
      if (!silent) {
        setLoading(true)
        setError(null)
      }

      const results = await Promise.all(
        accounts.map(async (account) => {
          try {
            const data = await api.get<TransactionsResponse>(
              `/transactions/${account.address}?page=1&limit=${limit}&chain_id=${encodeURIComponent(String(account.chainId))}`,
            )
            return { account, data, error: null }
          } catch (err) {
            return { account, data: null, error: err }
          }
        }),
      )

      if (generationRef.current !== generation) return

      if (results.some((result) => result.error !== null)) {
        // A failed silent tick keeps the last good transactions and any
        // visible error exactly as it was (#2732).
        if (silent) return
        setTransactions([])
        setTotal(0)
        setError('Failed to load transactions')
        return
      }

      // Merge, deduplicate, sort by timestamp desc
      const all: Transaction[] = []
      let totalCount = 0
      const seen = new Set<string>()

      for (const { account, data } of results) {
        if (!data) continue
        totalCount += data.total
        for (const tx of data.transactions) {
          const txKey = transactionIdentityKey(tx, account.chainId)
          if (!seen.has(txKey)) {
            seen.add(txKey)
            all.push(tx)
          }
        }
      }

      all.sort((a, b) => b.timestamp - a.timestamp)

      setTransactions(all.slice(0, limit))
      setTotal(totalCount)
      if (silent) setError(null)
    } catch (err) {
      if (generationRef.current === generation && !silent) {
        setError(err instanceof Error ? err.message : 'Failed to load transactions')
      }
    } finally {
      if (generationRef.current === generation) {
        setLoading(false)
      }
    }
  }, [limit])

  useEffect(() => {
    if (balanceRefs.length === 0) {
      generationRef.current += 1
      setTransactions([])
      setTotal(0)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    fetchAll()
    return () => {
      generationRef.current += 1
    }
  }, [key, fetchAll])

  // #2732: the 60s interval moved into the shared visible-only policy — 10s
  // while visible, immediate fetch on return-to-visible, zero fetches while
  // hidden. Silent ticks never flip `loading` back on.
  useVisiblePolling(() => {
    void fetchAll(true)
  })

  return { transactions, loading, error, total, refetch: fetchAll }
}

function transactionIdentityKey(tx: Transaction, chainId: number): string {
  return [
    chainId,
    tx.hash.toLowerCase(),
    tx.type,
    tx.from.toLowerCase(),
    tx.to.toLowerCase(),
    tx.value,
    tx.tokenAddress?.toLowerCase() ?? 'native',
  ].join(':')
}

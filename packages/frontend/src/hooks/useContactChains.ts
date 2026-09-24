'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import type { TransactionsResponse } from '@/types/transactions'

/**
 * Chains a contact has *seen activity* on (#634, epic #625).
 *
 * Contacts are chain-agnostic — an EVM address is the same on every chain — so
 * rather than tagging a contact with one chain we surface the chains the user
 * has actually transacted with that address on, derived client-side from each
 * account's recent transactions. The active-chain switch never hides contacts; this
 * only feeds the "Used on" badges and the optional chain filter.
 *
 * Returns a map of `address (lowercased) → sorted chain ids`.
 */
export function useContactChains(perAccountLimit = 100): {
  chainsByAddress: Map<string, number[]>
  loading: boolean
} {
  const { user } = useAuth()
  const accounts = user?.accounts ?? []
  // Re-derive when the set of (address, chain) pairs changes.
  const key = accounts
    .map((s) => `${s.account_address.toLowerCase()}:${s.chain_id}`)
    .sort()
    .join('|')

  const [chainsByAddress, setChainsByAddress] = useState<Map<string, number[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const generationRef = useRef(0)
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts

  const fetchAll = useCallback(async () => {
    const generation = ++generationRef.current
    const current = accountsRef.current
    if (current.length === 0) {
      setChainsByAddress(new Map())
      setLoading(false)
      return
    }

    setLoading(true)
    const acc = new Map<string, Set<number>>()
    await Promise.all(
      current.map(async (account) => {
        try {
          const data = await api.get<TransactionsResponse>(
            `/transactions/${account.account_address}?page=1&limit=${perAccountLimit}&chain_id=${encodeURIComponent(
              String(account.chain_id),
            )}`,
          )
          for (const tx of data.transactions) {
            const counterparty = (tx.direction === 'out' ? tx.to : tx.from)?.toLowerCase()
            if (!counterparty) continue
            const set = acc.get(counterparty) ?? new Set<number>()
            set.add(account.chain_id)
            acc.set(counterparty, set)
          }
        } catch {
          // A single account's failure shouldn't blank the others — partial
          // activity is still a useful signal.
        }
      }),
    )

    if (generationRef.current !== generation) return
    const sorted = new Map<string, number[]>()
    for (const [addr, set] of acc) {
      sorted.set(addr, Array.from(set).sort((a, b) => a - b))
    }
    setChainsByAddress(sorted)
    setLoading(false)
  }, [perAccountLimit])

  useEffect(() => {
    void fetchAll()
  }, [key, fetchAll])

  return { chainsByAddress, loading }
}

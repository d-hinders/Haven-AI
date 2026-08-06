'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import {
  DEFAULT_CHAIN_ID,
  SUPPORTED_CHAINS,
  getChainConfig,
  type FrontendChainConfig,
} from '@/lib/chains'

/**
 * Active-chain selector (#632, epic #625).
 *
 * The **active chain** is the chain of the user's currently-active account
 * (`AuthContext.activeSafe`); before any account exists it falls back to
 * `DEFAULT_CHAIN_ID`. Surfaces read it to drive their *default* chain scope.
 *
 * Two patterns, chosen per surface (see `useChainScope`):
 *  - `follow-active` — default = the active chain; re-defaults when the active
 *    chain switches (Catalog, Transactions, Dashboard balances).
 *  - `all-chains` — default = every chain; the active chain never hides anything,
 *    it only feeds an optional filter the user opts into (Contacts, Accounts).
 */

/** The id of the active chain (the active account's chain, or the default). */
export function useActiveChainId(): number {
  const { activeSafe } = useAuth()
  return activeSafe?.chain_id ?? DEFAULT_CHAIN_ID
}

/** The full config of the active chain. */
export function useActiveChain(): FrontendChainConfig {
  const chainId = useActiveChainId()
  try {
    return getChainConfig(chainId)
  } catch {
    // Active account on a chain we have no config for — fall back so the UI
    // never crashes (mirrors the registry's "render without crashing" intent).
    return getChainConfig(DEFAULT_CHAIN_ID)
  }
}

/** A surface's chain scope: a specific chain id, or every chain. */
export type ChainScope = number | 'all'

/** How a surface reacts to the active chain. */
export type ChainScopePattern = 'follow-active' | 'all-chains'

export interface ChainScopeState {
  /** The scope to fetch / render at right now. */
  scope: ChainScope
  /** User override (dropdown / filter control). */
  setScope: (scope: ChainScope) => void
  /** The current active chain — for labelling the default option. */
  activeChainId: number
  /** Chains offered in the override control. */
  chains: FrontendChainConfig[]
}

/** True when an item on `chainId` is visible under `scope`. */
export function inScope(chainId: number, scope: ChainScope): boolean {
  return scope === 'all' || chainId === scope
}

/**
 * Default chain scope for a surface, reacting to the active chain per `pattern`.
 *
 * `follow-active` initialises to the active chain and **re-defaults** to it
 * whenever the active chain switches — dropping any manual override, so flipping
 * the active account to Base Sepolia makes Catalog show Sepolia again. `all-chains`
 * initialises to `'all'` and never auto-resets; switching the active chain leaves
 * the surface showing everything, and `setScope` is an optional manual filter.
 */
export function useChainScope(pattern: ChainScopePattern): ChainScopeState {
  const activeChainId = useActiveChainId()
  const [scope, setScope] = useState<ChainScope>(
    pattern === 'follow-active' ? activeChainId : 'all',
  )

  useEffect(() => {
    if (pattern === 'follow-active') setScope(activeChainId)
  }, [pattern, activeChainId])

  return { scope, setScope, activeChainId, chains: SUPPORTED_CHAINS }
}

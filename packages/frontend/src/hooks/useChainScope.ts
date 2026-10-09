'use client'

import { useState } from 'react'
import { SUPPORTED_CHAINS, type FrontendChainConfig } from '@/lib/chains'

/**
 * A surface's network filter (#632, epic #625; #3719).
 *
 * Every chain-aware list starts on **all chains**, and the chain filter is
 * something the user opts into. Haven has no global active account (#3719),
 * so there is no active chain for a surface to follow: an item names its own
 * chain, and nothing is hidden because of a choice made elsewhere in the app.
 */

/** A surface's chain scope: a specific chain id, or every chain. */
export type ChainScope = number | 'all'

export interface ChainScopeState {
  /** The scope to fetch / render at right now. */
  scope: ChainScope
  /** User override (dropdown / filter control). */
  setScope: (scope: ChainScope) => void
  /** Chains offered in the override control. */
  chains: FrontendChainConfig[]
}

/** True when an item on `chainId` is visible under `scope`. */
export function inScope(chainId: number, scope: ChainScope): boolean {
  return scope === 'all' || chainId === scope
}

/** Chain scope for a surface: starts at `'all'`; `setScope` is the opt-in filter. */
export function useChainScope(): ChainScopeState {
  const [scope, setScope] = useState<ChainScope>('all')
  return { scope, setScope, chains: SUPPORTED_CHAINS }
}

/**
 * Frontend chain configuration — client construction over the shared registry.
 *
 * The per-chain FACTS (identity, explorer/Safe URLs, contracts, passkey,
 * token data) live in `@haven_ai/core` (#986) — ONE definition shared with
 * the backend. This module adds what only the frontend owns: viem chain
 * objects, the offered-chains policy (pickers), the build-time default
 * chain, and the frontend's token Record representation (keyed by display
 * symbol, in picker order).
 *
 * Purity proof: `__tests__/chains-registry-snapshot.test.ts` pins the fully
 * resolved registry byte-for-byte against the pre-move fixture.
 */
import type { Address } from 'viem'
import { gnosis, base, baseSepolia } from 'viem/chains'
import { getChainData, resolveToken } from '@haven_ai/core'

// Re-export viem chain objects for convenience
export { gnosis, base, baseSepolia }

// ── Types ─────────────────────────────────────────────────────────

export interface FrontendTokenConfig {
  symbol: string
  decimals: number
  address: Address | null // null = native token
}

export interface FrontendChainConfig {
  chainId: number
  name: string
  shortName: string
  viemChain: typeof gnosis | typeof base | typeof baseSepolia
  explorerUrl: string
  safeTxServiceUrl: string
  contracts: {
    safeProxyFactory: Address
    safeSingletonL2: Address
    fallbackHandler: Address
    allowanceModule: Address
    multiSendCallOnly: Address
  }
  passkey: {
    /** P-256 verifier the Safe passkey signer will call. */
    verifier: Address
  }
  tokens: Record<string, FrontendTokenConfig>
}

// ── Construction from the shared registry ─────────────────────────

/**
 * Frontend-owned per-chain layer: the viem client object and the token
 * PICKER ORDER (differs from the backend's native-first API order — e.g.
 * Base lists USDC before ETH in pickers). Values come from core.
 */
const FRONTEND_CHAIN_LAYER: Record<number, { viemChain: FrontendChainConfig['viemChain']; tokenOrder: string[] }> = {
  100: { viemChain: gnosis, tokenOrder: ['xDAI', 'EURe', 'USDC.e'] },
  8453: { viemChain: base, tokenOrder: ['USDC', 'ETH'] },
  84532: { viemChain: baseSepolia, tokenOrder: ['USDC', 'ETH'] },
}

function buildFrontendChain(chainId: number): FrontendChainConfig {
  const core = getChainData(chainId)
  const layer = FRONTEND_CHAIN_LAYER[chainId]
  const tokens: Record<string, FrontendTokenConfig> = {}
  for (const symbol of layer.tokenOrder) {
    const token = resolveToken(chainId, symbol)
    if (!token) throw new Error(`chains: token ${symbol} missing from the shared registry for chain ${chainId}`)
    tokens[symbol] = { symbol: token.symbol, decimals: token.decimals, address: token.address as Address | null }
  }
  return {
    chainId: core.chainId,
    name: core.name,
    shortName: core.shortName,
    viemChain: layer.viemChain,
    explorerUrl: core.explorerUrl,
    safeTxServiceUrl: core.safeTxServiceUrl,
    contracts: core.contracts as FrontendChainConfig['contracts'],
    passkey: { verifier: core.passkey.verifier as Address },
    tokens,
  }
}

// ── Registry ──────────────────────────────────────────────────────

/**
 * Full registry of every chain Haven *knows about*. `getChainConfig` reads
 * from here, so data created on any of these chains (e.g. a Safe a user
 * imported on Gnosis before we went Base-only) still renders without
 * crashing.
 */
const CHAINS: Record<number, FrontendChainConfig> = Object.fromEntries(
  Object.keys(FRONTEND_CHAIN_LAYER).map((id) => [Number(id), buildFrontendChain(Number(id))]),
)

const BASE_CONFIG = CHAINS[8453]
const BASE_SEPOLIA_CONFIG = CHAINS[84532]

/**
 * Every chain in the registry — including ones no longer *offered* in pickers
 * (e.g. Gnosis). Surfaces that display historical data across chains (catalog,
 * contacts, transactions) resolve against this, not the offered subset.
 */
export const ALL_CHAINS: FrontendChainConfig[] = Object.values(CHAINS)

/**
 * Chains currently *offered to users* — network pickers, wallet
 * network-validation, and the wagmi connector list all derive from this.
 *
 * Multichain: both **Base mainnet (8453)** and **Base Sepolia (84532)** are
 * selectable in every environment (network pickers, account creation, etc.).
 * `NEXT_PUBLIC_HAVEN_CHAIN_ID` (build-time inlined, like `NEXT_PUBLIC_HAVEN_ENV`)
 * sets the **default pre-selection** — the dev Vercel deploy sets `84532` so dev
 * defaults to Base Sepolia; prod leaves it unset and defaults to Base mainnet.
 * Both chains stay enabled regardless of the default.
 *
 * Note: each enabled chain needs a relayer funded on that chain for deploys /
 * payments to succeed (Base Sepolia gas on the testnet relayer, Base mainnet gas
 * on the mainnet relayer).
 */
const CONFIGURED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_HAVEN_CHAIN_ID ?? '')
const ACTIVE_CHAIN: FrontendChainConfig = CHAINS[CONFIGURED_CHAIN_ID] ?? BASE_CONFIG

const ENABLED_CHAIN_IDS: number[] = [BASE_CONFIG.chainId, BASE_SEPOLIA_CONFIG.chainId]

// `DELEGATION_ONBOARDING_CHAIN_IDS` lived here — the set of chains on which
// delegation-rail onboarding could serve, ANDed with
// `NEXT_PUBLIC_DELEGATION_ONBOARDING` to pick between the Hybrid flow and a
// Safe deploy. #1984 retires the Safe rail: onboarding is Hybrid on every
// supported chain, so both the flag and the set are gone. The set was exactly
// `ENABLED_CHAIN_IDS`, which is what the network picker already offers, so
// nothing narrowed. The backend's `DELEGATION_RAIL_CHAIN_IDS`
// (rails/delegation-contracts.ts) remains the authority on where the rail
// actually serves.

export const SUPPORTED_CHAINS = ENABLED_CHAIN_IDS.map((id) => CHAINS[id])
export const SUPPORTED_CHAIN_IDS = ENABLED_CHAIN_IDS
export const DEFAULT_CHAIN_ID = ACTIVE_CHAIN.chainId

export function getChainConfig(chainId: number): FrontendChainConfig {
  const chain = CHAINS[chainId]
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}`)
  }
  return chain
}

/**
 * The chain config, or `null` — never a guess, and never a throw.
 *
 * `getChainConfig` above throws, and that is deliberate: ~20 call sites treat an
 * unknown chain as a programming error and want the loud failure. This is the
 * total companion for the few surfaces that must *degrade* instead — funding
 * screens, where the honest answer to "which network?" is sometimes "we don't
 * know", and where taking the screen down through the error boundary is worse
 * than saying so.
 *
 * It answers BOTH shapes of unresolved identically, which is the whole point:
 * a `chainId` that is **absent**, and one that is **present but unregistered**
 * (a chain the API serves before the frontend registry catches up). Callers that
 * test only `chainId != null` cover one and crash on the other.
 *
 * Introduced local to `AddFundsModal` by #1844; lifted here by #1852 when
 * `ReceiveFundsModal` needed the same answer. Lifting the WRAPPER is not the
 * decision that was rejected in #1844 — that was making `getChainConfig` itself
 * total, which would silently change those ~20 call sites. This adds a second,
 * explicitly-opted-into function and leaves the throwing contract untouched.
 */
export function resolveChainOrNull(chainId?: number | null): FrontendChainConfig | null {
  if (chainId == null) return null
  return CHAINS[chainId] ?? null
}

export function getExplorerUrl(
  chainId: number,
  type: 'tx' | 'address',
  hash: string,
): string {
  const chain = getChainConfig(chainId)
  return `${chain.explorerUrl}/${type}/${hash}`
}

export function getTokensForChain(chainId: number): Record<string, FrontendTokenConfig> {
  return getChainConfig(chainId).tokens
}

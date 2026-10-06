/**
 * Backend chain configuration — environment wiring over the shared registry.
 *
 * The per-chain FACTS (identity, explorer URLs, passkey, token data) live in
 * `@haven_ai/core` (#986) — ONE definition shared with the backend. This
 * module adds what only the backend knows: explorer API credentials from `config.ts`, the explorer API provider
 * selection, and the backend's token Record representation (keyed
 * `USDCE`-style, native first — the balances API iterates in this order).
 *
 * Purity proof: `__tests__/chains-registry-snapshot.test.ts` pins the fully
 * resolved registry byte-for-byte against the pre-move fixture.
 */
import { config } from '../config.js'
import {
  CHAIN_REGISTRY,
  getChainData,
  type CoreChainConfig,
  type CoreTokenConfig,
} from '@haven_ai/core'

// ── Types ─────────────────────────────────────────────────────────

export interface TokenConfig {
  symbol: string
  decimals: number
  address: string | null // null = native token
  coingeckoId: string
}

export type ExplorerApiProvider = 'etherscan-v2' | 'blockscout-v1' | 'blockscout-v2'

export interface ChainConfig {
  chainId: number
  name: string
  shortName: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  explorerUrl: string        // e.g. https://gnosisscan.io
  explorerApiUrl: string     // e.g. https://api.etherscan.io/v2/api
  explorerApiKey: string     // empty allowed for Blockscout
  explorerApiProvider: ExplorerApiProvider
  passkey: {
    /** P-256 verifier the Safe passkey signer will call. */
    verifier: string
    /** SafeWebAuthnSignerFactory deployment for this chain. */
    factoryAddress: string
  }
  tokens: Record<string, TokenConfig>
  /** Reverse lookup: lowercase contract address → TokenConfig */
  tokenByAddress: Record<string, TokenConfig>
}

// ── Backend-only environment wiring per chain ─────────────────────
//
// Explorer API access is an environment concern (config.ts), and
// the explorer API provider choice is a backend integration detail:
// Blockscout v2 is used for Base because the v1 tokentx endpoint consistently
// times out (HTTP 524) on Base, and Etherscan V2 requires a paid plan.

interface BackendChainEnv {
  explorerApiUrl: string
  explorerApiKey: string
  explorerApiProvider: ExplorerApiProvider
}

const CHAIN_ENV: Record<number, BackendChainEnv> = {
  100: {
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    explorerApiKey: config.gnosisscanApiKey,
    explorerApiProvider: 'etherscan-v2',
  },
  8453: {
    explorerApiUrl: 'https://base.blockscout.com/api/v2',
    explorerApiKey: '',
    explorerApiProvider: 'blockscout-v2',
  },
  84532: {
    explorerApiUrl: 'https://base-sepolia.blockscout.com/api/v2',
    explorerApiKey: '',
    explorerApiProvider: 'blockscout-v2',
  },
}

/**
 * RPC wiring is SUPPORTED-chains only (#3671). Chain 100 (Gnosis) is known for
 * history and has no RPC read path, so it is deliberately absent here.
 */
const SUPPORTED_RPC_URLS: Record<number, string> = {
  8453: config.rpcUrlBase,
  84532: config.rpcUrlBaseSepolia,
}

// ── Construction from the shared registry ─────────────────────────

/** Backend token-record key: display symbol upper-cased, dots stripped ('USDC.e' → 'USDCE'). */
function backendTokenKey(symbol: string): string {
  return symbol.replace(/\./g, '').toUpperCase()
}

function toTokenConfig(token: CoreTokenConfig): TokenConfig {
  return {
    symbol: token.symbol,
    decimals: token.decimals,
    address: token.address,
    coingeckoId: token.coingeckoId,
  }
}

function buildChainConfig(core: CoreChainConfig): ChainConfig {
  const env = CHAIN_ENV[core.chainId]
  if (!env) {
    throw new Error(`chains: no backend environment wiring for chain ${core.chainId}`)
  }
  const tokens: Record<string, TokenConfig> = {}
  for (const token of core.tokens) {
    tokens[backendTokenKey(token.symbol)] = toTokenConfig(token)
  }
  return {
    chainId: core.chainId,
    name: core.name,
    shortName: core.shortName,
    nativeCurrency: core.nativeCurrency,
    explorerUrl: core.explorerUrl,
    explorerApiUrl: env.explorerApiUrl,
    explorerApiKey: env.explorerApiKey,
    explorerApiProvider: env.explorerApiProvider,
    passkey: core.passkey,
    tokens,
    tokenByAddress: buildTokenByAddress(tokens),
  }
}

// ── Registry ──────────────────────────────────────────────────────

const CHAINS: Record<number, ChainConfig> = Object.fromEntries(
  Object.values(CHAIN_REGISTRY).map((core) => [core.chainId, buildChainConfig(core)]),
)

/**
 * Every chain whose FACTS Haven can resolve — the KNOWN set. It includes
 * history-only chains (Gnosis, 100), so persisted rows, explorer links and the
 * explorer history read keep resolving through `getChain`.
 */
export const KNOWN_CHAIN_IDS: readonly number[] = Object.keys(CHAINS).map(Number)

/**
 * The chains Haven RUNS on — explicit, not derived from the registry keys
 * (decision (c), #3635; epic #3634). Chain 100 (Gnosis) is known but
 * history-only and read-only: it is deliberately absent here. The runtime loops
 * (prices, relayer monitor, the bump loop via deploys) and discovery skip it,
 * and balances, portfolio, receive and the delegate-balance read refuse it.
 * Payments and budget grants refuse it upstream, through the retired-rail 410
 * and `DELEGATION_RAIL_CHAIN_IDS`. Lives in the backend
 * (not core) because core's registry is also the frontend's known set (#3671).
 */
export const SUPPORTED_CHAIN_IDS: readonly number[] = [8453, 84532]

for (const id of SUPPORTED_CHAIN_IDS) {
  if (!CHAINS[id]) {
    throw new Error(`chains: supported chain ${id} is not in the known registry`)
  }
}

/** Known to the registry (history may render) — NOT necessarily supported. */
export function isKnownChain(chainId: number): boolean {
  return Object.prototype.hasOwnProperty.call(CHAINS, chainId)
}

export function getChain(chainId: number): ChainConfig {
  const chain = CHAINS[chainId]
  if (!chain) {
    // Same message shape as before the #986 move — callers surface it.
    getChainData(chainId)
    throw new Error(`Unsupported chain: ${chainId}`)
  }
  return chain
}

/**
 * The receive side's settlement asset on a chain: the registry's USDC asset,
 * resolved by the token's own registry data, never by a symbol string. The
 * dot-stripped symbol test this replaces (`symbol.replace('.', '') === 'USDC'`)
 * silently excluded Gnosis's bridged USDC — registry symbol 'USDC.e' — so
 * every inbound Gnosis leg was skipped and `usdcAddressForChain(100)` was null
 * (#3333 round-2 finding F-1). The registry marks the USDC asset on every
 * chain with the same CoinGecko id — native USDC on Base, bridged USDC.e on
 * Gnosis — which is exactly the "settlement asset" predicate; EURe
 * ('monerium-eur-money') and the native tokens never match. Undefined when
 * the chain carries no USDC asset.
 */
export function settlementTokenForChain(chainId: number): TokenConfig | undefined {
  const chain = getChain(chainId)
  return Object.values(chain.tokens).find(
    (candidate) => candidate.address !== null && candidate.coingeckoId === 'usd-coin',
  )
}

export function getExplorerUrl(
  chainId: number,
  type: 'tx' | 'address',
  hash: string,
): string {
  const chain = getChain(chainId)
  return `${chain.explorerUrl}/${type}/${hash}`
}

export function isSupportedChain(chainId: number): boolean {
  return SUPPORTED_CHAIN_IDS.includes(chainId)
}

/**
 * The configured (dedicated) RPC URL for a SUPPORTED chain. A known but
 * history-only chain (Gnosis, 100) and an unknown id both throw: no code path
 * may open an RPC connection to a chain Haven no longer runs on (#3671,
 * decision (c) of #3635).
 */
export function rpcUrlForChain(chainId: number): string {
  if (!isSupportedChain(chainId)) {
    throw new Error(`Unsupported chain for RPC: ${chainId}`)
  }
  return SUPPORTED_RPC_URLS[chainId]
}

/**
 * Whether this environment actually serves account **deploys** on a chain (#679).
 * A chain can be in the registry (renders historical data) yet not be served for
 * new deploys here — e.g. the dev backend serves only Base Sepolia. Driven by
 * `config.deployChainIds`; an empty list means "all supported" (backward-compat).
 */
export function isDeployableChain(chainId: number): boolean {
  if (!isSupportedChain(chainId)) return false
  const allow = config.deployChainIds
  return allow.length === 0 || allow.includes(chainId)
}

/** The chains this environment serves deploys on — for the frontend picker. */
export function deployableChainIds(): number[] {
  const allow = config.deployChainIds
  return allow.length === 0 ? [...SUPPORTED_CHAIN_IDS] : allow.filter(isSupportedChain)
}

// ── Helpers ───────────────────────────────────────────────────────

function buildTokenByAddress(
  tokens: Record<string, TokenConfig>,
): Record<string, TokenConfig> {
  const map: Record<string, TokenConfig> = {}
  for (const token of Object.values(tokens)) {
    if (token.address) {
      map[token.address.toLowerCase()] = token
    }
  }
  return map
}

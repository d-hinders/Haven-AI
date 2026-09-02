/**
 * Backend chain configuration — environment wiring over the shared registry.
 *
 * The per-chain FACTS (identity, explorer/Safe URLs, contracts, passkey,
 * token data) live in `@haven_ai/core` (#986) — ONE definition shared with
 * the frontend. This module adds what only the backend knows: RPC URLs and
 * explorer API credentials from `config.ts`, the explorer API provider
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
  isRegisteredChain,
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
  rpcUrl: string
  explorerUrl: string        // e.g. https://gnosisscan.io
  explorerApiUrl: string     // e.g. https://api.etherscan.io/v2/api
  explorerApiKey: string     // empty allowed for Blockscout
  explorerApiProvider: ExplorerApiProvider
  safeTxServiceUrl: string   // e.g. https://api.safe.global/tx-service/gno
  contracts: {
    safeProxyFactory: string
    safeSingletonL2: string
    fallbackHandler: string
    multiSendCallOnly: string
  }
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
// RPC URLs and explorer API access are environment concerns (config.ts), and
// the explorer API provider choice is a backend integration detail:
// Blockscout v2 is used for Base because the v1 tokentx endpoint consistently
// times out (HTTP 524) on Base, and Etherscan V2 requires a paid plan.

interface BackendChainEnv {
  rpcUrl: string
  explorerApiUrl: string
  explorerApiKey: string
  explorerApiProvider: ExplorerApiProvider
}

const CHAIN_ENV: Record<number, BackendChainEnv> = {
  100: {
    rpcUrl: config.rpcUrl,
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    explorerApiKey: config.gnosisscanApiKey,
    explorerApiProvider: 'etherscan-v2',
  },
  8453: {
    rpcUrl: config.rpcUrlBase,
    explorerApiUrl: 'https://base.blockscout.com/api/v2',
    explorerApiKey: '',
    explorerApiProvider: 'blockscout-v2',
  },
  84532: {
    rpcUrl: config.rpcUrlBaseSepolia,
    explorerApiUrl: 'https://base-sepolia.blockscout.com/api/v2',
    explorerApiKey: '',
    explorerApiProvider: 'blockscout-v2',
  },
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
    rpcUrl: env.rpcUrl,
    explorerUrl: core.explorerUrl,
    explorerApiUrl: env.explorerApiUrl,
    explorerApiKey: env.explorerApiKey,
    explorerApiProvider: env.explorerApiProvider,
    safeTxServiceUrl: core.safeTxServiceUrl,
    contracts: core.contracts,
    passkey: core.passkey,
    tokens,
    tokenByAddress: buildTokenByAddress(tokens),
  }
}

// ── Registry ──────────────────────────────────────────────────────

const CHAINS: Record<number, ChainConfig> = Object.fromEntries(
  Object.values(CHAIN_REGISTRY).map((core) => [core.chainId, buildChainConfig(core)]),
)

export const SUPPORTED_CHAIN_IDS = Object.keys(CHAINS).map(Number)

export function getChain(chainId: number): ChainConfig {
  const chain = CHAINS[chainId]
  if (!chain) {
    // Same message shape as before the #986 move — callers surface it.
    getChainData(chainId)
    throw new Error(`Unsupported chain: ${chainId}`)
  }
  return chain
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
  return isRegisteredChain(chainId)
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
  return allow.length === 0 ? SUPPORTED_CHAIN_IDS : allow.filter(isSupportedChain)
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
